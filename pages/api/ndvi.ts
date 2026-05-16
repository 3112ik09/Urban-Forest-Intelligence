import type { NextApiRequest, NextApiResponse } from 'next'
import {
  getGEEToken, fetchDWBands, fetchHotspots, fetchOpenGroundPatches, validatePatches,
  fetchSatelliteTileBase64,
  type HotspotZone, type OpenPatch, type ValidatedPatch, type SiteType, type DWBandValues,
} from '@/lib/earthengine'
import { reRankZonesWithGemma, type VerifiedZone, type GemmaImage } from '@/lib/gemma'
import { getCityConfig } from '@/lib/cityRegistry'
import type { CityConfig } from '@/lib/cityRegistry'

// ── District polygon containment ─────────────────────────────────────────────

// Ray-casting point-in-polygon; ring is [lon, lat] pairs (GeoJSON order)
function pointInPolygon(lat: number, lon: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// Stitches outer-role way segments from a relation into a single ring.
// Falls back to concatenation if segments don't connect cleanly.
function stitchRelationRing(
  segs: [number, number][][],
): [number, number][] {
  if (segs.length === 0) return []
  const result: [number, number][] = [...segs[0]]
  const remaining = segs.slice(1)
  while (remaining.length > 0) {
    const tail = result[result.length - 1]
    let matched = false
    for (let i = 0; i < remaining.length; i++) {
      const seg = remaining[i]
      const head = seg[0], last = seg[seg.length - 1]
      if (Math.abs(tail[0] - head[0]) < 1e-5 && Math.abs(tail[1] - head[1]) < 1e-5) {
        result.push(...seg.slice(1)); remaining.splice(i, 1); matched = true; break
      }
      if (Math.abs(tail[0] - last[0]) < 1e-5 && Math.abs(tail[1] - last[1]) < 1e-5) {
        result.push(...[...seg].reverse().slice(1)); remaining.splice(i, 1); matched = true; break
      }
    }
    if (!matched) { for (const seg of remaining) result.push(...seg); break }
  }
  return result
}

// Fetches restricted infrastructure polygons (airports, runways, taxiways, aprons)
// from Overpass. Returns rings in [lon, lat] order for use with pointInPolygon.
// Handles both way elements (flat geometry) and relation elements (stitched from members).
async function fetchRestrictedPolygons(bbox: [number, number, number, number]): Promise<[number, number][][]> {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const query = `[out:json][timeout:20];(` +
    `way["aeroway"~"aerodrome|runway|taxiway|apron"](${minLat},${minLon},${maxLat},${maxLon});` +
    `relation["aeroway"="aerodrome"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["landuse"~"military|industrial|landfill|quarry|railway"](${minLat},${minLon},${maxLat},${maxLon});` +
    `relation["landuse"~"military|industrial|landfill|quarry|railway"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["railway"~"rail|light_rail|subway|tram"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["amenity"="prison"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["power"~"plant|substation"](${minLat},${minLon},${maxLat},${maxLon});` +
    `);out geom;`
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(22000),
    })
    if (!res.ok) return []
    const data = await res.json()

    type OverpassNode = { lat: number; lon: number }
    type OverpassMember = { type: string; role: string; geometry?: OverpassNode[] }
    type OverpassEl = { type: string; geometry?: OverpassNode[]; members?: OverpassMember[] }

    const polygons: [number, number][][] = []
    for (const el of (data.elements ?? []) as OverpassEl[]) {
      if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3) {
        polygons.push(el.geometry.map(n => [n.lon, n.lat] as [number, number]))
      } else if (el.type === 'relation' && Array.isArray(el.members)) {
        // Build outer boundary polygon by stitching outer-role member ways
        const outerSegs: [number, number][][] = el.members
          .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === '') && Array.isArray(m.geometry) && m.geometry!.length >= 2)
          .map(m => m.geometry!.map(p => [p.lon, p.lat] as [number, number]))
        const ring = stitchRelationRing(outerSegs)
        if (ring.length >= 3) polygons.push(ring)
      }
    }
    return polygons
  } catch (err) {
    console.warn('[ndvi] fetchRestrictedPolygons failed (non-fatal):', err)
    return []
  }
}

// Survives across requests within the same serverless instance
const serverCache = new Map<string, NDVIResult>()

