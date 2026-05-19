const GEMMA_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent'

const GEMMA_PLANNER_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent'

function getGemmaKey(index = 0): string {
  const keys = [process.env.GEMMA_API_KEY, process.env.GEMMA_API_KEY_2].filter(Boolean) as string[]
  return keys[index % keys.length]
}

// Parse retryDelay from a 429 response body (e.g. "10.3s" → 11300ms). Falls back to 12s.
function parse429DelayMs(data: unknown): number {
  try {
    const details = ((data as Record<string, unknown>)?.error as Record<string, unknown>)
      ?.details as Array<Record<string, unknown>> | undefined
    const retryInfo = details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')
    const delayStr = retryInfo?.retryDelay as string | undefined
    const match = delayStr?.match(/^(\d+(?:\.\d+)?)s$/)
    if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 1000
  } catch { /* ignore */ }
  return 12000
}

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
    const res = await fetch(`${GEMMA_URL}?key=${getGemmaKey(attempt - 1)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    const data = await res.json()

    if (res.status === 429 && attempt < 3) {
      const delay = parse429DelayMs(data)
      console.warn(`[gemma] callGemma 429 rate-limit, retrying in ${delay}ms (attempt ${attempt})`)
      await new Promise(r => setTimeout(r, delay))
      continue
    }
    if ((res.status === 500 || res.status === 503) && attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 3000))
      continue
    }

    if (!res.ok) throw new Error(`Gemma API error ${res.status}: ${JSON.stringify(data)}`)

    const parts: Array<Record<string, unknown>> = data?.candidates?.[0]?.content?.parts ?? []
    const text = extractOutputText(parts)
    if (!text) throw new Error('Empty Gemma response')
    return extractFinalParagraphs(text)
  }

  throw new Error('Gemma API failed after 3 attempts')
}

// Gemma 4 exposes chain-of-thought. Two extraction strategies:
// 1. Pull text from "* *Paragraph N:* <prose>" lines (most reliable)
// 2. Fall back to last 3 clean prose paragraphs
export function sanitiseGemmaOutput(raw: string): string {
  return extractFinalParagraphs(raw)
}

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

export interface AgentSpecies {
  name: string
  local_name?: string
  why: string
  type: 'native' | 'adaptive' | 'exotic'
  growth_rate: 'fast' | 'medium' | 'slow'
  canopy: 'large' | 'medium' | 'small'
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
  _species?: AgentSpecies[]
  _carbon_10yr?: number
  _people_impacted?: number
  _cost_inr?: number
  _plantable_ha?: number
  _mcda_score?: number
}

export interface PatchInput {
  id: string
  areaHa: number
  centroid: { lat: number; lon: number }
  placeName?: string
  bands: { bare: number; built: number; trees: number; grass: number; shrub_and_scrub: number; water?: number }
  canopyPct: number
  siteType: string
  mcdaScore?: number
  ring?: [number, number][]
}

export interface AgentCritique {
  site_id: string
  verdict: 'approve' | 'review' | 'reject'
  mcda_score: number
  visual_confidence: number
  adjusted_score: number
  issues: string[]
  positive_signals: string[]
  reasoning: string
  inferred_site_type?: string
}

export interface ValidationResult {
  site_id: string
  passed: boolean
  compactness: number
  override_reason?: string
}

export interface AgentPlan {
  site_id: string
  final_rank: number
  plantable: boolean
  species: AgentSpecies[]
  planting_method: string
  estimated_trees: number
  temp_reduction_c: number
  carbon_10yr_tons: number
  people_impacted: number
  cost_estimate_inr: number
  reasoning: string
}

export const SUPPORTED_LANGUAGES = [
  // Top global languages by speaker count
  { code: 'en', label: 'English',    nativeName: 'English'         },
  { code: 'zh', label: 'Mandarin',   nativeName: '中文'             },
  { code: 'es', label: 'Spanish',    nativeName: 'Español'         },
  { code: 'hi', label: 'Hindi',      nativeName: 'हिन्दी'           },
  { code: 'ar', label: 'Arabic',     nativeName: 'العربية'         },
  { code: 'fr', label: 'French',     nativeName: 'Français'        },
  { code: 'pt', label: 'Portuguese', nativeName: 'Português'       },
  { code: 'bn', label: 'Bengali',    nativeName: 'বাংলা'           },
  { code: 'ru', label: 'Russian',    nativeName: 'Русский'         },
  { code: 'id', label: 'Indonesian', nativeName: 'Bahasa Indonesia'},
  { code: 'ja', label: 'Japanese',   nativeName: '日本語'           },
  { code: 'de', label: 'German',     nativeName: 'Deutsch'         },
  { code: 'ur', label: 'Urdu',       nativeName: 'اردو'            },
  { code: 'sw', label: 'Swahili',    nativeName: 'Kiswahili'       },
  { code: 'ta', label: 'Tamil',      nativeName: 'தமிழ்'           },
  { code: 'te', label: 'Telugu',     nativeName: 'తెలుగు'          },
  { code: 'mr', label: 'Marathi',    nativeName: 'मराठी'           },
] as const

export type LangCode = typeof SUPPORTED_LANGUAGES[number]['code']

// Strips Gemma 4 chain-of-thought from translation output.
// Model outputs "* "original" -> translation" lines — keep only the translation side.
function stripTranslationCoT(raw: string): string {
  const lines = raw.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t || t === '`' || t === '* `' || t === '* \`') continue
    // Arrow pattern: * "original sentence" -> translated sentence
    const arrow = t.match(/^[*\-•]?\s*"[^"]*"\s*-+>\s*(.+)$/)
    if (arrow) { out.push(arrow[1].trim()); continue }
    out.push(line)
  }
  return out.join('\n').trim()
}

export async function translateForReport(
  text: string,
  targetLang: LangCode,
  apiKey: string
): Promise<string> {
  if (targetLang === 'en') return text

  const langName = SUPPORTED_LANGUAGES.find(l => l.code === targetLang)?.label ?? targetLang
  console.log(`[translate] START lang=${targetLang} inputChars=${text.length}`)
  console.log(`[translate] INPUT:\n${text.slice(0, 500)}`)

  const prompt = `You are a professional translator. Translate the text below into ${langName}.

Rules:
- Preserve every [TAG] and [/TAG] marker exactly as-is — do not translate or alter the tag names.
- Translate ALL text between matching open/close tags, including pipe-delimited values like "native | fast | large".
- Preserve species scientific names (in parentheses), all numbers, percentages, and units (%, °C, ha, km) exactly.
- Output ONLY the translated tagged text. No preamble, no explanations, no "original -> translation" lines.

Text:
${text}`

  const keys = [apiKey, process.env.GEMMA_API_KEY_2].filter(Boolean) as string[]

  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = keys[(attempt - 1) % keys.length]
    console.log(`[translate] attempt ${attempt} key=...${key.slice(-6)}`)
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
          }),
          signal: AbortSignal.timeout(60_000),
        }
      )
      console.log(`[translate] attempt ${attempt} status=${res.status}`)
      const data = await res.json()

      if (res.status === 429 && attempt < 3) {
        const delay = parse429DelayMs(data)
        console.warn(`[translate] 429 rate-limit, retrying in ${delay}ms (attempt ${attempt})`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if ((res.status === 500 || res.status === 503) && attempt < 3) {
        console.warn(`[translate] ${res.status} error body:`, JSON.stringify(data).slice(0, 200))
        await new Promise(r => setTimeout(r, attempt * 2000))
        continue
      }
      if (!res.ok) {
        console.error(`[translate] FAILED status=${res.status}`, JSON.stringify(data).slice(0, 300))
        console.error('[translate] FALLING BACK to original English text')
        return text
      }

      const rParts: Array<Record<string, unknown>> = data?.candidates?.[0]?.content?.parts ?? []
      const thoughtCount = rParts.filter(p => p.thought).length
      console.log(`[translate] parts=${rParts.length} thoughtParts=${thoughtCount}`)
      const raw: string = extractOutputText(rParts)
      console.log(`[translate] raw output (first 500):\n${raw.slice(0, 500)}`)
      if (!raw) {
        console.warn(`[translate] empty output on attempt ${attempt}`)
        if (attempt < 3) continue
        console.error('[translate] FALLING BACK to original English text (empty output)')
        return text
      }
      const result = stripTranslationCoT(raw) || text
      console.log(`[translate] final result (first 300):\n${result.slice(0, 300)}`)
      console.log(`[translate] SUCCESS outputChars=${result.length}`)
      return result
    } catch (err) {
      console.error(`[translate] exception attempt ${attempt}:`, err)
      if (attempt === 3) {
        console.error('[translate] FALLING BACK to original English text (exception)')
        return text
      }
    }
  }
  console.error('[translate] FALLING BACK to original English text (exhausted)')
  return text
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
    const res = await fetch(`${GEMMA_URL}?key=${getGemmaKey(attempt - 1)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const data = await res.json()
    if (res.status === 429 && attempt < 3) {
      const delay = parse429DelayMs(data)
      console.warn(`[gemma] 429 rate-limit, retrying in ${delay}ms (attempt ${attempt})`)
      await new Promise(r => setTimeout(r, delay))
      continue
    }
    if (res.status === 500 && attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 1500))
      continue
    }
    if (!res.ok) throw new Error(`Gemma API error ${res.status}: ${JSON.stringify(data)}`)
    const sParts: Array<Record<string, unknown>> = data?.candidates?.[0]?.content?.parts ?? []
    const text = extractOutputText(sParts)
    if (!text) throw new Error('Empty Gemma response')
    return text
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

