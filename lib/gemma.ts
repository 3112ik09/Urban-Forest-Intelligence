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

// Internal: raw API call for structured outputs — no chain-of-thought stripping, lower temperature
async function callGemmaStructured(prompt: string, images: GemmaImage[]): Promise<string> {
  const imageParts = images.map(img => ({
    inlineData: { mimeType: img.mimeType, data: img.base64 },
  }))
  const body = JSON.stringify({
    contents: [{ parts: [...imageParts, { text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
  })

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${GEMMA_URL}?key=${process.env.GEMMA_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const data = await res.json()
    if (res.status === 500 && attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 1500))
      continue
    }
    if (!res.ok) throw new Error(`Gemma API error ${res.status}: ${JSON.stringify(data)}`)
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('Empty Gemma response')
    return text.trim()
  }
  throw new Error('Gemma API failed after 3 attempts')
}

/**
 * Re-ranks MCDA candidate zones using Gemma vision — each zone must have a corresponding
 * satellite tile image (same order). Returns re-ranked zones with visual gemma_reasoning.
 * Zones identified as restricted infrastructure (airports, runways, highways) are filtered out.
 * Falls back to original MCDA order if Gemma fails or returns unparseable output.
 */
export async function reRankZonesWithGemma(
  zones: VerifiedZone[],
  images: GemmaImage[],
  cityName?: string,
): Promise<VerifiedZone[]> {
  if (zones.length < 2 || images.length === 0) return zones

  const siteList = zones.map((z, i) => {
    const extra = z as unknown as Record<string, unknown>
    const ha = extra._plantable_ha ?? '?'
    return `Site ${i + 1}: ${z.place_name ?? z.site_type.replace(/_/g, ' ')} — ${ha}ha plantable, ${z.gemma_reasoning}`
  }).join('\n')

  const location = cityName ?? 'this city'

  const prompt = `You are reviewing ${images.length} satellite images of potential urban tree planting sites in ${location}. Images are attached in order: Site 1, Site 2, ..., Site ${images.length}.

Sites being evaluated:
${siteList}

CRITICAL — Before ranking, examine each image carefully. If a site is clearly any of the following, mark it UNSUITABLE (do NOT rank it):
• Airport runway, taxiway, apron, or airfield — concrete/asphalt strips, aircraft, runway markings
• Active motorway, highway, or rail line — fast-moving traffic lanes, railway tracks
• Military or security-restricted zone
• Active industrial or water treatment facility
• Open water — sea, ocean, bay, river, lake, pond, or waterway with no accessible land

For all other sites, rank from most to least suitable for urban tree planting.
Favour: open bare ground, scrubland, road medians, parks, parking lots.
Penalise: dense paved surfaces, buildings.

Output ONLY these lines — no other text, no explanations:
RANK 1: Site N — one sentence describing what you see and why it is suitable
RANK 2: Site N — one sentence
...continuing for all suitable sites
UNSUITABLE: Site N — one sentence explaining why planting is not possible here (airport/runway/highway/etc.)`

  try {
    const raw = await callGemmaStructured(prompt, images)

    // Zones Gemma marked as restricted infrastructure — exclude from results
    const unsuitableIndices = new Set<number>()
    for (const m of raw.matchAll(/UNSUITABLE:\s+Site\s+(\d+)\s*[—–\-]+\s*(.+)/gi)) {
      const idx = parseInt(m[1]) - 1
      if (idx >= 0 && idx < zones.length) {
        unsuitableIndices.add(idx)
        console.log(`[gemma] reRankZones: Site ${idx + 1} marked UNSUITABLE — ${m[2].trim()}`)
      }
    }

    const matches = [...raw.matchAll(/RANK\s+\d+:\s+Site\s+(\d+)\s*[—–\-]+\s*(.+)/gi)]

    const eligibleCount = zones.length - unsuitableIndices.size
    if (matches.length < Math.ceil(eligibleCount / 2)) {
      console.warn('[gemma] reRankZones: parsed', matches.length, 'of', eligibleCount, 'eligible sites — falling back to MCDA order (minus unsuitable)')
      return zones.filter((_, i) => !unsuitableIndices.has(i))
    }

    const used = new Set<number>()
    const ranked: VerifiedZone[] = []
    for (const m of matches) {
      const idx = parseInt(m[1]) - 1
      if (idx >= 0 && idx < zones.length && !used.has(idx) && !unsuitableIndices.has(idx)) {
        used.add(idx)
        ranked.push({ ...zones[idx], gemma_reasoning: m[2].trim() })
      }
    }
    // Append any non-unsuitable zones Gemma didn't mention
    zones.forEach((z, i) => { if (!used.has(i) && !unsuitableIndices.has(i)) ranked.push(z) })

    if (unsuitableIndices.size > 0) {
      console.log(`[gemma] reRankZones: filtered ${unsuitableIndices.size} unsuitable zone(s), ${ranked.length} remain`)
    }

    return ranked
  } catch (err) {
    console.warn('[gemma] reRankZones failed:', err)
    return zones
  }
}

export function buildPrompt(params: {
  district: string
  cityName?: string
  ndvi_pct: number
  green_cover_pct: number
  estimated_temp_c: number
  built_up_pct: number
  barren_ha: number
  zones?: VerifiedZone[]
}): { prompt: string; hasLand: boolean } {
  const { district, cityName, ndvi_pct, green_cover_pct, estimated_temp_c, built_up_pct, barren_ha, zones } = params
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
District: ${district}${cityName ? `, ${cityName}` : ''}
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