export interface NDVIResult {
  district: string
  ndvi_pct: number
  green_cover_pct: number
  estimated_temp_c: number
  built_up_pct: number
  barren_ha: number
  available_rooftops: number
  road_km: number
  wall_count: number
  parking_lots: number
  plantation_score: number
  source: 'gee' | 'fallback'
  verified_zones: VerifiedZone[]
  satellite_image_used: boolean
  grid_cells?: Array<{ bbox: [number, number, number, number]; score: number; bare: number; built: number }>
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { districtName, bbox, districtPolygon, cityName } = req.body as {
    districtName: string
    bbox: [number, number, number, number]
    districtPolygon?: [number, number][]
    cityName?: string
  }
  if (!districtName || !bbox) return res.status(400).json({ error: 'districtName and bbox required' })

  // Stream NDJSON — emit stats after Phase 1, full result after Phase 4b
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const writeChunk = (obj: object) => res.write(JSON.stringify(obj) + '\n')

  const resolvedCityName = cityName ?? districtName
  const config = getCityConfig(resolvedCityName)

  const cacheKey = `ndvi:v13:${resolvedCityName}:${districtName}`
  const cached = serverCache.get(cacheKey)
  if (cached) {
    console.log('[ndvi] cache hit:', cacheKey)
    writeChunk({ type: 'result', ...cached })
    res.end()
    return
  }

  console.log('[ndvi] pipeline start:', districtName, 'city:', resolvedCityName)

  const containmentRing: [number, number][] | null = districtPolygon && districtPolygon.length >= 4
    ? districtPolygon
    : null

  // ── Auth ──────────────────────────────────────────────────────────────────
  let token: string
  try {
    token = await getGEEToken()
  } catch (err) {
    console.warn('[ndvi] GEE auth failed — returning fallback:', err)
    writeChunk({ type: 'result', ...buildFallbackResult(districtName, bbox, containmentRing) })
    res.end()
    return
  }

