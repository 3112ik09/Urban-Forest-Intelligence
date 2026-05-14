import type { NextApiRequest, NextApiResponse } from 'next'
import { getGEEToken, fetchSentinelBands, fetchSentinelGrid, type GridCell } from '@/lib/earthengine'
import { classifyZoneOSM, type OSMClassification } from '@/lib/overpass'
import type { VerifiedZone } from '@/lib/gemma'

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
  grid_cells?: Array<{ bbox: [number, number, number, number]; score: number; bsi: number }>
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { districtName, bbox, polygonCoords } = req.body as {
    districtName: string
    bbox: [number, number, number, number]
    polygonCoords: number[][][]
  }
  if (!districtName || !bbox) return res.status(400).json({ error: 'districtName and bbox required' })

  try {
    let baseResult: NDVIResult
    let verified_zones: VerifiedZone[] = []

    try {
      const token = await getGEEToken()
      const coords = polygonCoords?.length ? polygonCoords : bboxToRing(bbox)

      // District-level stats (single mean over full polygon)
      const bands = await fetchSentinelBands(coords, token)
      console.log('[ndvi] district bands:', bands)
      baseResult = deriveMetrics(districtName, bands, polygonCoords ?? [], bbox, 'gee')
      console.log('[ndvi] district metrics:', {
        ndvi_pct: baseResult.ndvi_pct, green_cover_pct: baseResult.green_cover_pct,
        built_up_pct: baseResult.built_up_pct, barren_ha: baseResult.barren_ha,
        plantation_score: baseResult.plantation_score,
      })

      // Grid scan — 4×4 cells, ranked by plantation suitability, filtered by OSM
      console.log('[ndvi] starting 4×4 grid scan for', districtName)
      const grid = await fetchSentinelGrid(bbox, token)
      console.log('[ndvi] grid cells returned:', grid.length, '/ 16')
      const { zones, scoredCells } = await identifyPlantingZones(grid)
      verified_zones = zones
      const grid_cells = scoredCells.map(c => ({
        bbox: c.cellBbox,
        score: Math.round(c.score),
        bsi: parseFloat(c.bsi.toFixed(3)),
      }))
      return res.status(200).json({ ...baseResult, verified_zones, grid_cells, satellite_image_used: false })
    } catch (err) {
      console.error('[ndvi] GEE failed, using fallback:', err)
      baseResult = getFallbackData(districtName)
      verified_zones = buildFallbackZones(districtName, baseResult.barren_ha, bbox)
    }

    return res.status(200).json({ ...baseResult, verified_zones, satellite_image_used: false })
  } catch (err) {
    console.error('[ndvi] handler error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

const safeDiv = (a: number, b: number) => b === 0 ? 0 : a / b

function bboxToRing(bbox: [number, number, number, number]): number[][][] {
  const [minLon, minLat, maxLon, maxLat] = bbox
  return [[[minLon, maxLat], [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat]]]
}

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
  bands: { B2: number; B4: number; B8: number; B11: number },
  polygonCoords: number[][][],
  bbox: [number, number, number, number],
  source: 'gee' | 'fallback'
): NDVIResult {
  const { B2, B4, B8, B11 } = bands

  const ndvi = safeDiv(B8 - B4, B8 + B4)
  const ndbi = safeDiv(B11 - B8, B11 + B8)
  const bsi  = safeDiv((B11 + B4) - (B8 + B2), (B11 + B4) + (B8 + B2))

  const ndvi_pct         = Math.round(Math.max(0, Math.min(100, ndvi * 100)))
  const built_up_pct     = Math.round(Math.max(0, Math.min(100, (ndbi + 1) * 50)))
  const barren_pct       = Math.round(Math.max(0, Math.min(100, (bsi  + 1) * 50)))
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
    ((1 - ndvi) * 0.5 + bsi * 0.35 - ndbi * 0.15) * 100
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
    verified_zones: [],
    satellite_image_used: false,
  }
}