const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese (Simplified)', es: 'Spanish', hi: 'Hindi', ar: 'Arabic',
  fr: 'French', pt: 'Portuguese', bn: 'Bengali', ru: 'Russian',
  id: 'Indonesian', ja: 'Japanese', de: 'German', ur: 'Urdu',
  sw: 'Swahili', ta: 'Tamil', te: 'Telugu', mr: 'Marathi',
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
  language?: string
}): { prompt: string; hasLand: boolean } {
  const { district, cityName, ndvi_pct, green_cover_pct, estimated_temp_c, built_up_pct, barren_ha, zones, language } = params
  const langName = language && language !== 'en' ? (LANGUAGE_NAMES[language] ?? language) : null
  const languageInstruction = langName
    ? `CRITICAL: Write your ENTIRE response in ${langName}. All paragraphs must be in ${langName}. Do not mix languages. Do not use English at all.\n\n`
    : ''
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

  const prompt = `${languageInstruction}You are an urban forestry AI analyst preparing a government policy brief.
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

// Gemma 4 thinking model returns parts with {thought:true} for reasoning traces.
// Only the non-thought parts contain the actual output (JSON for agents, prose for analysis).
function extractOutputText(parts: Array<Record<string, unknown>>): string {
  const outputParts = parts
    .filter(p => !p.thought && typeof p.text === 'string')
    .map(p => p.text as string)
  return outputParts.join('\n').trim()
}

// Extracts a JSON array from Gemma output that may have chain-of-thought before/after.
// Gemma 4 puts CoT first then the JSON; the array is always the LAST well-formed JSON
// structure in the output. We scan backward from the last ']', tracking bracket depth
// to find its matching '[', then parse that slice.
function extractJsonArray<T>(text: string): T[] | null {
  const clean = text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim()

  // Fast path: whole text is already valid JSON array (no CoT)
  try {
    const p = JSON.parse(clean)
    if (Array.isArray(p) && p.length > 0) return p as T[]
  } catch { /* fall through */ }

  // Scan backward from each ']' and find its matching '[', try to parse the slice
  let end = clean.lastIndexOf(']')
  while (end >= 0) {
    let depth = 0
    let inStr = false
    let esc   = false
    let start = -1

    for (let i = end; i >= 0; i--) {
      const c = clean[i]
      if (esc) { esc = false; continue }
      if (c === '\\' && inStr) { esc = true; continue }
      if (c === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (c === ']' || c === '}') depth++
      else if (c === '{') depth--
      else if (c === '[') {
        depth--
        if (depth === 0) { start = i; break }
      }
    }

    if (start !== -1) {
      try {
        const p = JSON.parse(clean.slice(start, end + 1))
        if (Array.isArray(p) && p.length > 0) return p as T[]
      } catch { /* try previous ']' */ }
    }

    end = clean.lastIndexOf(']', end - 1)
  }

  return null
}

// ── Agent 1 — Gemma Critic ────────────────────────────────────────────────────

export async function runAgentCritic(
  patches: PatchInput[],
  images: GemmaImage[],
  district: string,
  cityName: string,
  keyIndex = 0,
): Promise<AgentCritique[]> {
  if (patches.length === 0) return []

  const siteList = patches.map((p, i) =>
    `Site ${i + 1} (id: ${p.id}): ${p.siteType === 'unknown' ? '[UNKNOWN TYPE — infer from image]' : (p.placeName ?? p.siteType)} — ` +
    `MCDA: ${p.mcdaScore ?? '?'}/100, area: ${p.areaHa.toFixed(1)}ha, canopy: ${p.canopyPct}%, ` +
    `bare: ${Math.round(p.bands.bare * 100)}%, built: ${Math.round(p.bands.built * 100)}%, ` +
    `water: ${Math.round((p.bands.water ?? 0) * 100)}%, ` +
    `trees: ${Math.round(p.bands.trees * 100)}%, grass: ${Math.round(p.bands.grass * 100)}%`
  ).join('\n')

  const prompt = `You are Agent 1 — Urban Forest Site Critic for ${district}, ${cityName}.

Your job: Review each candidate planting site using BOTH the MCDA score AND the satellite image.
The MCDA score is computed from satellite band data. Your visual inspection may confirm or override it.

MCDA Formula:
  Score = canopy_deficit×0.35 + openness×0.30 + area_score×0.20 + site_type_bonus×0.15
  100 = ideal planting site. 0 = completely unsuitable.

Satellite tiles are attached above — one per site in the same order as the list below.

Sites to evaluate:
${siteList}

RULES:
- REJECT if image shows: active construction, water body, ferry terminal, port/dock apron, pier, quay, marina, rooftop, airport/runway, highway surface
- REJECT if built fraction > 0.45 (dense urban fabric, not plantable)
- REVIEW if MCDA > 60 but image shows fragmented or narrow shape
- APPROVE if image confirms open/bare land matching the band data
- Your adjusted_score should reflect both the formula AND what you see

For sites marked [UNKNOWN TYPE — infer from image]:
  Look at the surrounding context in the satellite tile — nearby roads, buildings, vegetation patches, fences, lot boundaries.
  Deduce the most likely land use (vacant lot, road median, parking area, brownfield, etc.) and set inferred_site_type accordingly.
  Use that inferred type to decide verdict and adjusted_score, not the "unknown" label.

For each site return one JSON object with these exact keys: site_id, verdict, mcda_score, visual_confidence, adjusted_score, issues (array of strings), positive_signals (array of strings), reasoning (one sentence). Include inferred_site_type only for unknown sites.`

  const imageParts = images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } }))
  const body = JSON.stringify({
    contents: [{ parts: [...imageParts, { text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
  })

  for (let attempt = 1; attempt <= 3; attempt++) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 45_000)
    let res: Response
    try {
      res = await fetch(`${GEMMA_URL}?key=${getGemmaKey(keyIndex)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: abort.signal,
      })
    } finally { clearTimeout(timer) }
    const data = await res.json()
    if (res.status === 429 && attempt < 3) {
      const delay = parse429DelayMs(data)
      console.warn(`[gemma] 429 rate-limit, retrying in ${delay}ms (attempt ${attempt})`)
      await new Promise(r => setTimeout(r, delay))
      continue
    }
    if (res.status === 500 && attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 1500))
      continue
    }
    if (!res.ok) throw new Error(`Gemma API error ${res.status}: ${JSON.stringify(data)}`)
    const parts: Array<Record<string, unknown>> = data?.candidates?.[0]?.content?.parts ?? []
    const text = extractOutputText(parts)
    if (!text) throw new Error('Empty Gemma response')

    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as AgentCritique[]
    } catch { /* fall through to extractJsonArray */ }
    const parsed = extractJsonArray<AgentCritique>(text)
    if (parsed) return parsed
    console.warn('[gemma] Agent 1 JSON extraction failed, raw:\n', text.slice(0, 600))
    break
  }

  return patches.map(p => ({
    site_id: p.id,
    verdict: 'approve' as const,
    mcda_score: p.mcdaScore ?? 50,
    visual_confidence: 0.5,
    adjusted_score: p.mcdaScore ?? 50,
    issues: [],
    positive_signals: [],
    reasoning: 'Agent 1 parsing failed — defaulting to approve',
  }))
}