  // ── Phase 1 — Hotspot scan (coarse 4×4 grid) ─────────────────────────────
  let hotspots: HotspotZone[] = []
  let districtBands: DWBandValues | null = null
  const [minLon, minLat, maxLon, maxLat] = bbox
  const bboxRing: number[][][] = [
    [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]],
  ]

  try {
    ;[hotspots, districtBands] = await Promise.all([
      fetchHotspots(bbox, token, config),
      fetchDWBands(bboxRing, token).catch(() => null),
    ])
    console.log('[ndvi] P1 hotspots:', hotspots.length)
  } catch (err) {
    console.warn('[ndvi] P1 failed:', err)
    writeChunk({ type: 'result', ...buildFallbackResult(districtName, bbox) })
    res.end()
    return
  }

  // ── Compute district-level stats (available after Phase 1) ───────────────
  const bands = districtBands ?? GENERIC_URBAN_BANDS
  const canopyPct       = Math.round((bands.trees + bands.shrub_and_scrub) * 100)
  const builtPct        = Math.round(bands.built * 100)
  const greenCoverPct   = Math.min(100, canopyPct + Math.round(bands.grass * 100))
  const estimatedTempC  = Math.round(28 + bands.built * 12 - bands.trees * 8)
  const plantationScore = Math.round(Math.max(0, Math.min(100,
    (bands.bare * 0.65 + (1 - (bands.trees + bands.grass + bands.shrub_and_scrub)) * 0.2 - bands.built * 0.15) * 100
  )))
  const avgLat     = (minLat + maxLat) / 2
  const districtW  = (maxLon - minLon) * 111320 * Math.cos(avgLat * Math.PI / 180)
  const districtH  = (maxLat - minLat) * 110570
  const districtHa = (districtW * districtH) / 10_000
  const barrenHa   = Math.round(districtHa * bands.bare)

  // Emit stats — client shows land cover tiles while zones are discovered
  writeChunk({
    type: 'stats',
    district:           districtName,
    ndvi_pct:           canopyPct,
    green_cover_pct:    greenCoverPct,
    estimated_temp_c:   estimatedTempC,
    built_up_pct:       builtPct,
    barren_ha:          barrenHa,
    available_rooftops: Math.round(builtPct * 8.5),
    road_km:            Math.round((bbox[2] - bbox[0]) * 111 * 4),
    wall_count:         Math.round(builtPct * 3.1),
    parking_lots:       Math.round(builtPct * 0.4),
    plantation_score:   plantationScore,
    source:             'gee' as const,
    verified_zones:     [],
    satellite_image_used: false,
  })

  // ── Phase 2 — Open ground patch discovery ────────────────────────────────
  let patches: OpenPatch[] = []

  try {
    patches = await fetchOpenGroundPatches(bbox, token, config, hotspots.map(h => h.bbox))
    console.log('[ndvi] P2 raw patches found:', patches.length)

    if (containmentRing) {
      const before = patches.length
      patches = patches.filter(p => pointInPolygon(p.centroid.lat, p.centroid.lon, containmentRing))
      console.log(`[ndvi] P2 polygon pre-filter: ${before} → ${patches.length}`)
    }

    // Drop blobs > 100ha — merged urban fabric, not actionable planting sites
    const beforeCap = patches.length
    patches = patches.filter(p => p.areaHa <= 100)
    if (patches.length < beforeCap) {
      console.log(`[ndvi] P2 size cap (100ha): ${beforeCap} → ${patches.length}`)
    }

    // Filter out patches inside airports, runways, taxiways, aprons, military zones
    const restrictedPolygons = await fetchRestrictedPolygons(bbox)
    if (restrictedPolygons.length > 0) {
      const beforeRestricted = patches.length
      patches = patches.filter(p =>
        !restrictedPolygons.some(poly => pointInPolygon(p.centroid.lat, p.centroid.lon, poly))
      )
      console.log(`[ndvi] P2 restricted zone filter (${restrictedPolygons.length} polygons): ${beforeRestricted} → ${patches.length}`)
    }
  } catch (err) {
    console.warn('[ndvi] P2 failed:', err)
  }

  // ── Phase 3 — Validate patches + name them ───────────────────────────────
  let validated: ValidatedPatch[] = []
  if (patches.length > 0) {
    try {
      validated = await validatePatches(patches, token, config)
      console.log('[ndvi] P3 validated patches:', validated.length)
    } catch (err) {
      console.warn('[ndvi] P3 failed:', err)
    }
  }

  // ── Phase 4 — MCDA scoring + ranking ─────────────────────────────────────
  const zones = buildZones(validated, config)
  console.log('[ndvi] final zones:', zones.length)

  // Safety clamp: ensure every zone lat/lon is inside the district polygon.
  // GEE patches are pre-filtered by containmentRing, but this guards against
  // edge cases (e.g. patch centroid on polygon border, floating-point rounding).
  if (containmentRing) {
    const [minLon, minLat, maxLon, maxLat] = bbox
    const fallbackLat = (minLat + maxLat) / 2
    const fallbackLon = (minLon + maxLon) / 2
    zones.forEach(z => {
      if (!pointInPolygon(z.lat, z.lon, containmentRing)) {
        console.warn(`[ndvi] zone ${z.rank} outside district polygon — snapping to centroid`)
        z.lat = fallbackLat
        z.lon = fallbackLon
      }
    })
  }

  // ── Phase 4b — Gemma visual re-ranking ────────────────────────────────────
  let reRankedZones = zones
  let satelliteImageUsed = false
  if (zones.length >= 2) {
    const tileResults = await Promise.allSettled(
      zones.map(z => fetchSatelliteTileBase64(z.lat, z.lon, 16))
    )
    const toRank: VerifiedZone[] = []
    const rankImages: GemmaImage[] = []
    const noTile: VerifiedZone[] = []
    zones.forEach((z, i) => {
      const r = tileResults[i]
      if (r.status === 'fulfilled' && r.value) {
        toRank.push(z)
        rankImages.push({ base64: r.value, mimeType: 'image/jpeg' })
      } else {
        noTile.push(z)
      }
    })
    if (toRank.length >= 2) {
      let reRanked = await reRankZonesWithGemma(toRank, rankImages, resolvedCityName)
      // Safety net: drop any zone Gemma's reasoning flagged as water even if not marked UNSUITABLE
      const WATER_RE = /\b(entirely water|mostly water|all water|open water|sea|ocean|bay|lake|pond|waterway|river)\b/i
      const beforeWaterFilter = reRanked.length
      reRanked = reRanked.filter(z => !WATER_RE.test(z.gemma_reasoning))
      if (reRanked.length < beforeWaterFilter) {
        console.log(`[ndvi] water post-filter: dropped ${beforeWaterFilter - reRanked.length} zone(s)`)
      }
      reRankedZones = [...reRanked, ...noTile].map((z, i) => ({ ...z, rank: i + 1 }))
      satelliteImageUsed = reRanked !== toRank
      console.log('[ndvi] P4b tiles fetched:', rankImages.length, 'satellite_image_used:', satelliteImageUsed)
    }
  }

  const finalZones = reRankedZones.length > 0
    ? reRankedZones
    : buildFallbackZones(districtName, barrenHa, bbox, containmentRing)

  const result: NDVIResult = {
    district:           districtName,
    ndvi_pct:           canopyPct,
    green_cover_pct:    greenCoverPct,
    estimated_temp_c:   estimatedTempC,
    built_up_pct:       builtPct,
    barren_ha:          barrenHa,
    available_rooftops: Math.round(builtPct * 8.5),
    road_km:            Math.round((bbox[2] - bbox[0]) * 111 * 4),
    wall_count:         Math.round(builtPct * 3.1),
    parking_lots:       Math.round(builtPct * 0.4),
    plantation_score:   plantationScore,
    source:             patches.length > 0 ? 'gee' : 'fallback',
    satellite_image_used: satelliteImageUsed,
    verified_zones:     finalZones,
    grid_cells: validated.map(v => ({
      bbox: v.polygon.coordinates[0].reduce(
        (b: [number, number, number, number], p: unknown) => {
          const pt = p as [number, number]
          return [Math.min(b[0], pt[0]), Math.min(b[1], pt[1]), Math.max(b[2], pt[0]), Math.max(b[3], pt[1])]
        },
        [180, 90, -180, -90] as [number, number, number, number]
      ),
      score: 0,
      bare:  parseFloat(v.bands.bare.toFixed(3)),
      built: parseFloat(v.bands.built.toFixed(3)),
    })),
  }

  serverCache.set(cacheKey, result)
  writeChunk({ type: 'result', ...result })
  res.end()
}

