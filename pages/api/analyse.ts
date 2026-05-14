import type { NextApiRequest, NextApiResponse } from 'next'
import { callGemma, buildPrompt, GemmaResponse } from '@/lib/gemma'
import type { NDVIResult } from './ndvi'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const body = req.body as NDVIResult
  const { district, ndvi_pct, green_cover_pct, estimated_temp_c, built_up_pct, barren_ha } = body

  if (!district) return res.status(400).json({ error: 'district is required' })

  const { prompt, hasLand } = buildPrompt({
    district,
    ndvi_pct,
    green_cover_pct,
    estimated_temp_c,
    built_up_pct,
    barren_ha,
  })

  try {
    const analysis = await callGemma(prompt)
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
