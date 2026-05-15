import type { NextApiRequest, NextApiResponse } from 'next'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  getGEEToken, fetchDWBands, fetchHotspots, fetchOpenGroundPatches, validatePatches,
  type HotspotZone, type OpenPatch, type ValidatedPatch, type SiteType, type DWBandValues,
} from '@/lib/earthengine'
import type { VerifiedZone } from '@/lib/gemma'
import { getBbox } from '@/lib/districts'
import { getCityConfig } from '@/lib/cityconfig'
import type { CityConfig } from '@/lib/cityconfig'

// ── District polygon containment ─────────────────────────────────────────────

interface GeoFeature {
  properties: { district_name: string }
  geometry: { type: string; coordinates: unknown[] }
}

let _districtGeoJSON: { features: GeoFeature[] } | null = null
function getDistrictGeoJSON() {
  if (!_districtGeoJSON) {
    _districtGeoJSON = JSON.parse(
      readFileSync(join(process.cwd(), 'public/delhi-districts.geojson'), 'utf8')
    )
  }
  return _districtGeoJSON!
}

function getDistrictRing(districtName: string): [number, number][] | null {
  const feat = getDistrictGeoJSON().features.find(f => f.properties.district_name === districtName)
  if (!feat) return null
  const geom = feat.geometry
  if (geom.type === 'Polygon') return (geom.coordinates[0] as [number, number][])
  if (geom.type === 'MultiPolygon') return ((geom.coordinates as unknown[][][])[0][0] as [number, number][])
  return null
}

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