// ── MCDA scoring ──────────────────────────────────────────────────────────────

const SITE_TYPE_BONUS: Record<SiteType, number> = {
  park_or_green:  0.90,
  degraded_scrub: 0.70,
  scrubland:      0.65,
  vacant_land:    0.60,
  low_canopy:     0.50,
  mixed_open:     0.40,
  unknown:        0.20,
}

const SITE_TYPE_MAP: Record<SiteType, VerifiedZone['site_type']> = {
  park_or_green:  'park',
  degraded_scrub: 'open_ground',
  scrubland:      'open_ground',
  vacant_land:    'open_ground',
  low_canopy:     'open_ground',
  mixed_open:     'open_ground',
  unknown:        'unknown',
}

const PLANTING_METHOD: Record<SiteType, string> = {
  park_or_green:  'canopy infill — plant between existing trees',
  degraded_scrub: 'ground planting — clear scrub, plant native species',
  scrubland:      'ground planting — enrich with native canopy trees',
  vacant_land:    'ground planting — high density urban forest',
  low_canopy:     'canopy infill — supplement existing sparse cover',
  mixed_open:     'ground planting — assess on-site before planting',
  unknown:        'ground planting — site survey recommended',
}

function buildZones(patches: ValidatedPatch[], config: CityConfig): VerifiedZone[] {
  if (patches.length === 0) return []

  const scored = patches.filter(p => p.siteType !== 'unknown').map(p => {
    const canopyDeficit = Math.max(0, config.targetCanopyPct - (p.bands.trees + p.bands.shrub_and_scrub))
    const openness      = Math.max(0, 1 - p.bands.built)
    const areaScore     = Math.min(1, Math.log10(Math.max(p.areaHa, 0.3)) / Math.log10(50))
    const typeBonus     = SITE_TYPE_BONUS[p.siteType]

    const raw =
      canopyDeficit * 0.35 +
      openness      * 0.30 +
      areaScore     * 0.20 +
      typeBonus     * 0.15

    return { ...p, raw }
  })

  const raws = scored.map(s => s.raw)
  const minR = Math.min(...raws)
  const maxR = Math.max(...raws)
  const range = maxR - minR > 0.01 ? maxR - minR : 1

  return scored
    .map(p => ({ ...p, normScore: Math.round(((p.raw - minR) / range) * 100) }))
    .sort((a, b) => b.normScore - a.normScore)
    .slice(0, 5)
    .map((p, i) => {
      const plantableHa = parseFloat(Math.min(p.areaHa * 0.70, 40).toFixed(1))
      return {
        rank:            i + 1,
        site_type:       SITE_TYPE_MAP[p.siteType],
        plantable:       true,
        estimated_trees: Math.min(25_000, Math.round(plantableHa * 650)),
        cooling_impact:  `-${Math.min(2.0, plantableHa * 0.12).toFixed(1)}°C`,
        gemma_reasoning: `${p.siteType.replace(/_/g, ' ')} · ${p.areaHa.toFixed(1)}ha · canopy ${p.canopyPct}% · open ${Math.round((1 - p.bands.built) * 100)}%`,
        planting_method: PLANTING_METHOD[p.siteType],
        lat:             p.centroid.lat,
        lon:             p.centroid.lon,
        place_name:      p.placeName,
        _bare:           p.bands.bare,
        _built:          p.bands.built,
        _osm_verified:   false,
        _osm_unknown:    true,
        _plantable_ha:   plantableHa,
        _cell_bbox:      p.polygon.coordinates[0].reduce(
          (b: [number, number, number, number], pt: unknown) => {
            const c = pt as [number, number]
            return [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])]
          },
          [180, 90, -180, -90] as [number, number, number, number]
        ),
      } satisfies VerifiedZone & Record<string, unknown>
    })
}

