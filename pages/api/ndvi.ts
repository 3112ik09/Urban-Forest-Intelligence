import type { NextApiRequest, NextApiResponse } from 'next'
import {
  getGEEToken, fetchDWBands, fetchHotspots, fetchOpenGroundPatches, validatePatches,
  fetchSatelliteTileBase64,
  type HotspotZone, type OpenPatch, type ValidatedPatch, type SiteType, type DWBandValues,
} from '@/lib/earthengine'
import {
  reRankZonesWithGemma,
  runAgentCritic, runSpatialValidator, runAgentPlanner,
  type VerifiedZone, type GemmaImage, type PatchInput,
  type AgentCritique, type AgentPlan, type ValidationResult, type AgentSpecies,
} from '@/lib/gemma'
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
    `way["landuse"~"military|industrial|landfill|quarry|railway|port|harbour"](${minLat},${minLon},${maxLat},${maxLon});` +
    `relation["landuse"~"military|industrial|landfill|quarry|railway|port|harbour"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["man_made"~"pier|jetty|breakwater|quay|dock|wharf"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["waterway"="dock"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});` +
    `relation["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["leisure"="marina"](${minLat},${minLon},${maxLat},${maxLon});` +
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
  source: 'gee' | 'gee_no_patches'
  verified_zones: VerifiedZone[]
  satellite_image_used: boolean
  grid_cells?: Array<{ bbox: [number, number, number, number]; score: number; bare: number; built: number }>
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { districtName, bbox, districtPolygon, cityName, language } = req.body as {
    districtName: string
    bbox: [number, number, number, number]
    districtPolygon?: [number, number][]
    cityName?: string
    language?: string
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

  const cacheKey = `ndvi:v19:${resolvedCityName}:${districtName}`
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
  emitStep(writeChunk, 1)
  let token: string
  try {
    token = await getGEEToken()
  } catch (err) {
    console.warn('[ndvi] GEE auth failed:', err)
    writeChunk({ type: 'error', reason: 'Satellite service authentication failed. Check service account credentials and try again.' })
    res.end()
    return
  }

  emitStep(writeChunk, 2)

  // ── Phase 1 — Hotspot scan (coarse 4×4 grid) ─────────────────────────────
  let hotspots: HotspotZone[] = []
  let reserveCells: HotspotZone[] = []
  let districtBands: DWBandValues | null = null
  const [minLon, minLat, maxLon, maxLat] = bbox
  const bboxRing: number[][][] = [
    [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]],
  ]

  try {
    const [hotspotsResult, bands] = await Promise.all([
      fetchHotspots(bbox, token, config),
      fetchDWBands(bboxRing, token).catch(() => null),
    ])
    hotspots = hotspotsResult.hotspots
    reserveCells = hotspotsResult.reserve
    districtBands = bands
    console.log('[ndvi] P1 hotspots:', hotspots.length, 'reserve:', reserveCells.length)
  } catch (err) {
    console.warn('[ndvi] P1 failed:', err)
    writeChunk({ type: 'error', reason: 'Satellite band scan timed out. Google Earth Engine may be under load — try again in a moment.' })
    res.end()
    return
  }

  // ── Compute district-level stats (available after Phase 1) ───────────────
  const bands = districtBands ?? { trees: 0, grass: 0, bare: 0, built: 0, water: 0, shrub_and_scrub: 0 }
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
  emitStep(writeChunk, 3)
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
      patches = patches.filter(p => {
        // Accept if centroid is inside, OR if any polygon vertex is inside.
        // Centroid-only check misses patches that straddle the district boundary
        // (centroid just outside, but majority of the patch is within the district).
        if (pointInPolygon(p.centroid.lat, p.centroid.lon, containmentRing)) return true
        return p.polygon.coordinates[0].some(([lon, lat]) =>
          pointInPolygon(lat, lon, containmentRing)
        )
      })
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

    // If top-8 hotspot cells yielded fewer than 5 patches, search the reserve cells too
    if (patches.length < 5 && reserveCells.length > 0) {
      console.log(`[ndvi] P2 sparse result (${patches.length} patches) — expanding to reserve cells`)
      const reservePatches = await fetchOpenGroundPatches(bbox, token, config, reserveCells.map(h => h.bbox))
      const existingIds = new Set(patches.map(p => p.id))
      const newPatches = reservePatches.filter(p => {
        if (existingIds.has(p.id) || p.areaHa > 100) return false
        if (containmentRing && !pointInPolygon(p.centroid.lat, p.centroid.lon, containmentRing) &&
            !p.polygon.coordinates[0].some(([lon, lat]) => pointInPolygon(lat, lon, containmentRing))) return false
        if (restrictedPolygons.some(poly => pointInPolygon(p.centroid.lat, p.centroid.lon, poly))) return false
        return true
      })
      patches = [...patches, ...newPatches]
      console.log(`[ndvi] P2 reserve expansion: +${newPatches.length} patches → total ${patches.length}`)
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

  // Drop patches where the DW water band is significant — waterfront, piers, docks
  if (validated.length > 0) {
    const beforeW = validated.length
    validated = validated.filter(p => p.bands.water <= 0.20)
    if (validated.length < beforeW) {
      console.log(`[ndvi] P3 water-band filter: ${beforeW} → ${validated.length}`)
    }
  }

  // ── Phase 4 + 4b — Multi-agent planning loop ──────────────────────────────────
  const { zones: agentZones, satelliteImageUsed } = await buildZonesWithGemma(
    validated, districtName, resolvedCityName, config, writeChunk, language,
  )
  console.log('[ndvi] agent loop zones:', agentZones.length)

  // Safety clamp: ensure every zone lat/lon is inside the district polygon
  if (containmentRing) {
    const [minLon, minLat, maxLon, maxLat] = bbox
    const fallbackLat = (minLat + maxLat) / 2
    const fallbackLon = (minLon + maxLon) / 2
    agentZones.forEach(z => {
      if (!pointInPolygon(z.lat, z.lon, containmentRing)) {
        console.warn(`[ndvi] zone ${z.rank} outside district polygon — snapping to centroid`)
        z.lat = fallbackLat
        z.lon = fallbackLon
      }
    })
  }

  const finalZones = agentZones

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
    source:             patches.length > 0 ? 'gee' : 'gee_no_patches',
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
  emitStep(writeChunk, 7)
  writeChunk({ type: 'result', ...result })
  res.end()
}

