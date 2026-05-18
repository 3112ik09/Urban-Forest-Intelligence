import {
  getGEEToken, fetchHotspots, fetchOpenGroundPatches, validatePatches,
  fetchSatelliteTileBase64,
  type ValidatedPatch,
} from '@/lib/earthengine'
import {
  runAgentCritic, runSpatialValidator, runAgentPlanner,
  type PatchInput, type AgentCritique, type AgentPlan, type GemmaImage,
} from '@/lib/gemma'
import { getCityConfig } from '@/lib/cityRegistry'
import type { CityConfig } from '@/lib/cityRegistry'

// ── Thresholds ─────────────────────────────────────────────────────────────────
const SUSPICIOUS_DROP_MCDA = 65   // flagged if zone dropped despite MCDA ≥ this
const SUSPICIOUS_PASS_MCDA = 35   // flagged if zone passed despite MCDA ≤ this

// ── Public types ───────────────────────────────────────────────────────────────

export type ZoneTrace = {
  zoneId: string
  coordinates: [number, number]
  mcdaScore: number
  stage: 'mcda' | 'agent1' | 'spatial_validator' | 'agent2' | 'final'
  verdict: 'passed' | 'dropped' | 'reviewed'
  dropReason?: string
  agent1Critique?: string
  validatorFlags?: string[]
  agent2Rank?: number
  bandValues: {
    ndvi: number
    ndbi: number
    canopy_pct: number
    open_pct: number
    area_ha: number
  }
}

export type ZoneDebugReport = {
  district: string
  city: string
  timestamp: string
  summary: {
    totalCandidates: number
    passedMCDA: number
    passedAgent1: number
    passedSpatialValidator: number
    passedAgent2: number
    finalZones: number
    droppedUnnecessarily: number
  }
  zones: ZoneTrace[]
  suspiciousDrops: ZoneTrace[]
  suspiciousPasses: ZoneTrace[]
}

// ── Private helpers (mirror ndvi.ts private functions exactly) ─────────────────

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

async function fetchRestrictedPolygons(bbox: [number, number, number, number]): Promise<[number, number][][]> {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const query = `[out:json][timeout:20];(` +
    `way["aeroway"~"aerodrome|runway|taxiway|apron"](${minLat},${minLon},${maxLat},${maxLon});` +
    `relation["aeroway"="aerodrome"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["landuse"~"military|industrial|landfill|quarry|railway|port|harbour"](${minLat},${minLon},${maxLat},${maxLon});` +
    `relation["landuse"~"military|industrial|landfill|quarry|railway|port|harbour"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["man_made"~"pier|jetty|breakwater|quay|dock|wharf"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["waterway"="dock"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});` +
    `relation["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["leisure"="marina"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["railway"~"rail|light_rail|subway|tram"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["amenity"="prison"](${minLat},${minLon},${maxLat},${maxLon});` +
    `way["power"~"plant|substation"](${minLat},${minLon},${maxLat},${maxLon});` +
    `);out geom;`
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(22000),
    })
    if (!res.ok) return []
    const data = await res.json()

    type OverpassNode = { lat: number; lon: number }
    type OverpassMember = { type: string; role: string; geometry?: OverpassNode[] }
    type OverpassEl = { type: string; geometry?: OverpassNode[]; members?: OverpassMember[] }

    const polygons: [number, number][][] = []
    for (const el of (data.elements ?? []) as OverpassEl[]) {
      if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3) {
        polygons.push(el.geometry.map(n => [n.lon, n.lat] as [number, number]))
      } else if (el.type === 'relation' && Array.isArray(el.members)) {
        const outerSegs: [number, number][][] = el.members
          .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === '') && Array.isArray(m.geometry))
          .map(m => m.geometry!.map(p => [p.lon, p.lat] as [number, number]))
        if (outerSegs.length > 0) polygons.push(outerSegs.flat())
      }
    }
    return polygons
  } catch {
    return []
  }
}