// ── Generic urban fallback ────────────────────────────────────────────────────

const GENERIC_URBAN_BANDS: DWBandValues = {
  trees: 0.10, grass: 0.05, bare: 0.08, built: 0.70, water: 0.02, shrub_and_scrub: 0.02,
}

function buildFallbackResult(districtName: string, bbox: [number, number, number, number], ring?: [number, number][] | null): NDVIResult {
  const bands = GENERIC_URBAN_BANDS
  const [minLon, minLat, maxLon, maxLat] = bbox
  const builtPct = Math.round(bands.built * 100)
  const canopyPct = Math.round((bands.trees + bands.shrub_and_scrub) * 100)
  const greenCoverPct = Math.min(100, canopyPct + Math.round(bands.grass * 100))
  const estimatedTempC = Math.round(28 + bands.built * 12 - bands.trees * 8)
  const plantationScore = Math.round(Math.max(0, Math.min(100,
    (bands.bare * 0.65 + (1 - (bands.trees + bands.grass + bands.shrub_and_scrub)) * 0.2 - bands.built * 0.15) * 100
  )))
  const avgLat = (minLat + maxLat) / 2
  const districtHa = (maxLon - minLon) * 111320 * Math.cos(avgLat * Math.PI / 180) * (maxLat - minLat) * 110570 / 10_000
  const barrenHa = Math.round(districtHa * bands.bare)

  return {
    district:           districtName,
    ndvi_pct:           canopyPct,
    green_cover_pct:    greenCoverPct,
    estimated_temp_c:   estimatedTempC,
    built_up_pct:       builtPct,
    barren_ha:          barrenHa,
    available_rooftops: Math.round(builtPct * 8.5),
    road_km:            Math.round((bbox[2] - bbox[0]) * 111 * 4),
    wall_count:         Math.round(builtPct * 3.1),
    parking_lots:       Math.round(builtPct * 0.4),
    plantation_score:   plantationScore,
    source:             'fallback',
    satellite_image_used: false,
    verified_zones:     buildFallbackZones(districtName, barrenHa, bbox, ring),
  }
}

