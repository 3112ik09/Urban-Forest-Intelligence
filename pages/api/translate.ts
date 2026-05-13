import type { NextApiRequest, NextApiResponse } from 'next'
import { translateForReport, type LangCode } from '@/lib/gemma'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  const { text, lang } = req.body as { text: string; lang: LangCode }
  if (!text || !lang) return res.status(400).json({ error: 'Missing text or lang' })
  const translated = await translateForReport(text, lang, process.env.GEMMA_API_KEY ?? '')
  res.status(200).json({ translated })
}
