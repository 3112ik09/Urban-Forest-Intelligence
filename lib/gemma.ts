const GEMMA_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent'

export interface GemmaResponse {
  analysis: string
  mode: 'planting' | 'alternative'
}

export async function callGemma(prompt: string): Promise<string> {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
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
}

export async function verifySitesWithVision(
  district: string,
  barrenHa: number,
  satelliteBase64: string,
  apiKey: string
): Promise<VerifiedZone[]> {
  const hasImage = satelliteBase64.length > 0

  const prompt = `You are an urban forestry field inspector for ${district}, Delhi.
${hasImage
  ? 'Analyse the satellite image provided. Identify all visible land patches suitable for tree planting.'
  : `No image available. Estimate zones based on ${barrenHa} hectares of barren land in ${district}.`}

Return ONLY a valid JSON array — no explanation, no markdown fences.
Identify up to 4 zones. Each object must have exactly these keys:

[{
  "rank": 1,
  "site_type": "open_ground",
  "plantable": true,
  "estimated_trees": 2400,
  "cooling_impact": "-1.8°C",
  "gemma_reasoning": "Large open municipal ground in northeast — no structures, road access",
  "planting_method": "ground planting"
}]

site_type options: open_ground, road_median, rooftop, parking_lot, park, construction, unknown
plantable: true only for open_ground, road_median, rooftop, parking_lot, park
estimated_trees: realistic integer based on site area
cooling_impact: estimated °C reduction in 8 years`

  const parts = hasImage
    ? [
        { inline_data: { mime_type: 'image/jpeg', data: satelliteBase64 } },
        { text: prompt }
      ]
    : [{ text: prompt }]

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemma-2-9b-it:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 700 }
        })
      }
    )
    const data = await res.json()
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const clean = raw.replace(/```json|```/g, '').trim()
    const match = clean.match(/\[[\s\S]*\]/)
    if (!match) return fallbackZones(district, barrenHa)
    const parsed = JSON.parse(match[0]) as VerifiedZone[]
    return parsed.filter(z => z.plantable).slice(0, 4)
  } catch {
    return fallbackZones(district, barrenHa)
  }
}

function fallbackZones(district: string, barrenHa: number): VerifiedZone[] {
  const zones: VerifiedZone[] = [
    {
      rank: 1, site_type: 'open_ground', plantable: true,
      estimated_trees: Math.round(barrenHa * 0.4 * 650),
      cooling_impact: `-${(barrenHa * 0.4 * 0.25).toFixed(1)}°C`,
      gemma_reasoning: `Open municipal ground in ${district} — primary planting opportunity`,
      planting_method: 'ground planting'
    },
    {
      rank: 2, site_type: 'road_median', plantable: true,
      estimated_trees: Math.round(barrenHa * 0.3 * 200),
      cooling_impact: `-${(barrenHa * 0.3 * 0.15).toFixed(1)}°C`,
      gemma_reasoning: 'Major road medians — avenue planting suitable',
      planting_method: 'roadside pits'
    },
    {
      rank: 3, site_type: 'park', plantable: true,
      estimated_trees: Math.round(barrenHa * 0.2 * 400),
      cooling_impact: `-${(barrenHa * 0.2 * 0.18).toFixed(1)}°C`,
      gemma_reasoning: 'Underutilised park or institutional ground',
      planting_method: 'ground planting'
    },
    {
      rank: 4, site_type: 'parking_lot', plantable: true,
      estimated_trees: Math.round(barrenHa * 0.1 * 80),
      cooling_impact: `-${(barrenHa * 0.1 * 0.08).toFixed(1)}°C`,
      gemma_reasoning: 'Parking lot perimeter — shade trees reduce surface heat',
      planting_method: 'perimeter planting'
    }
  ]
  return zones.filter(z => z.estimated_trees > 0)
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
  canopy_pct: number
  avg_temp_c: number
  built_up_pct: number
  barren_ha: number
}): { prompt: string; hasLand: boolean } {
  const { district, ndvi_pct, canopy_pct, avg_temp_c, built_up_pct, barren_ha } = params
  const hasLand = barren_ha > 2

  const prompt = `You are an urban forestry AI analyst preparing a government policy brief.

District: ${district}, Delhi
NDVI score: ${ndvi_pct}% (vegetation index from Sentinel-2 satellite)
Tree canopy cover: ${canopy_pct}%
Average summer surface temperature: ${avg_temp_c}°C
Built-up area: ${built_up_pct}%
Available barren land: ${barren_ha} hectares

${
  hasLand
    ? 'Barren land IS available for conventional tree planting.'
    : 'NO significant barren land found. This is a dense urban zone. Recommend alternative greening: rooftop gardens, roadside planting, vertical walls, parking lot greening.'
}

Output ONLY the following — no explanations, no self-correction, no thinking steps:

Paragraph 1 (2-3 sentences): Current situation — severity of heat and canopy problem, using specific numbers.
Paragraph 2 (2-3 sentences): Root cause — why does this district have this canopy level?
Paragraph 3 (2-3 sentences): Priority action — what should government or NGO do first?

Professional policy language. No bullet points. No headers. No asterisks. Plain prose only.`

  return { prompt, hasLand }
}
