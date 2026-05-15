import type { NextApiRequest, NextApiResponse } from 'next'
import { callGemma, buildPrompt, GemmaResponse, GemmaImage } from '@/lib/gemma'
import { fetchSatelliteTileBase64 } from '@/lib/earthengine'
import type { NDVIResult } from './ndvi'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const body = req.body as NDVIResult
  const { district, ndvi_pct, green_cover_pct, estimated_temp_c, built_up_pct, barren_ha, verified_zones } = body

  if (!district) return res.status(400).json({ error: 'district is required' })

  const zones = verified_zones ?? []

  const { prompt, hasLand } = buildPrompt({
    district,
    ndvi_pct,
    green_cover_pct,
    estimated_temp_c,
    built_up_pct,
    barren_ha,
    zones: zones.length > 0 ? zones : undefined,
  })

  // Fetch satellite tile for each of the top 3 zones in parallel
  const tileResults = await Promise.allSettled(
    zones.slice(0, 3).map(z => fetchSatelliteTileBase64(z.lat, z.lon, 16))
  )
  const images: GemmaImage[] = tileResults
    .filter((r): r is PromiseFulfilledResult<string> =>
      r.status === 'fulfilled' && r.value !== null
    )
    .map(r => ({ base64: r.value, mimeType: 'image/jpeg' as const }))

  console.log(`[analyse] zones: ${zones.length}, tile images fetched: ${images.length}`)

  try {
    const analysis = await callGemma(prompt, images.length > 0 ? images : undefined)
    const response: GemmaResponse = {
      analysis,
      mode: hasLand ? 'planting' : 'alternative',
    }
    return res.status(200).json(response)
  } catch (err) {
    console.error('[analyse] Gemma call failed:', err)
    return res.status(500).json({
      error: 'Gemma API call failed',
      analysis: '',
      mode: hasLand ? 'planting' : 'alternative',
    } as GemmaResponse & { error: string })
  }
}