// ── Progress streaming ────────────────────────────────────────────────────────

type ProgressCb = (chunk: object) => void

const STEP_LABELS: Record<number, string> = {
  1: 'Connecting to Earth Engine',
  2: 'Scanning land cover bands',
  3: 'Discovering planting candidates',
  4: 'Agent 1 — reviewing satellite imagery',
  5: 'Spatial validator — checking constraints',
  6: 'Agent 2 — creating planting plans',
  7: 'Writing AI policy brief',
}

// Seconds remaining when each step starts (sum of durations from that step onward)
const STEP_REMAINING: Record<number, number> = {
  1: 59, 2: 55, 3: 48, 4: 42, 5: 24, 6: 16, 7: 6,
}

function emitStep(onProgress: ProgressCb, step: number) {
  onProgress({ type: 'step_change', step, stepLabel: STEP_LABELS[step], estimatedSecondsRemaining: STEP_REMAINING[step] })
}

// ── MCDA scoring ──────────────────────────────────────────────────────────────

const SITE_TYPE_BONUS: Record<SiteType, number> = {
  park_or_green:        0.90,
  degraded_scrub:       0.70,
  scrubland:            0.65,
  vacant_land:          0.60,
  urban_forest:         0.50,
  roadside_corridor:    0.45,
  mixed_open:           0.40,
  dense_urban:          0.15,
  green_roof_candidate: 0.10,
  water_edge:           0.05,
  unknown:              0.05,
}