// Survives across requests within the same serverless instance — avoids redundant GEE calls
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

  const { districtName, bbox } = req.body as { districtName: string; bbox: [number, number, number, number] }
  if (!districtName || !bbox) return res.status(400).json({ error: 'districtName and bbox required' })

  const cityName = districtName.toLowerCase().includes('delhi') ? 'delhi' : districtName
  const config = getCityConfig(cityName)

  const cacheKey = `ndvi:v9:${districtName}`
  const cached = serverCache.get(cacheKey)
  if (cached) {
    console.log('[ndvi] cache hit:', districtName)
    return res.status(200).json(cached)
  }

  console.log('[ndvi] pipeline start:', districtName)

  // ── Auth ──────────────────────────────────────────────────────────────────
  let token: string
  try {
    token = await getGEEToken()
  } catch (err) {
    console.warn('[ndvi] GEE auth failed — returning fallback:', err)
    return res.status(200).json(buildFallbackResult(districtName, bbox))
  }

  // ── Phase 1 — Hotspot scan (coarse 4×4 grid) ─────────────────────────────
  let hotspots: HotspotZone[] = []
  let districtBands: DWBandValues | null = null
  const [minLon, minLat, maxLon, maxLat] = bbox
  const districtRing: number[][][] = [
    [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]],
  ]

  try {
    ;[hotspots, districtBands] = await Promise.all([
      fetchHotspots(bbox, token, config),
      fetchDWBands(districtRing, token).catch(() => null),
    ])
    console.log('[ndvi] P1 hotspots:', hotspots.length)
  } catch (err) {
    console.warn('[ndvi] P1 failed:', err)
    return res.status(200).json(buildFallbackResult(districtName, bbox))
  }

  // ── Phase 2 — Open ground patch discovery ────────────────────────────────
  // Always search the full district bbox so overlapping rectangles don't miss
  // patches inside the actual district. Pre-filter by the real polygon so we
  // don't waste the 20-patch validation budget on wrong-district blobs.
  let patches: OpenPatch[] = []
  const polygonRing = getDistrictRing(districtName)

  try {
    patches = await fetchOpenGroundPatches(bbox, token, config)
    console.log('[ndvi] P2 raw patches found:', patches.length)

    if (polygonRing) {
      const before = patches.length
      patches = patches.filter(p => pointInPolygon(p.centroid.lat, p.centroid.lon, polygonRing))
      console.log(`[ndvi] P2 polygon pre-filter: ${before} → ${patches.length}`)
    }

    // Drop blobs > 100ha — these are merged urban fabric, not actionable planting sites
    const beforeCap = patches.length
    patches = patches.filter(p => p.areaHa <= 100)
    if (patches.length < beforeCap) {
      console.log(`[ndvi] P2 size cap (100ha): ${beforeCap} → ${patches.length}`)
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

  // ── Derive district-level stats ───────────────────────────────────────────
  const bands = districtBands ?? DEFAULT_DW_BANDS
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

  const finalZones = zones.length > 0 ? zones : buildFallbackZones(districtName, barrenHa, bbox)

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
    satellite_image_used: false,
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
  return res.status(200).json(result)
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

// ── Fallback path (used when GEE is unreachable) ──────────────────────────────

const DISTRICT_DW_BANDS: Record<string, DWBandValues> = {
  'Central Delhi':    { trees: 0.04, grass: 0.02, bare: 0.07, built: 0.85, water: 0.01, shrub_and_scrub: 0.01 },
  'East Delhi':       { trees: 0.08, grass: 0.03, bare: 0.08, built: 0.78, water: 0.01, shrub_and_scrub: 0.02 },
  'New Delhi':        { trees: 0.30, grass: 0.15, bare: 0.05, built: 0.45, water: 0.02, shrub_and_scrub: 0.03 },
  'North Delhi':      { trees: 0.18, grass: 0.08, bare: 0.10, built: 0.58, water: 0.04, shrub_and_scrub: 0.02 },
  'North East Delhi': { trees: 0.06, grass: 0.02, bare: 0.08, built: 0.82, water: 0.01, shrub_and_scrub: 0.01 },
  'North West Delhi': { trees: 0.20, grass: 0.10, bare: 0.10, built: 0.55, water: 0.02, shrub_and_scrub: 0.03 },
  'Shahdara':         { trees: 0.07, grass: 0.03, bare: 0.09, built: 0.78, water: 0.02, shrub_and_scrub: 0.01 },
  'South Delhi':      { trees: 0.24, grass: 0.09, bare: 0.07, built: 0.55, water: 0.01, shrub_and_scrub: 0.04 },
  'South East Delhi': { trees: 0.12, grass: 0.05, bare: 0.08, built: 0.72, water: 0.01, shrub_and_scrub: 0.02 },
  'South West Delhi': { trees: 0.16, grass: 0.08, bare: 0.12, built: 0.58, water: 0.02, shrub_and_scrub: 0.04 },
  'West Delhi':       { trees: 0.15, grass: 0.06, bare: 0.09, built: 0.66, water: 0.01, shrub_and_scrub: 0.03 },
}

const DEFAULT_DW_BANDS: DWBandValues = { trees: 0.15, grass: 0.06, bare: 0.09, built: 0.66, water: 0.01, shrub_and_scrub: 0.03 }

function getFallbackData(districtName: string): NDVIResult {
  const bands = DISTRICT_DW_BANDS[districtName] ?? DEFAULT_DW_BANDS
  const districtBbox = getBbox(districtName) ?? [77.0, 28.4, 77.3, 28.9] as [number, number, number, number]
  return deriveMetrics(districtName, bands, [], districtBbox, 'fallback')
}

function buildFallbackResult(districtName: string, bbox: [number, number, number, number]): NDVIResult {
  const base = getFallbackData(districtName)
  const zones = buildFallbackZones(districtName, base.barren_ha, bbox)
  return { ...base, verified_zones: zones, satellite_image_used: false }
}

function buildFallbackZones(
  district: string,
  barrenHa: number,
  bbox: [number, number, number, number]
): VerifiedZone[] {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const cx = (minLon + maxLon) / 2
  const cy = (minLat + maxLat) / 2
  const dx = (maxLon - minLon) * 0.28
  const dy = (maxLat - minLat) * 0.28

  const zones: VerifiedZone[] = [
    {
      rank: 1, site_type: 'open_ground', plantable: true,
      estimated_trees: Math.min(80_000, Math.round(barrenHa * 0.4 * 650)),
      cooling_impact: `-${Math.min(2.5, barrenHa * 0.4 * 0.25).toFixed(1)}°C`,
      gemma_reasoning: `Open municipal ground in ${district} — GEE unavailable, estimated zone`,
      planting_method: 'ground planting',
      lat: cy + dy, lon: cx - dx,
    },
    {
      rank: 2, site_type: 'road_median', plantable: true,
      estimated_trees: Math.min(25_000, Math.round(barrenHa * 0.3 * 200)),
      cooling_impact: `-${Math.min(1.5, barrenHa * 0.3 * 0.25).toFixed(1)}°C`,
      gemma_reasoning: 'Major road medians — avenue planting suitable',
      planting_method: 'roadside pits',
      lat: cy + dy, lon: cx + dx,
    },
    {
      rank: 3, site_type: 'park', plantable: true,
      estimated_trees: Math.min(50_000, Math.round(barrenHa * 0.2 * 400)),
      cooling_impact: `-${Math.min(2.0, barrenHa * 0.2 * 0.25).toFixed(1)}°C`,
      gemma_reasoning: 'Underutilised park or institutional ground',
      planting_method: 'ground planting',
      lat: cy - dy, lon: cx - dx,
    },
    {
      rank: 4, site_type: 'parking_lot', plantable: true,
      estimated_trees: Math.min(8_000, Math.round(barrenHa * 0.1 * 80)),
      cooling_impact: `-${Math.min(0.8, barrenHa * 0.1 * 0.25).toFixed(1)}°C`,
      gemma_reasoning: 'Parking lot perimeter — shade trees reduce surface heat',
      planting_method: 'perimeter planting',
      lat: cy - dy, lon: cx + dx,
    },
  ]
  return zones.filter(z => z.estimated_trees > 0)
}
