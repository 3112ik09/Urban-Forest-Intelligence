import type { NextApiRequest, NextApiResponse } from 'next'
import { getGEEToken, fetchSentinelBands } from '@/lib/earthengine'
import { fetchSatelliteTile } from '@/lib/satellite'
import { verifySitesWithVision, type VerifiedZone } from '@/lib/gemma'

export interface NDVIResult {
  district: string
  ndvi_pct: number
  canopy_pct: number
  avg_temp_c: number
  built_up_pct: number
  barren_ha: number
  available_rooftops: number
  road_km: number
  wall_count: number
  parking_lots: number
  source: 'gee' | 'fallback'
  verified_zones: VerifiedZone[]
  satellite_image_used: boolean
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { districtName, bbox } = req.body as { districtName: string; bbox: [number, number, number, number] }
  if (!districtName || !bbox) return res.status(400).json({ error: 'districtName and bbox required' })

  try {
    let baseResult: NDVIResult
    try {
      const token = await getGEEToken()
      const { B4, B8 } = await fetchSentinelBands(bbox, token)
      baseResult = deriveMetrics(districtName, B4, B8, 'gee')
    } catch (err) {
      console.error('[ndvi] GEE failed, using fallback:', err)
      baseResult = getFallbackData(districtName)
    }

    let verified_zones: VerifiedZone[] = []
    let satellite_image_used = false

    if (baseResult.barren_ha > 0) {
      const tileBase64 = await fetchSatelliteTile(bbox)
      satellite_image_used = tileBase64.length > 0
      verified_zones = await verifySitesWithVision(
        districtName,
        baseResult.barren_ha,
        tileBase64,
        process.env.GEMMA_API_KEY ?? ''
      )
    }

    return res.status(200).json({ ...baseResult, verified_zones, satellite_image_used })
  } catch (err) {
    console.error('[ndvi] handler error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

function deriveMetrics(
  district: string,
  B4: number,
  B8: number,
  source: 'gee' | 'fallback'
): NDVIResult {
  const ndvi = (B8 - B4) / (B8 + B4)
  const ndvi_pct = Math.round(Math.max(0, Math.min(100, ndvi * 100)))
  const canopy_pct = Math.round(ndvi_pct * 0.7)
  const avg_temp_c = Math.round(44 - ndvi_pct * 0.32)
  const built_up_pct = Math.round(Math.max(10, Math.min(99, 95 - ndvi_pct * 1.8)))
  const barren_ha =
    ndvi_pct < 15
      ? Math.round((100 - built_up_pct) * 0.8)
      : Math.round((100 - built_up_pct) * 0.3)

  return {
    district,
    ndvi_pct,
    canopy_pct,
    avg_temp_c,
    built_up_pct,
    barren_ha,
    available_rooftops: Math.round(built_up_pct * 8.5),
    road_km: Math.round(built_up_pct * 0.22),
    wall_count: Math.round(built_up_pct * 3.1),
    parking_lots: Math.round(built_up_pct * 0.4),
    source,
    verified_zones: [],
    satellite_image_used: false,
  }
}

const FALLBACKS: Record<string, Omit<NDVIResult, 'district' | 'source' | 'verified_zones' | 'satellite_image_used'>> = {
  'Central Delhi':    { ndvi_pct: 6,  canopy_pct: 4,  avg_temp_c: 38, built_up_pct: 97, barren_ha: 0,  available_rooftops: 847, road_km: 23, wall_count: 312, parking_lots: 41 },
  'Shahdara':         { ndvi_pct: 8,  canopy_pct: 5,  avg_temp_c: 37, built_up_pct: 91, barren_ha: 12, available_rooftops: 523, road_km: 18, wall_count: 241, parking_lots: 28 },
  'East Delhi':       { ndvi_pct: 10, canopy_pct: 7,  avg_temp_c: 36, built_up_pct: 89, barren_ha: 2,  available_rooftops: 612, road_km: 15, wall_count: 278, parking_lots: 31 },
  'South Delhi':      { ndvi_pct: 32, canopy_pct: 22, avg_temp_c: 32, built_up_pct: 71, barren_ha: 4,  available_rooftops: 234, road_km: 9,  wall_count: 189, parking_lots: 22 },
  'North West Delhi': { ndvi_pct: 28, canopy_pct: 19, avg_temp_c: 33, built_up_pct: 74, barren_ha: 7,  available_rooftops: 445, road_km: 15, wall_count: 198, parking_lots: 35 },
  'North Delhi':      { ndvi_pct: 22, canopy_pct: 15, avg_temp_c: 34, built_up_pct: 80, barren_ha: 9,  available_rooftops: 380, road_km: 14, wall_count: 172, parking_lots: 29 },
  'West Delhi':       { ndvi_pct: 18, canopy_pct: 12, avg_temp_c: 35, built_up_pct: 84, barren_ha: 5,  available_rooftops: 420, road_km: 16, wall_count: 190, parking_lots: 32 },
  'New Delhi':        { ndvi_pct: 35, canopy_pct: 24, avg_temp_c: 31, built_up_pct: 68, barren_ha: 3,  available_rooftops: 190, road_km: 8,  wall_count: 145, parking_lots: 18 },
  'North East Delhi': { ndvi_pct: 9,  canopy_pct: 6,  avg_temp_c: 37, built_up_pct: 90, barren_ha: 4,  available_rooftops: 540, road_km: 17, wall_count: 255, parking_lots: 30 },
  'South West Delhi': { ndvi_pct: 25, canopy_pct: 17, avg_temp_c: 33, built_up_pct: 76, barren_ha: 11, available_rooftops: 410, road_km: 13, wall_count: 182, parking_lots: 26 },
  'South East Delhi': { ndvi_pct: 14, canopy_pct: 10, avg_temp_c: 35, built_up_pct: 86, barren_ha: 3,  available_rooftops: 480, road_km: 16, wall_count: 220, parking_lots: 33 },
}

function getFallbackData(districtName: string): NDVIResult {
  const base = FALLBACKS[districtName] ?? {
    ndvi_pct: 20, canopy_pct: 14, avg_temp_c: 34, built_up_pct: 78,
    barren_ha: 5, available_rooftops: 300, road_km: 12, wall_count: 150, parking_lots: 20,
  }
  return { district: districtName, source: 'fallback', ...base, verified_zones: [], satellite_image_used: false }
}