type ScoredPatch = ValidatedPatch & { mcdaScore: number }

function computeMCDA(patches: ValidatedPatch[], config: CityConfig): ScoredPatch[] {
  const BONUS: Record<string, number> = {
    park_or_green: 0.90, degraded_scrub: 0.70, scrubland: 0.65,
    vacant_land: 0.60, urban_forest: 0.50, roadside_corridor: 0.45,
    mixed_open: 0.40, dense_urban: 0.15, green_roof_candidate: 0.10,
    water_edge: 0.05, unknown: 0.05,
  }
  const scored = patches.map(p => {
    const canopyDeficit = Math.max(0, config.targetCanopyPct - (p.bands.trees + p.bands.shrub_and_scrub))
    const openness = Math.max(0, 1 - p.bands.built)
    const areaScore = Math.min(1, Math.log10(Math.max(p.areaHa, 0.3)) / Math.log10(50))
    const typeBonus = BONUS[p.siteType] ?? 0.10
    const raw = canopyDeficit * 0.35 + openness * 0.30 + areaScore * 0.20 + typeBonus * 0.15
    return { ...p, mcdaScore: Math.round(raw * 100) }
  })
  const max = Math.max(...scored.map(s => s.mcdaScore), 1)
  return scored.map(s => ({ ...s, mcdaScore: Math.round((s.mcdaScore / max) * 100) }))
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function debugZoneSelection(
  districtName: string,
  cityName: string,
  bbox: [number, number, number, number],
  districtPolygon?: [number, number][],
): Promise<ZoneDebugReport> {
  const config = getCityConfig(cityName)

  // Per-request trace store — keyed by zone id, safe for concurrent requests
  const traces = new Map<string, ZoneTrace>()

  // ── Auth ───────────────────────────────────────────────────────────────────
  const token = await getGEEToken()

  // ── Phase 1 — Hotspot scan ─────────────────────────────────────────────────
  const { hotspots } = await fetchHotspots(bbox, token, config)

  // ── Phase 2 — Patch discovery ──────────────────────────────────────────────
  let patches = await fetchOpenGroundPatches(bbox, token, config, hotspots.map(h => h.bbox))

  const containmentRing = (districtPolygon?.length ?? 0) >= 4 ? districtPolygon! : null
  if (containmentRing) {
    patches = patches.filter(p => {
      if (pointInPolygon(p.centroid.lat, p.centroid.lon, containmentRing)) return true
      return p.polygon.coordinates[0].some(([lon, lat]) =>
        pointInPolygon(lat, lon, containmentRing)
      )
    })
  }
  patches = patches.filter(p => p.areaHa <= 100)

  const restrictedPolygons = await fetchRestrictedPolygons(bbox)
  if (restrictedPolygons.length > 0) {
    patches = patches.filter(p =>
      !restrictedPolygons.some(poly => pointInPolygon(p.centroid.lat, p.centroid.lon, poly))
    )
  }

  // ── Phase 3 — Validate patches ─────────────────────────────────────────────
  let validated: ValidatedPatch[] = []
  if (patches.length > 0) {
    validated = await validatePatches(patches, token, config)
  }
  const totalCandidates = validated.length

  // Water band filter (mirrors ndvi.ts)
  validated = validated.filter(p => p.bands.water <= 0.20)

  // ── MCDA scoring + top-candidate selection ─────────────────────────────────
  const mcda = computeMCDA(validated, config)
  const topCandidates: ScoredPatch[] = [...mcda]
    .sort((a, b) => b.mcdaScore - a.mcdaScore)
    .slice(0, 10)
    .filter(p => p.bands.built <= 0.45 && p.areaHa >= 0.5 && p.bands.water <= 0.15)
    .slice(0, 7)

  const passedMCDA = topCandidates.length

  // Initialise traces for every MCDA candidate
  for (const p of topCandidates) {
    traces.set(p.id, {
      zoneId: p.id,
      coordinates: [p.centroid.lat, p.centroid.lon],
      mcdaScore: p.mcdaScore,
      stage: 'mcda',
      verdict: 'passed',
      bandValues: {
        ndvi: parseFloat((p.bands.trees + p.bands.grass).toFixed(3)),
        ndbi: parseFloat((p.bands.built - p.bands.trees).toFixed(3)),
        canopy_pct: p.canopyPct,
        open_pct: Math.round((1 - p.bands.built) * 100),
        area_ha: parseFloat(p.areaHa.toFixed(2)),
      },
    })
  }

  // ── Fetch satellite tiles (same as production) ─────────────────────────────
  const tileResults = await Promise.allSettled(
    topCandidates.map(p => fetchSatelliteTileBase64(p.centroid.lat, p.centroid.lon, 16))
  )
  const tileMap = new Map<string, GemmaImage>()
  for (const [i, r] of tileResults.entries()) {
    if (r.status === 'fulfilled' && r.value) {
      tileMap.set(topCandidates[i].id, { base64: r.value, mimeType: 'image/jpeg' as const })
    }
  }

  const patchInputs: PatchInput[] = topCandidates.map(p => ({
    id: p.id, areaHa: p.areaHa, centroid: p.centroid, placeName: p.placeName,
    bands: p.bands, canopyPct: p.canopyPct, siteType: p.siteType, mcdaScore: p.mcdaScore,
    ring: p.polygon.coordinates[0],
  }))

  // ── Agent 1 — parallel per-site calls ─────────────────────────────────────
  const fallbackCritique = (p: PatchInput): AgentCritique => ({
    site_id: p.id, verdict: 'approve', mcda_score: p.mcdaScore ?? 50,
    visual_confidence: 0.5, adjusted_score: p.mcdaScore ?? 50,
    issues: [], positive_signals: [], reasoning: 'Agent 1 unavailable',
  })

  const agent1Results = await Promise.allSettled(
    patchInputs.map(async p => {
      const img = tileMap.get(p.id)
      try {
        const critiques = await runAgentCritic([p], img ? [img] : [], districtName, cityName)
        return critiques[0] ?? fallbackCritique(p)
      } catch {
        return fallbackCritique(p)
      }
    })
  )

  const allCritiques: AgentCritique[] = agent1Results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : fallbackCritique(patchInputs[i])
  )

  // Capture Agent 1 decisions
  let passedAgent1 = 0
  for (const critique of allCritiques) {
    const trace = traces.get(critique.site_id)
    if (!trace) continue
    trace.agent1Critique = critique.reasoning
    if (critique.verdict === 'reject') {
      trace.stage = 'agent1'
      trace.verdict = 'dropped'
      trace.dropReason = `Agent 1 rejected: ${critique.reasoning}` +
        (critique.issues.length ? ` — Issues: ${critique.issues.join('; ')}` : '')
    } else {
      if (critique.verdict === 'review') trace.verdict = 'reviewed'
      passedAgent1++
    }
  }

  // ── Spatial Validator ──────────────────────────────────────────────────────
  const validations = runSpatialValidator(patchInputs, allCritiques)

  let passedSpatialValidator = 0
  for (const val of validations) {
    const trace = traces.get(val.site_id)
    if (!trace || trace.verdict === 'dropped') continue // already dropped by Agent 1

    if (!val.passed) {
      const flags: string[] = []
      if (val.override_reason) flags.push(val.override_reason.replace(/\s+/g, '_'))
      if (val.compactness < 0.10) flags.push('polsby_popper_below_threshold')
      const critique = allCritiques.find(c => c.site_id === val.site_id)
      if (critique?.verdict === 'review' && (critique.adjusted_score ?? 0) <= 50) {
        flags.push('review_with_low_adjusted_score')
      }
      trace.stage = 'spatial_validator'
      trace.verdict = 'dropped'
      trace.validatorFlags = flags
      trace.dropReason = `Spatial validator failed: ${flags.join(', ') || 'unknown'}`
    } else {
      passedSpatialValidator++
    }
  }

  const approvedIds = new Set(validations.filter(v => v.passed).map(v => v.site_id))
  const approved = patchInputs.filter(p => approvedIds.has(p.id))

  // ── Agent 2 — parallel per-site calls ─────────────────────────────────────
  const fallbackPlan = (p: PatchInput, i: number): AgentPlan => {
    const plantableHa = Math.min(p.areaHa * 0.70, 40)
    const trees = Math.min(25000, Math.round(plantableHa * 650))
    return {
      site_id: p.id, final_rank: i + 1, plantable: true,
      species: [{ name: 'Native species', local_name: 'Native species', why: 'suitable for local climate', type: 'native' as const, growth_rate: 'medium' as const, canopy: 'medium' as const }],
      planting_method: 'ground planting',
      estimated_trees: trees,
      temp_reduction_c: parseFloat(Math.min(2.5, plantableHa * 0.12).toFixed(1)),
      carbon_10yr_tons: parseFloat((trees * 0.025).toFixed(1)),
      people_impacted: Math.round(plantableHa * 150),
      cost_estimate_inr: trees * 450,
      reasoning: 'Agent 2 unavailable — formula estimate',
    }
  }

  let allPlans: AgentPlan[] = []
  if (approved.length > 0) {
    const agent2Results = await Promise.allSettled(
      approved.map(async (p, i) => {
        const img = tileMap.get(p.id)
        try {
          const plans = await runAgentPlanner(
            [p], allCritiques, validations, img ? [img] : [], districtName, cityName,
          )
          return plans[0] ?? fallbackPlan(p, i)
        } catch {
          return fallbackPlan(p, i)
        }
      })
    )
    allPlans = agent2Results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : fallbackPlan(approved[i], i)
    )
  }

  // Re-rank by MCDA (mirrors production)
  const patchScoreMap = new Map(topCandidates.map(p => [p.id, p]))
  const rankedPlans = allPlans
    .filter(p => p.plantable)
    .sort((a, b) => (patchScoreMap.get(b.site_id)?.mcdaScore ?? 0) - (patchScoreMap.get(a.site_id)?.mcdaScore ?? 0))
    .map((p, i) => ({ ...p, final_rank: i + 1 }))

  // Capture Agent 2 decisions
  let passedAgent2 = 0
  for (const p of approved) {
    const trace = traces.get(p.id)
    if (!trace) continue
    const plan = rankedPlans.find(pl => pl.site_id === p.id)
    if (plan) {
      trace.stage = 'final'
      trace.verdict = 'passed'
      trace.agent2Rank = plan.final_rank
      passedAgent2++
    } else {
      trace.stage = 'agent2'
      trace.verdict = 'dropped'
      trace.dropReason = 'Agent 2 did not include in final plans'
    }
  }

  // ── Assemble report ────────────────────────────────────────────────────────
  const allTraces = Array.from(traces.values())
  const suspiciousDrops = allTraces.filter(t => t.verdict === 'dropped' && t.mcdaScore >= SUSPICIOUS_DROP_MCDA)
  const suspiciousPasses = allTraces.filter(t => t.stage === 'final' && t.mcdaScore <= SUSPICIOUS_PASS_MCDA)

  return {
    district: districtName,
    city: cityName,
    timestamp: new Date().toISOString(),
    summary: {
      totalCandidates,
      passedMCDA,
      passedAgent1,
      passedSpatialValidator,
      passedAgent2,
      finalZones: rankedPlans.length,
      droppedUnnecessarily: suspiciousDrops.length,
    },
    zones: allTraces,
    suspiciousDrops,
    suspiciousPasses,
  }
}