// ── Spatial Validator (pure TypeScript) ───────────────────────────────────────

function computeCompactness(ring: [number, number][]): number {
  if (ring.length < 4) return 0.5
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  area = Math.abs(area) / 2
  let perimeter = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i + 1][0] - ring[i][0]
    const dy = ring[i + 1][1] - ring[i][1]
    perimeter += Math.sqrt(dx * dx + dy * dy)
  }
  if (perimeter === 0) return 0
  return (4 * Math.PI * area) / (perimeter * perimeter)
}

export function runSpatialValidator(
  patches: PatchInput[],
  critiques: AgentCritique[],
): ValidationResult[] {
  return patches.map(p => {
    const critique = critiques.find(c => c.site_id === p.id)
    const verdict = critique?.verdict ?? 'approve'
    const adjustedScore = critique?.adjusted_score ?? 50
    const compactness = p.ring ? computeCompactness(p.ring) : 0.5

    let passed: boolean
    let override_reason: string | undefined

    if (verdict === 'reject') {
      passed = false
    } else if (verdict === 'approve' && compactness < 0.01) {
      passed = false
      override_reason = 'shape too fragmented'
    } else if (verdict === 'review' && adjustedScore > 50 && compactness >= 0.01) {
      passed = true
    } else if (verdict === 'review' && adjustedScore <= 50) {
      passed = false
    } else {
      passed = true
    }

    console.log(
      `[validator] site ${p.id}: verdict=${verdict} compactness=${compactness.toFixed(3)} passed=${passed}` +
      (override_reason ? ` override=${override_reason}` : '')
    )

    return { site_id: p.id, passed, compactness, ...(override_reason ? { override_reason } : {}) }
  })
}