const SITE_TYPE_MAP: Record<SiteType, VerifiedZone['site_type']> = {
  park_or_green:        'park',
  degraded_scrub:       'open_ground',
  scrubland:            'open_ground',
  vacant_land:          'open_ground',
  urban_forest:         'open_ground',
  roadside_corridor:    'road_median',
  mixed_open:           'open_ground',
  dense_urban:          'unknown',
  green_roof_candidate: 'rooftop',
  water_edge:           'unknown',
  unknown:              'unknown',
}

const PLANTING_METHOD: Record<SiteType, string> = {
  park_or_green:        'canopy infill — plant between existing trees',
  degraded_scrub:       'ground planting — clear scrub, plant native species',
  scrubland:            'ground planting — enrich with native canopy trees',
  vacant_land:          'ground planting — high density urban forest',
  urban_forest:         'canopy infill — supplement existing sparse cover',
  roadside_corridor:    'street tree planting — median and verge planting',
  mixed_open:           'ground planting — assess on-site before planting',
  dense_urban:          'ground planting — site survey recommended',
  green_roof_candidate: 'green roof — intensive or extensive substrate system',
  water_edge:           'riparian planting — consult drainage authority',
  unknown:              'ground planting — site survey recommended',
}

function buildZonesMCDA(patches: ValidatedPatch[], config: CityConfig): VerifiedZone[] {
  if (patches.length === 0) return []

  const scored = patches.map(p => {
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
  source: 'gee' | 'gee_no_patches'
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

// ── computeMCDA — MCDA scoring returning normalised 0-100 score ───────────────

type ScoredPatch = ValidatedPatch & { mcdaScore: number }

function computeMCDA(patches: ValidatedPatch[], config: CityConfig): ScoredPatch[] {
  const BONUS: Record<string, number> = {
    park_or_green: 0.90, degraded_scrub: 0.70, scrubland: 0.65,
    vacant_land: 0.60, urban_forest: 0.50, roadside_corridor: 0.45,
    mixed_open: 0.40, dense_urban: 0.15, green_roof_candidate: 0.10,
    water_edge: 0.05, unknown: 0.05,
  }

  const scored = patches.map(p => {
    const canopyDeficit = Math.max(0, config.targetCanopyPct - (p.bands.trees + p.bands.shrub_and_scrub))
    const openness = Math.max(0, 1 - p.bands.built)
    const areaScore = Math.min(1, Math.log10(Math.max(p.areaHa, 0.3)) / Math.log10(50))
    const typeBonus = BONUS[p.siteType] ?? 0.10
    const raw = canopyDeficit * 0.35 + openness * 0.30 + areaScore * 0.20 + typeBonus * 0.15
    return { ...p, mcdaScore: Math.round(raw * 100) }
  })

  const max = Math.max(...scored.map(s => s.mcdaScore), 1)
  return scored.map(s => ({ ...s, mcdaScore: Math.round((s.mcdaScore / max) * 100) }))
}

// ── convertPlansToZones — Agent 2 plans → VerifiedZone[] ─────────────────────

function convertPlansToZones(
  plans: AgentPlan[],
  approvedPatches: PatchInput[],
  allPatches: ScoredPatch[],
): VerifiedZone[] {
  const patchMap = new Map(allPatches.map(p => [p.id, p]))

  const mapped: (VerifiedZone & Record<string, unknown>)[] = []
  for (const [i, plan] of plans.filter(p => p.plantable).slice(0, 5).entries()) {
    const patch = patchMap.get(plan.site_id)
    if (!patch) continue
    const plantableHa = parseFloat(Math.min(patch.areaHa * 0.70, 40).toFixed(1))
    mapped.push({
      rank: plan.final_rank ?? i + 1,
      site_type: SITE_TYPE_MAP[patch.siteType as SiteType] ?? 'open_ground',
      plantable: true,
      estimated_trees: plan.estimated_trees,
      cooling_impact: `-${plan.temp_reduction_c.toFixed(1)}°C`,
      gemma_reasoning: plan.reasoning,
      planting_method: plan.planting_method,
      lat: patch.centroid.lat,
      lon: patch.centroid.lon,
      place_name: patch.placeName,
      _species: plan.species,
      _carbon_10yr: plan.carbon_10yr_tons,
      _people_impacted: plan.people_impacted,
      _cost_inr: plan.cost_estimate_inr,
      _plantable_ha: plantableHa,
      _mcda_score: patch.mcdaScore,
      _agent1_issues: [] as string[],
      _osm_verified: false,
    })
  }
  return mapped
}

// ── buildZonesWithGemma — fully parallel per-site Agent 1 + Agent 2 ───────────
// Each site gets its own Agent 1 call and its own Agent 2 call, all fired
// simultaneously. This is faster than the old batch-of-3 approach because:
//   - 1-image Gemma calls complete faster than 3-image calls
//   - All N calls run in parallel rather than N/3 sequential pipelines
// Expected latency: max(any one Agent1 call) + max(any one Agent2 call) ≈ 8s
// vs old approach: max(batch_pipeline) ≈ 12s

async function buildZonesWithGemma(
  patches: ValidatedPatch[],
  districtName: string,
  cityName: string,
  config: CityConfig,
  onProgress?: ProgressCb,
  language?: string,
): Promise<{ zones: VerifiedZone[]; satelliteImageUsed: boolean }> {
  if (patches.length === 0) return { zones: [], satelliteImageUsed: false }

  const mcda = computeMCDA(patches, config)

  const topCandidates = [...mcda]
    .sort((a, b) => b.mcdaScore - a.mcdaScore)
    .slice(0, 10)
    .filter(p => p.bands.built <= 0.45 && p.areaHa >= 0.5 && p.bands.water <= 0.15)
    .slice(0, 7)

  console.log(`[ndvi] Agent loop: ${topCandidates.length} candidates after pre-filter (from ${mcda.length} MCDA)`)

  // Fetch all tiles in parallel
  const tileResults = await Promise.allSettled(
    topCandidates.map(p => fetchSatelliteTileBase64(p.centroid.lat, p.centroid.lon, 16))
  )
  const tileMap = new Map<string, GemmaImage>()
  for (const [i, r] of tileResults.entries()) {
    if (r.status === 'fulfilled' && r.value) {
      tileMap.set(topCandidates[i].id, { base64: r.value, mimeType: 'image/jpeg' as const })
    }
  }

  const patchInputs: PatchInput[] = topCandidates.map(p => ({
    id: p.id, areaHa: p.areaHa, centroid: p.centroid, placeName: p.placeName,
    bands: p.bands, canopyPct: p.canopyPct, siteType: p.siteType, mcdaScore: p.mcdaScore,
    ring: p.polygon?.coordinates?.[0] as [number, number][] | undefined,
  }))

  // ── Agent 1 — one call per site, all in parallel ───────────────────────────
  const fallbackCritique = (p: PatchInput): AgentCritique => ({
    site_id: p.id, verdict: 'approve', mcda_score: p.mcdaScore ?? 50,
    visual_confidence: 0.5, adjusted_score: p.mcdaScore ?? 50,
    issues: [], positive_signals: [], reasoning: 'Agent 1 unavailable',
  })

  const agent1Total = patchInputs.length
  let agent1Done = 0

  if (onProgress) emitStep(onProgress, 4)

  const agent1Results = await Promise.allSettled(
    patchInputs.map(async p => {
      const img = tileMap.get(p.id)
      try {
        const critiques = await runAgentCritic([p], img ? [img] : [], districtName, cityName)
        const result = critiques[0] ?? fallbackCritique(p)
        agent1Done++
        onProgress?.({ type: 'image_progress', current: agent1Done, total: agent1Total, step: 4, stepLabel: STEP_LABELS[4] })
        return result
      } catch {
        agent1Done++
        onProgress?.({ type: 'image_progress', current: agent1Done, total: agent1Total, step: 4, stepLabel: STEP_LABELS[4] })
        return fallbackCritique(p)
      }
    })
  )

  const allCritiques: AgentCritique[] = agent1Results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : fallbackCritique(patchInputs[i])
  )

  const nA = allCritiques.filter(c => c.verdict === 'approve').length
  const nR = allCritiques.filter(c => c.verdict === 'reject').length
  console.log(`[ndvi] Agent 1 (${patchInputs.length} parallel calls): ${nA} approved, ${nR} rejected`)

  // ── Spatial Validator ──────────────────────────────────────────────────────
  if (onProgress) emitStep(onProgress, 5)
  const validations = runSpatialValidator(patchInputs, allCritiques)
  const approvedIds  = new Set(validations.filter(v => v.passed).map(v => v.site_id))
  const approved     = patchInputs.filter(p => approvedIds.has(p.id))
  console.log(`[ndvi] Validator: ${approved.length} of ${patchInputs.length} passed`)

  if (approved.length === 0) {
    console.warn('[ndvi] No sites passed validator — falling back to MCDA')
    return { zones: buildZonesMCDA(patches, config), satelliteImageUsed: false }
  }

  // ── Agent 2 — one call per approved site, all in parallel ─────────────────
  if (onProgress) emitStep(onProgress, 6)
  const fallbackPlan = (p: PatchInput, i: number): AgentPlan => {
    const plantableHa = Math.min(p.areaHa * 0.70, 40)
    const trees = Math.min(25000, Math.round(plantableHa * 650))
    return {
      site_id: p.id, final_rank: i + 1, plantable: true,
      species: [{ name: 'Native species', local_name: 'Native species', why: 'suitable for local climate', type: 'native' as AgentSpecies['type'], growth_rate: 'medium' as AgentSpecies['growth_rate'], canopy: 'medium' as AgentSpecies['canopy'] }],
      planting_method: 'ground planting',
      estimated_trees: trees,
      temp_reduction_c: parseFloat(Math.min(2.5, plantableHa * 0.12).toFixed(1)),
      carbon_10yr_tons: parseFloat((trees * 0.025).toFixed(1)),
      people_impacted: Math.round(plantableHa * 150),
      cost_estimate_inr: trees * 450,
      reasoning: 'Agent 2 unavailable — formula estimate',
    }
  }

  const agent2Results = await Promise.allSettled(
    approved.map(async (p, i) => {
      const img = tileMap.get(p.id)
      try {
        const plans = await runAgentPlanner(
          [p], allCritiques, validations, img ? [img] : [], districtName, cityName, language,
        )
        return plans[0] ?? fallbackPlan(p, i)
      } catch {
        return fallbackPlan(p, i)
      }
    })
  )

  const allPlans: AgentPlan[] = agent2Results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : fallbackPlan(approved[i], i)
  )
  console.log(`[ndvi] Agent 2 (${approved.length} parallel calls): ${allPlans.filter(p => p.plantable).length} plans`)

  // Re-rank globally by MCDA score
  const patchScoreMap = new Map(topCandidates.map(p => [p.id, p]))
  const rankedPlans = allPlans
    .filter(p => p.plantable)
    .sort((a, b) => (patchScoreMap.get(b.site_id)?.mcdaScore ?? 0) - (patchScoreMap.get(a.site_id)?.mcdaScore ?? 0))
    .map((p, i) => ({ ...p, final_rank: i + 1 }))

  const zones = convertPlansToZones(rankedPlans, patchInputs, topCandidates)

  if (zones.length === 0) {
    console.warn('[ndvi] All Agent 2 plans empty — falling back to MCDA')
    return { zones: buildZonesMCDA(patches, config), satelliteImageUsed: false }
  }

  return { zones, satelliteImageUsed: tileMap.size > 0 }
}