type ScoredCell = GridCell & { ndvi: number; ndbi: number; bsi: number; score: number }
type ClassifiedCell = ScoredCell & { osm: OSMClassification }

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14`,
      {
        headers: { 'User-Agent': 'delhi-forest-ai/1.0 (ishantkukreti@gmail.com)' },
        signal: AbortSignal.timeout(5_000),
      }
    )
    if (!res.ok) return ''
    const data = await res.json()
    const addr = data.address ?? {}
    const parts = [
      addr.suburb || addr.neighbourhood || addr.village || addr.quarter || addr.hamlet || '',
      addr.city_district || addr.county || '',
    ].filter(Boolean)
    return parts.length > 0
      ? parts.join(', ')
      : (data.display_name ?? '').split(',').slice(0, 2).join(',').trim()
  } catch {
    return ''
  }
}

async function identifyPlantingZones(grid: GridCell[]): Promise<{ zones: VerifiedZone[]; scoredCells: ScoredCell[] }> {
  const scoredCells: ScoredCell[] = grid.map(cell => {
    const { B2, B4, B8, B11 } = cell.bands
    const ndvi  = safeDiv(B8 - B4, B8 + B4)
    const ndbi  = safeDiv(B11 - B8, B11 + B8)
    const bsi   = safeDiv((B11 + B4) - (B8 + B2), (B11 + B4) + (B8 + B2))
    const score = Math.max(0, Math.min(100, ((1 - ndvi) * 0.5 + bsi * 0.35 - ndbi * 0.15) * 100))
    return { ...cell, ndvi, ndbi, bsi, score }
  }).sort((a, b) => b.score - a.score)

  console.log('[ndvi] grid cell scores:', scoredCells.map(c => ({
    lat: c.center.lat.toFixed(4), lon: c.center.lon.toFixed(4),
    bsi: c.bsi.toFixed(3), ndvi: c.ndvi.toFixed(3), ndbi: c.ndbi.toFixed(3),
    score: c.score.toFixed(1),
  })))

  // Require BSI > 0.05 — cells below this are not meaningfully barren
  const candidates = scoredCells.filter(c => c.bsi > 0.05).slice(0, 6)
  console.log('[ndvi] candidates after BSI filter:', candidates.length)

  const osmResults = await Promise.allSettled(
    candidates.map(async (cell): Promise<ClassifiedCell> => {
      const osm = await classifyZoneOSM(cell.center.lat, cell.center.lon)
      console.log(`[ndvi] OSM ${cell.center.lat.toFixed(4)},${cell.center.lon.toFixed(4)} → ${osm.site_type} (plantable:${osm.plantable})`)
      return { ...cell, osm }
    })
  )

  osmResults.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`[ndvi] OSM call ${i} failed:`, r.reason)
  })

  const plantable = osmResults
    .filter((r): r is PromiseFulfilledResult<ClassifiedCell> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(z => z.osm.plantable)
    .slice(0, 4)

  const zones = await Promise.all(plantable.map(async (z, i) => {
    const [cMinLon, cMinLat, cMaxLon, cMaxLat] = z.cellBbox
    const cellAreaHa = (cMaxLon - cMinLon) * 111.32 * Math.cos(z.center.lat * Math.PI / 180)
      * (cMaxLat - cMinLat) * 110.57 * 100
    const plantableHa = Math.max(1, cellAreaHa * Math.min(0.4, Math.max(0, z.bsi)))

    const osmVerified = z.osm.site_type !== 'unknown'
    const siteType    = (z.osm.site_type === 'built_up' || z.osm.site_type === 'unknown'
      ? 'open_ground' : z.osm.site_type) as VerifiedZone['site_type']
    const osmLabel    = osmVerified
      ? z.osm.site_type.replace(/_/g, ' ')
      : 'unverified — OSM has no data here'

    const place_name = await reverseGeocode(z.center.lat, z.center.lon)
    console.log(`[ndvi] zone ${i + 1}: ${siteType}, plantableHa=${plantableHa.toFixed(1)}, bsi=${z.bsi.toFixed(3)}, place=${place_name || '(none)'}`)

    return {
      rank: i + 1,
      site_type: siteType,
      plantable: true,
      estimated_trees: Math.min(80_000, Math.round(plantableHa * 650)),
      cooling_impact: `-${Math.min(2.5, plantableHa * 0.25).toFixed(1)}°C`,
      gemma_reasoning: `Sentinel-2 BSI ${z.bsi.toFixed(2)}, NDVI ${z.ndvi.toFixed(2)} — ${osmLabel}`,
      planting_method: z.osm.site_type === 'road_median' ? 'roadside pits'
        : z.osm.site_type === 'park' ? 'canopy infill'
        : 'ground planting',
      lat: z.center.lat,
      lon: z.center.lon,
      place_name: place_name || undefined,
    } satisfies VerifiedZone
  }))

  return { zones, scoredCells }
}

const FALLBACKS: Record<string, Omit<NDVIResult, 'district' | 'source' | 'verified_zones' | 'satellite_image_used' | 'plantation_score'>> = {
  'Central Delhi':    { ndvi_pct: 6,  green_cover_pct: 4,  estimated_temp_c: 38, built_up_pct: 97, barren_ha: 0,  available_rooftops: 847, road_km: 23, wall_count: 312, parking_lots: 41 },
  'Shahdara':         { ndvi_pct: 8,  green_cover_pct: 5,  estimated_temp_c: 37, built_up_pct: 91, barren_ha: 12, available_rooftops: 523, road_km: 18, wall_count: 241, parking_lots: 28 },
  'East Delhi':       { ndvi_pct: 10, green_cover_pct: 7,  estimated_temp_c: 36, built_up_pct: 89, barren_ha: 2,  available_rooftops: 612, road_km: 15, wall_count: 278, parking_lots: 31 },
  'South Delhi':      { ndvi_pct: 32, green_cover_pct: 22, estimated_temp_c: 32, built_up_pct: 71, barren_ha: 4,  available_rooftops: 234, road_km: 9,  wall_count: 189, parking_lots: 22 },
  'North West Delhi': { ndvi_pct: 28, green_cover_pct: 19, estimated_temp_c: 33, built_up_pct: 74, barren_ha: 7,  available_rooftops: 445, road_km: 15, wall_count: 198, parking_lots: 35 },
  'North Delhi':      { ndvi_pct: 22, green_cover_pct: 15, estimated_temp_c: 34, built_up_pct: 80, barren_ha: 9,  available_rooftops: 380, road_km: 14, wall_count: 172, parking_lots: 29 },
  'West Delhi':       { ndvi_pct: 18, green_cover_pct: 12, estimated_temp_c: 35, built_up_pct: 84, barren_ha: 5,  available_rooftops: 420, road_km: 16, wall_count: 190, parking_lots: 32 },
  'New Delhi':        { ndvi_pct: 35, green_cover_pct: 24, estimated_temp_c: 31, built_up_pct: 68, barren_ha: 3,  available_rooftops: 190, road_km: 8,  wall_count: 145, parking_lots: 18 },
  'North East Delhi': { ndvi_pct: 9,  green_cover_pct: 6,  estimated_temp_c: 37, built_up_pct: 90, barren_ha: 4,  available_rooftops: 540, road_km: 17, wall_count: 255, parking_lots: 30 },
  'South West Delhi': { ndvi_pct: 25, green_cover_pct: 17, estimated_temp_c: 33, built_up_pct: 76, barren_ha: 11, available_rooftops: 410, road_km: 13, wall_count: 182, parking_lots: 26 },
  'South East Delhi': { ndvi_pct: 14, green_cover_pct: 10, estimated_temp_c: 35, built_up_pct: 86, barren_ha: 3,  available_rooftops: 480, road_km: 16, wall_count: 220, parking_lots: 33 },
}

function getFallbackData(districtName: string): NDVIResult {
  const defaults = {
    ndvi_pct: 20, green_cover_pct: 14, estimated_temp_c: 34, built_up_pct: 78,
    barren_ha: 5, available_rooftops: 300, road_km: 12, wall_count: 150, parking_lots: 20,
  }
  const base = FALLBACKS[districtName] ?? defaults
  const plantation_score = Math.round(Math.max(0, Math.min(100,
    (1 - base.ndvi_pct / 100) * 40
    + (base.barren_ha > 5 ? 30 : base.barren_ha > 0 ? 15 : 0)
    - base.built_up_pct * 0.2
  )))
  return { district: districtName, source: 'fallback', plantation_score, ...base, verified_zones: [], satellite_image_used: false }
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