function buildFallbackZones(
  district: string,
  barrenHa: number,
  bbox: [number, number, number, number],
  ring?: [number, number][] | null,
): VerifiedZone[] {
  const [minLon, minLat, maxLon, maxLat] = bbox
  let cx = (minLon + maxLon) / 2
  let cy = (minLat + maxLat) / 2

  // Prefer polygon centroid over bbox centroid — bbox centroid can fall in water
  // or outside a concave district boundary (e.g. Himalayan tehsils, coastal boroughs).
  if (ring && ring.length >= 4) {
    const n = ring.length
    const rLon = ring.reduce((s, p) => s + p[0], 0) / n
    const rLat = ring.reduce((s, p) => s + p[1], 0) / n
    if (pointInPolygon(rLat, rLon, ring)) { cy = rLat; cx = rLon }
  }

  // All fallback zones share the same safe interior point — positions are
  // estimated (no GEE data); fly-to is disabled for fallback results.
  const zones: VerifiedZone[] = [
    {
      rank: 1, site_type: 'open_ground', plantable: true,
      estimated_trees: Math.min(80_000, Math.round(barrenHa * 0.4 * 650)),
      cooling_impact: `-${Math.min(2.5, barrenHa * 0.4 * 0.25).toFixed(1)}°C`,
      gemma_reasoning: `Open municipal ground in ${district} — GEE unavailable, estimated zone`,
      planting_method: 'ground planting',
      lat: cy, lon: cx,
    },
    {
      rank: 2, site_type: 'road_median', plantable: true,
      estimated_trees: Math.min(25_000, Math.round(barrenHa * 0.3 * 200)),
      cooling_impact: `-${Math.min(1.5, barrenHa * 0.3 * 0.25).toFixed(1)}°C`,
      gemma_reasoning: 'Major road medians — avenue planting suitable',
      planting_method: 'roadside pits',
      lat: cy, lon: cx,
    },
    {
      rank: 3, site_type: 'park', plantable: true,
      estimated_trees: Math.min(50_000, Math.round(barrenHa * 0.2 * 400)),
      cooling_impact: `-${Math.min(2.0, barrenHa * 0.2 * 0.25).toFixed(1)}°C`,
      gemma_reasoning: 'Underutilised park or institutional ground',
      planting_method: 'ground planting',
      lat: cy, lon: cx,
    },
    {
      rank: 4, site_type: 'parking_lot', plantable: true,
      estimated_trees: Math.min(8_000, Math.round(barrenHa * 0.1 * 80)),
      cooling_impact: `-${Math.min(0.8, barrenHa * 0.1 * 0.25).toFixed(1)}°C`,
      gemma_reasoning: 'Parking lot perimeter — shade trees reduce surface heat',
      planting_method: 'perimeter planting',
      lat: cy, lon: cx,
    },
  ]
  return zones.filter(z => z.estimated_trees > 0)
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function ringAreaHa(ring: number[][]): number {
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  area = Math.abs(area) / 2
  const avgLat = ring.reduce((s, c) => s + c[1], 0) / ring.length
  return area * 111.32 * Math.cos(avgLat * Math.PI / 180) * 110.57 * 100
}

function deriveMetrics(
  district: string,
  bands: DWBandValues,
  polygonCoords: number[][][],
  bbox: [number, number, number, number],
  source: 'gee' | 'fallback'
): NDVIResult {
  const { trees, grass, bare, built, shrub_and_scrub } = bands
  const greenFrac        = Math.min(1, trees + grass + shrub_and_scrub)
  const ndvi_pct         = Math.round(greenFrac * 100)
  const built_up_pct     = Math.round(Math.min(100, built * 100))
  const barren_pct       = Math.round(Math.min(100, bare  * 100))
  const green_cover_pct  = Math.round(ndvi_pct * 0.85)
  const estimated_temp_c = Math.round(28 + built_up_pct * 0.12 - green_cover_pct * 0.05)

  const totalAreaHa = polygonCoords.length > 0
    ? ringAreaHa(polygonCoords[0])
    : (() => {
        const [minLon, minLat, maxLon, maxLat] = bbox
        const avgLat = (minLat + maxLat) / 2
        return (maxLon - minLon) * 111.32 * Math.cos(avgLat * Math.PI / 180) * (maxLat - minLat) * 110.57 * 100
      })()
  const barren_ha = Math.round(totalAreaHa * (barren_pct / 100))

  const plantation_score = Math.round(Math.max(0, Math.min(100,
    (bare * 0.65 + (1 - greenFrac) * 0.2 - built * 0.15) * 100
  )))

  return {
    district,
    ndvi_pct,
    green_cover_pct,
    estimated_temp_c,
    built_up_pct,
    barren_ha,
    available_rooftops: Math.round(built_up_pct * 6),
    road_km:            Math.round(built_up_pct * 0.18),
    wall_count:         Math.round(built_up_pct * 2.1),
    parking_lots:       Math.round(built_up_pct * 0.25),
    plantation_score,
    source,
    verified_zones:       [],
    satellite_image_used: false,
  }
}

// Keep deriveMetrics in scope to avoid unused-variable warnings
void deriveMetrics