// ── Agent 2 — Gemma Planner ───────────────────────────────────────────────────


export async function runAgentPlanner(
  patches: PatchInput[],
  critiques: AgentCritique[],
  validations: ValidationResult[],
  images: GemmaImage[],
  district: string,
  cityName: string,
  language?: string,
  keyIndex = 0,
): Promise<AgentPlan[]> {
  const approved = patches.filter(p => validations.find(v => v.site_id === p.id)?.passed === true)
  if (approved.length === 0) return []

  const langName = language && language !== 'en' ? (LANGUAGE_NAMES[language] ?? language) : null
  const langInstruction = langName
    ? `CRITICAL: Respond entirely in ${langName}. Species names should use common ${langName} names where they exist, with Latin names in parentheses. The "reasoning" field must also be in ${langName}.\n\n`
    : ''

  const siteList = approved.map((p, i) => {
    const critique = critiques.find(c => c.site_id === p.id)
    const plantableHa = Math.min(p.areaHa * 0.70, 40)
    const trees = Math.min(25000, Math.round(plantableHa * 650))
    return (
      `Site ${i + 1} (id: ${p.id}): ${p.placeName ?? p.siteType} — ` +
      `${p.areaHa.toFixed(1)}ha total, plantable_ha=${plantableHa.toFixed(1)}, estimated_trees=${trees}, ` +
      `Agent 1: "${critique?.reasoning ?? 'approved'}", adjusted_score: ${critique?.adjusted_score ?? p.mcdaScore ?? 50}` +
      (critique?.issues?.length ? `, issues: ${critique.issues.join(', ')}` : '') +
      (critique?.positive_signals?.length ? `, positives: ${critique.positive_signals.join(', ')}` : '')
    )
  }).join('\n')

  const prompt = `${langInstruction}You are an urban forest planner for ${district}, ${cityName}.

Sites:
${siteList}

Respond with ONLY a JSON array — no prose, no markdown fences. One element per site, using these exact field names:
[{"site_id":"<id>","final_rank":<1=best>,"plantable":true,"planting_method":"<ground planting|street tree planting|etc>","estimated_trees":<copy from site>,"temp_reduction_c":<min(2.5,plantable_ha*0.12)>,"carbon_10yr_tons":<estimated_trees*0.025>,"people_impacted":<plantable_ha*150>,"cost_estimate_inr":<estimated_trees*450>,"reasoning":"<one sentence>","species":[{"name":"<Common (Botanical)>","local_name":"<common only>","why":"<why this site>","type":"<native|adaptive|exotic>","growth_rate":"<fast|medium|slow>","canopy":"<large|medium|small>"}]}]

Recommend exactly 2 species per site best suited to ${cityName}'s climate.`

  const imageParts = images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } }))
  const body = JSON.stringify({
    contents: [{ parts: [...imageParts, { text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
  })

  for (let attempt = 1; attempt <= 3; attempt++) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 35_000)
    let res: Response
    try {
      res = await fetch(`${GEMMA_PLANNER_URL}?key=${getGemmaKey(keyIndex)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: abort.signal,
      })
    } finally { clearTimeout(timer) }
    const data = await res.json()
    if (res.status === 429 && attempt < 3) {
      const delay = parse429DelayMs(data)
      console.warn(`[gemma] Agent 2 429, retrying in ${delay}ms (attempt ${attempt})`)
      await new Promise(r => setTimeout(r, delay))
      continue
    }
    // 500/503 = Gemma overloaded — fail fast, caller uses formula fallback
    if (!res.ok) throw new Error(`Gemma API error ${res.status}: ${JSON.stringify(data)}`)
    const parts: Array<Record<string, unknown>> = data?.candidates?.[0]?.content?.parts ?? []
    console.log('[gemma] Agent 2 raw parts count:', parts.length, '| thought parts:', parts.filter(p => p.thought).length)
    const text = extractOutputText(parts)
    if (!text) throw new Error('Empty Gemma response')
    console.log('[gemma] Agent 2 output text (first 300):', text.slice(0, 300))

    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as AgentPlan[]
    } catch { /* fall through to extractJsonArray */ }
    const parsed = extractJsonArray<AgentPlan>(text)
    if (parsed) return parsed
    console.warn('[gemma] Agent 2 JSON extraction failed, raw:\n', text.slice(0, 600))
    break
  }

  return approved.map((p, i) => {
    const plantableHa = Math.min(p.areaHa * 0.70, 40)
    const trees = Math.min(25000, Math.round(plantableHa * 650))
    return {
      site_id: p.id,
      final_rank: i + 1,
      plantable: true,
      species: [{ name: 'Native species', local_name: 'Native species', why: 'suitable for local climate', type: 'native' as const, growth_rate: 'medium' as const, canopy: 'medium' as const }],
      planting_method: 'ground planting',
      estimated_trees: trees,
      temp_reduction_c: parseFloat(Math.min(2.5, plantableHa * 0.12).toFixed(1)),
      carbon_10yr_tons: parseFloat((trees * 0.025).toFixed(1)),
      people_impacted: Math.round(plantableHa * 150),
      cost_estimate_inr: trees * 450,
      reasoning: 'Agent 2 unavailable — using formula estimates',
    }
  })
}
