const GEMMA_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent'

export interface GemmaResponse {
  analysis: string
  mode: 'planting' | 'alternative'
}

export interface GemmaImage {
  base64: string
  mimeType: 'image/jpeg' | 'image/png'
}

export async function callGemma(prompt: string, images?: GemmaImage[]): Promise<string> {
  // Images go first so Gemma can ground them before reading the text analysis request
  const imageParts = (images ?? []).map(img => ({
    inlineData: { mimeType: img.mimeType, data: img.base64 },
  }))
  const parts = [...imageParts, { text: prompt }]

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 1200 },
  })

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${GEMMA_URL}?key=${process.env.GEMMA_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    const data = await res.json()

    // Retry on 500 — model is occasionally overloaded
    if (res.status === 500 && attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 1500))
      continue
    }

    if (!res.ok) throw new Error(`Gemma API error ${res.status}: ${JSON.stringify(data)}`)

    const text: string | undefined =
      data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('Empty Gemma response')
    return extractFinalParagraphs(text.trim())
  }

  throw new Error('Gemma API failed after 3 attempts')
}

// Gemma 4 exposes chain-of-thought. Two extraction strategies:
// 1. Pull text from "* *Paragraph N:* <prose>" lines (most reliable)
// 2. Fall back to last 3 clean prose paragraphs
function extractFinalParagraphs(raw: string): string {
  // Strategy 1: lines matching "* *Paragraph N...*: <prose>" (may have leading spaces)
  const embedded = [...raw.matchAll(/^\s*\*\s+\*Paragraph\s+\d[^*]*\*:?\*?\s+(.+)$/gm)]
    .map(m => m[1].trim())
    .filter(p => p.length > 40)
  if (embedded.length >= 3) return embedded.slice(0, 3).join('\n\n')

  // Strategy 2: last 3 non-bullet, non-meta prose paragraphs
  const paragraphs = raw
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p =>
      p.length > 40 &&
      !p.startsWith('*') &&
      !p.startsWith('-') &&
      !/^\s*\d+\./.test(p) &&
      !/\b(check|wait|draft|final|constraint|sentence|paragraph|count|tweak|polish|revision)\b/i.test(p)
    )
  const final = paragraphs.slice(-3)
  return final.length > 0 ? final.join('\n\n') : raw
}

export interface VerifiedZone {
  rank: number
  site_type: 'open_ground' | 'road_median' | 'rooftop' |
             'parking_lot' | 'park' | 'construction' | 'unknown'
  plantable: boolean
  estimated_trees: number
  cooling_impact: string
  gemma_reasoning: string
  planting_method: string
  lat: number
  lon: number
  place_name?: string
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English',  nativeName: 'English'  },
  { code: 'hi', label: 'Hindi',    nativeName: 'हिन्दी'    },
  { code: 'bn', label: 'Bengali',  nativeName: 'বাংলা'    },
  { code: 'ta', label: 'Tamil',    nativeName: 'தமிழ்'    },
  { code: 'te', label: 'Telugu',   nativeName: 'తెలుగు'   },
  { code: 'mr', label: 'Marathi',  nativeName: 'मराठी'    },
] as const

export type LangCode = typeof SUPPORTED_LANGUAGES[number]['code']

export async function translateForReport(
  text: string,
  targetLang: LangCode,
  apiKey: string
): Promise<string> {
  if (targetLang === 'en') return text

  const langName = SUPPORTED_LANGUAGES.find(l => l.code === targetLang)?.label ?? targetLang

  const prompt = `Translate the following urban forestry policy brief text into ${langName}.
Preserve all numbers, percentages, and technical terms exactly as they are.
Return ONLY the translated text — no explanation, no notes.

Text to translate:
${text}`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemma-2-9b-it:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 800 }
        })
      }
    )
    const data = await res.json()
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? text
  } catch {
    return text
  }
}

export function buildPrompt(params: {
  district: string
  ndvi_pct: number
  green_cover_pct: number
  estimated_temp_c: number
  built_up_pct: number
  barren_ha: number
  zones?: VerifiedZone[]
}): { prompt: string; hasLand: boolean } {
  const { district, ndvi_pct, green_cover_pct, estimated_temp_c, built_up_pct, barren_ha, zones } = params
  const hasLand = barren_ha > 2

  const zoneBlock = zones && zones.length > 0
    ? `\nTop planting sites identified by satellite analysis:\n` + zones.slice(0, 3).map((z, i) => {
        const extra = z as unknown as Record<string, unknown>
        const plantableHa = extra._plantable_ha ?? '?'
        return (
          `Site ${i + 1}: ${z.place_name ?? z.site_type} — ` +
          `${z.gemma_reasoning} — ` +
          `${plantableHa}ha plantable, ~${z.estimated_trees.toLocaleString()} trees possible, ` +
          `${z.cooling_impact} cooling potential, method: ${z.planting_method}`
        )
      }).join('\n')
    : ''

  const imageNote = zones && zones.length > 0
    ? `\nSatellite imagery of the top ${Math.min(zones.length, 3)} planting sites is attached above (one tile per site, in the same order as the site list). Use what you observe in these images to add specific visual detail to your priority action paragraph.\n`
    : ''

  const prompt = `You are an urban forestry AI analyst preparing a government policy brief.
${imageNote}
District: ${district}, Delhi
NDVI score: ${ndvi_pct}% (vegetation index from Sentinel-2 satellite)
Green cover (NDVI-derived): ${green_cover_pct}%
Est. surface temperature: ${estimated_temp_c}°C
Built-up area: ${built_up_pct}%
Available barren land: ${barren_ha} hectares${zoneBlock}

${
  hasLand
    ? 'Barren land IS available for conventional tree planting.'
    : 'NO significant barren land found. This is a dense urban zone. Recommend alternative greening: rooftop gardens, roadside planting, vertical walls, parking lot greening.'
}

Output ONLY the following — no explanations, no self-correction, no thinking steps:

Paragraph 1 (2-3 sentences): Current situation — severity of heat and canopy problem, using specific numbers.
Paragraph 2 (2-3 sentences): Root cause — why does this district have this canopy level?
Paragraph 3 (2-3 sentences): Priority action — what should government or NGO do first, referencing specific sites and visual evidence from the satellite images.

Professional policy language. No bullet points. No headers. No asterisks. Plain prose only.`

  return { prompt, hasLand }
}
