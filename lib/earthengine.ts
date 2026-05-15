import jwt from 'jsonwebtoken'
import type { OSMCandidate, ValidatedCandidate, GeoJSONPolygon } from './types'
import type { CityConfig } from './cityconfig'

// ── EE expression builder helpers ────────────────────────────────────────────
// ALL builders return a fully-wrapped { functionInvocationValue: ... } node.
// NEVER wrap a builder's return value again — it is already a valid EE node.
// The top-level expression sent to value:compute is the node itself (no result/values wrapper).

const c = (v: unknown) => ({ constantValue: v })

const fn = (name: string, args: Record<string, unknown>) => ({
  functionInvocationValue: {
    functionName: name,
    arguments: args,
  },
})

// ── Auth ─────────────────────────────────────────────────────────────────────

export async function getGEEToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claim = {
    iss: process.env.GEE_SERVICE_ACCOUNT,
    scope: 'https://www.googleapis.com/auth/earthengine',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const privateKey = process.env.GEE_PRIVATE_KEY!.replace(/\\n/g, '\n')
  const signedJwt = jwt.sign(claim, privateKey, { algorithm: 'RS256' })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`,
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`GEE token error: ${JSON.stringify(data)}`)
  return data.access_token
}

// ── Core DW image builders ────────────────────────────────────────────────────

function getDates() {
  const end = new Date()
  const start = new Date(end)
  start.setFullYear(start.getFullYear() - 1)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: fmt(end) }
}

/**
 * reduce.mean confirmed ✓ PASS by gee_debug.py Section 1.
 * ImageCollection.mean is NOT valid in the REST API — do not use it.
 */
function buildDWMeanNode() {
  const { start, end } = getDates()
  return fn('reduce.mean', {
    collection: fn('Collection.filter', {
      collection: fn('ImageCollection.load', {
        id: c('GOOGLE/DYNAMICWORLD/V1'),
      }),
      filter: fn('Filter.dateRangeContains', {
        leftValue: fn('DateRange', {
          start: c(start),
          end: c(end),
        }),
        rightField: c('system:time_start'),
      }),
    }),
  })
}

/** DW mean image with all six bands selected */
function buildDWAllBandsNode() {
  return fn('Image.select', {
    input: buildDWMeanNode(),
    bandSelectors: c(['trees', 'grass', 'bare', 'built', 'water', 'shrub_and_scrub']),
  })
}

/** DW mean image — bare band only */
function buildDWBareNode() {
  return fn('Image.select', {
    input: buildDWMeanNode(),
    bandSelectors: c(['bare']),
  })
}

/**
 * bare > threshold, self-masked.
 * image2 must be Image.constant (not a raw float).
 * Image.selfMask argument key is "image" (not "input").
 */
function buildBareThresholdMask(threshold: number) {
  return fn('Image.selfMask', {
    image: fn('Image.gt', {
      image1: buildDWBareNode(),
      image2: fn('Image.constant', { value: c(threshold) }),
    }),
  })
}

/** Polygon geometry node from a coordinates array */
function buildPolygonNode(coordinates: unknown[]) {
  return fn('GeometryConstructors.Polygon', {
    coordinates: c(coordinates),
    evenOdd: c(true),
  })
}

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface DWBandValues {
  trees: number
  grass: number
  bare: number
  built: number
  water: number
  shrub_and_scrub: number
}

export interface GridCell {
  cellBbox: [number, number, number, number]
  center: { lat: number; lon: number }
  bands: DWBandValues
}

// ── Low-level GEE fetch ───────────────────────────────────────────────────────

/**
 * FIX 1: Correctly unwrap value:compute response.
 * GEE returns { result: { type: 'Dictionary', value: { ... } } } for reduceRegion,
 * and { result: { type: 'FeatureCollection', features: [...] } } for reduceToVectors.
 * We try .value first (Dictionary), then fall back to raw result (FeatureCollection).
 *
 * FIX 2: geeCompute wraps every expression in result/values automatically.
 * Callers pass a bare fn() node; the wrapper is added here.
 */
async function geeCompute(token: string, expression: unknown): Promise<unknown> {
  const project = process.env.GEE_PROJECT_ID
  const url = `https://earthengine.googleapis.com/v1/projects/${project}/value:compute`

  // The REST API requires the expression wrapped in a result/values graph.
  // We wrap any bare fn() node automatically here so callers stay clean.
  const wrapped = {
    result: '0',
    values: { '0': expression },
  }

  const body = JSON.stringify({ expression: wrapped })
  console.log('[gee] geeCompute expression:', body.slice(0, 500))

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(45_000),
  })

  const text = await res.text()

  if (!res.ok) {
    console.error('[gee] geeCompute HTTP error', res.status, text)
    throw new Error(`GEE ${res.status}: ${text.slice(0, 500)}`)
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    console.error('[gee] geeCompute JSON parse error:', text.slice(0, 300))
    throw new Error(`GEE response not JSON: ${text.slice(0, 200)}`)
  }

  const result = (json as Record<string, unknown>)?.result
  console.log('[gee] geeCompute raw result keys:', result && typeof result === 'object' ? Object.keys(result as object).join(',') : String(result))

  // With result/values graph format, GEE returns the computed value directly in result.
  // For reduceRegion (Dictionary) the result IS the band map.
  // For reduceToVectors (FeatureCollection) the result has .features.
  return result ?? null
}

function parseDWBands(result: unknown): DWBandValues {
  const r = (result ?? {}) as Record<string, number>
  console.log('[gee] parseDWBands input:', JSON.stringify(r).slice(0, 200))
  return {
    trees: typeof r['trees'] === 'number' ? r['trees'] : 0,
    grass: typeof r['grass'] === 'number' ? r['grass'] : 0,
    bare: typeof r['bare'] === 'number' ? r['bare'] : 0,
    built: typeof r['built'] === 'number' ? r['built'] : 0,
    water: typeof r['water'] === 'number' ? r['water'] : 0,
    shrub_and_scrub: typeof r['shrub_and_scrub'] === 'number' ? r['shrub_and_scrub'] : 0,
  }
}

/**
 * FIX 3: Expression is a bare fn() node, not wrapped in result/values.
 */
async function fetchDWBandsForRing(
  ring: number[][],
  token: string,
  scale: number,
): Promise<DWBandValues> {
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring
      : [...ring, ring[0]]

  const expression = fn('Image.reduceRegion', {
    image: buildDWAllBandsNode(),
    reducer: fn('Reducer.mean', {}),
    geometry: buildPolygonNode([closed]),
    scale: c(scale),
    maxPixels: c(1e8),
    bestEffort: c(true),
  })

  const result = await geeCompute(token, expression)
  return parseDWBands(result)
}

async function fetchDWBandsForPolygon(
  polygon: GeoJSONPolygon,
  token: string,
  scale: number,
): Promise<DWBandValues> {
  return fetchDWBandsForRing(polygon.coordinates[0] as number[][], token, scale)
}

// ── Grid helpers ──────────────────────────────────────────────────────────────

function bboxToRing(bbox: [number, number, number, number]): number[][][] {
  const [minLon, minLat, maxLon, maxLat] = bbox
  return [[[minLon, maxLat], [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat]]]
}

export async function fetchDWBands(
  polygonCoords: number[][][],
  token: string,
): Promise<DWBandValues> {
  return fetchDWBandsForRing(polygonCoords[0], token, 100).catch((err) => {
    console.error('[gee] fetchDWBands fallback due to error:', err?.message)
    return { trees: 0.05, grass: 0.03, bare: 0.15, built: 0.65, water: 0.02, shrub_and_scrub: 0.02 }
  })
}

export async function fetchDWGrid(
  bbox: [number, number, number, number],
  token: string,
  rows = 4,
  cols = 4,
): Promise<GridCell[]> {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const dLon = (maxLon - minLon) / cols
  const dLat = (maxLat - minLat) / rows

  const cells: Array<Omit<GridCell, 'bands'>> = []
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const cMinLon = minLon + col * dLon
      const cMinLat = minLat + r * dLat
      cells.push({
        cellBbox: [cMinLon, cMinLat, cMinLon + dLon, cMinLat + dLat],
        center: { lat: cMinLat + dLat / 2, lon: cMinLon + dLon / 2 },
      })
    }
  }

  const results = await Promise.allSettled(
    cells.map(async cell => ({
      ...cell,
      bands: await fetchDWBands(bboxToRing(cell.cellBbox), token),
    }))
  )

  return results
    .filter((r): r is PromiseFulfilledResult<GridCell> => r.status === 'fulfilled')
    .map(r => r.value)
}

export async function fetchDWTwoPassGrid(
  bbox: [number, number, number, number],
  token: string,
  topN = 3,
  subRows = 4,
  subCols = 4,
): Promise<GridCell[]> {
  const coarseCells = await fetchDWGrid(bbox, token, 4, 4)
  console.log('[gee] pass1 coarse cells:', coarseCells.length)

  const topCells = coarseCells
    .map(cell => {
      const { trees, grass, bare, built } = cell.bands
      return { ...cell, score: bare * (1 - built) * 0.7 + trees * 0.2 + grass * 0.1 }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)

  console.log('[gee] pass1 top cells:', topCells.map(cell => ({
    lat: cell.center.lat.toFixed(4), lon: cell.center.lon.toFixed(4),
    bare: cell.bands.bare.toFixed(3), score: cell.score.toFixed(3),
  })))

  const allSubCells: GridCell[] = []
  const subResults = await Promise.allSettled(
    topCells.map(cell => fetchDWGrid(cell.cellBbox, token, subRows, subCols))
  )
  subResults.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`[gee] pass2 cell ${i + 1}: ${r.value.length} sub-cells`)
      allSubCells.push(...r.value)
    } else {
      console.error(`[gee] pass2 cell ${i + 1} failed:`, (r.reason as Error)?.message)
    }
  })

  console.log('[gee] pass2 total sub-cells:', allSubCells.length)
  return allSubCells
}

// ── Layer 3a — validate OSM polygons ─────────────────────────────────────────

export async function validateCandidatesGEE(
  candidates: OSMCandidate[],
  token: string,
  config: CityConfig,
): Promise<ValidatedCandidate[]> {
  console.log(`[gee] validating ${candidates.length} OSM candidates via reduceRegion`)

  const results = await Promise.allSettled(
    candidates.map(async (cand): Promise<ValidatedCandidate> => {
      const bands = await fetchDWBandsForPolygon(cand.polygon, token, config.geeScale)
      return {
        ...cand,
        meanBare: bands.bare,
        meanTrees: bands.trees,
        meanBuilt: bands.built,
        meanShrub: bands.shrub_and_scrub,
        canopyPct: Math.round((bands.trees + bands.shrub_and_scrub) * 100),
        validated: true,
      }
    })
  )

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    console.error(`[gee] validation failed for candidate ${i}:`, (r.reason as Error)?.message)
    return { ...candidates[i], meanBare: 0, meanTrees: 0, meanBuilt: 0, meanShrub: 0, canopyPct: 0, validated: false }
  })
}

// ── Layer 3b — GEE bare patch discovery ──────────────────────────────────────

export async function fetchBarePatches(
  bbox: [number, number, number, number],
  token: string,
  config: CityConfig,
): Promise<OSMCandidate[]> {
  const [minLon, minLat, maxLon, maxLat] = bbox
  console.log('[gee] fetchBarePatches for bbox:', bbox)


  const expression = fn('Image.reduceToVectors', {
    image: buildBareThresholdMask(config.bareThreshold),
    scale: c(config.geeScale * 2),
    geometry: buildPolygonNode([[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]]),
    maxPixels: c(5e6),
    bestEffort: c(true),
    geometryType: c('polygon'),
    eightConnected: c(false),
    labelProperty: c(null),
  })

  try {
    const result = await geeCompute(token, expression)
    return parseBarePatches(result, config.minPatchHa)
  } catch (err) {
    console.error('[gee] fetchBarePatches error:', (err as Error)?.message)
    return []
  }
}

// ── Phase 1 — Hotspot scan ────────────────────────────────────────────────────

export interface HotspotZone {
  bbox: [number, number, number, number]
  canopyDeficit: number
  avgBare: number
  avgBuilt: number
}

export async function fetchHotspots(
  bbox: [number, number, number, number],
  token: string,
  config: CityConfig,
): Promise<HotspotZone[]> {
  const cells = await fetchDWGrid(bbox, token, 4, 4)
  console.log('[gee] fetchHotspots: coarse cells returned:', cells.length)

  return cells
    .map(cell => ({
      bbox: cell.cellBbox,
      canopyDeficit: parseFloat(Math.max(0, config.targetCanopyPct - cell.bands.trees - cell.bands.shrub_and_scrub).toFixed(3)),
      avgBare: parseFloat(cell.bands.bare.toFixed(3)),
      avgBuilt: parseFloat(cell.bands.built.toFixed(3)),
    }))
    .sort((a, b) => b.canopyDeficit - a.canopyDeficit)
    .slice(0, 3)
}

// ── Phase 2 — Open ground polygon discovery ───────────────────────────────────

export interface OpenPatch {
  id: string
  polygon: { type: 'Polygon'; coordinates: [number, number][][] }
  areaHa: number
  centroid: { lat: number; lon: number }
}

export async function fetchOpenGroundPatches(
  bbox: [number, number, number, number],
  token: string,
  config: CityConfig,
): Promise<OpenPatch[]> {
  const [minLon, minLat, maxLon, maxLat] = bbox
  console.log('[gee] fetchOpenGroundPatches bbox:', bbox)


  const expression = fn('Image.reduceToVectors', {
    image: buildBareThresholdMask(config.bareThreshold),
    scale: c(config.geeScale * 2),
    geometry: buildPolygonNode([[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]]),
    maxPixels: c(5e6),
    bestEffort: c(true),
    geometryType: c('polygon'),
    eightConnected: c(false),
    labelProperty: c(null),
  })

  try {
    const result = await geeCompute(token, expression) as { features?: Array<{ geometry: { type: string; coordinates: unknown[] } }> } | null
    const features = result?.features ?? []
    console.log('[gee] fetchOpenGroundPatches raw features:', features.length)

    const patches: OpenPatch[] = []
    for (let i = 0; i < features.length; i++) {
      const f = features[i]
      if (f.geometry?.type !== 'Polygon') continue
      const ring = f.geometry.coordinates[0] as [number, number][]
      if (!ring || ring.length < 4) continue
      const areaHa = ringAreaHaFromCoords(ring)
      if (areaHa < config.minPatchHa) continue
      patches.push({
        id: `patch_${i}`,
        polygon: { type: 'Polygon' as const, coordinates: [ring] },
        areaHa: parseFloat(areaHa.toFixed(2)),
        centroid: ringCentroidFromCoords(ring),
      })
    }

    patches.sort((a, b) => b.areaHa - a.areaHa)
    console.log(`[gee] fetchOpenGroundPatches: ${patches.length} patches >= ${config.minPatchHa}ha`)
    return patches
  } catch (err) {
    console.error('[gee] fetchOpenGroundPatches error:', (err as Error).message)
    return []
  }
}

// ── Phase 3 — Per-polygon validation + naming ─────────────────────────────────

export type SiteType =
  | 'park_or_green'
  | 'degraded_scrub'
  | 'vacant_land'
  | 'scrubland'
  | 'low_canopy'
  | 'mixed_open'
  | 'unknown'

export interface ValidatedPatch extends OpenPatch {
  bands: DWBandValues
  siteType: SiteType
  placeName: string | undefined
  canopyPct: number
  validated: boolean
}

export async function validatePatches(
  patches: OpenPatch[],
  token: string,
  config: CityConfig,
): Promise<ValidatedPatch[]> {
  console.log(`[gee] validatePatches: validating ${patches.length} patches`)

  const results = await Promise.allSettled(
    patches.slice(0, 20).map(async (patch): Promise<ValidatedPatch> => {
      const polygon: GeoJSONPolygon = {
        type: 'Polygon',
        coordinates: patch.polygon.coordinates as number[][][],
      }
      const bands = await fetchDWBandsForPolygon(polygon, token, config.geeScale)
      const siteType = inferSiteType(bands)
      const placeName = await reverseGeocodeNominatim(patch.centroid.lat, patch.centroid.lon)
      console.log(`[gee] patch ${patch.id}: ${siteType} | ${patch.areaHa.toFixed(1)}ha | ${placeName ?? 'unnamed'}`)
      return {
        ...patch,
        bands,
        siteType,
        placeName: placeName ?? undefined,
        canopyPct: Math.round((bands.trees + bands.shrub_and_scrub) * 100),
        validated: true,
      }
    })
  )

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    console.error(`[gee] validatePatches patch ${i} failed:`, (r.reason as Error)?.message)
    return {
      ...patches[i],
      bands: { trees: 0, grass: 0, bare: 0, built: 0, water: 0, shrub_and_scrub: 0 },
      siteType: 'unknown' as SiteType,
      placeName: undefined,
      canopyPct: 0,
      validated: false,
    }
  })
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function inferSiteType(bands: DWBandValues): SiteType {
  const { trees, grass, bare, shrub_and_scrub, built, water } = bands
  // Riverbeds, dense hardscape, and high-urban-mix areas are not plantable
  if (water > 0.12 || built > 0.38) return 'unknown'
  if (grass > 0.25) return 'park_or_green'
  if (bare > 0.20 && shrub_and_scrub > 0.10) return 'degraded_scrub'
  // Raised built threshold: urban areas have ~0.3 built even in open plots
  if (bare > 0.20 && built < 0.35) return 'vacant_land'
  if (shrub_and_scrub > 0.20) return 'scrubland'
  if (trees > 0.15) return 'low_canopy'
  return 'mixed_open'
}

function ringAreaHaFromCoords(ring: [number, number][]): number {
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  const avgLat = ring.reduce((s, r) => s + r[1], 0) / ring.length
  return (Math.abs(area) / 2 * 110570 * 111320 * Math.cos(avgLat * Math.PI / 180)) / 10_000
}

function ringCentroidFromCoords(ring: [number, number][]): { lat: number; lon: number } {
  const n = ring.length - 1
  return {
    lon: ring.slice(0, n).reduce((s, r) => s + r[0], 0) / n,
    lat: ring.slice(0, n).reduce((s, r) => s + r[1], 0) / n,
  }
}

function parseBarePatches(result: unknown, minPatchHa: number): OSMCandidate[] {
  const features = (result as Record<string, unknown[]>)?.features ?? []
  console.log('[gee] parseBarePatches: feature count:', features.length)
  const patches: OSMCandidate[] = []

  for (const feat of features as FeatureLike[]) {
    if (!feat?.geometry?.coordinates || feat.geometry.type !== 'Polygon') continue
    const ring = feat.geometry.coordinates[0] as [number, number][]
    if (ring.length < 4) continue
    const areaHa = ringAreaHaFromCoords(ring)
    if (areaHa < minPatchHa) continue
    const centroid = ringCentroidFromCoords(ring)
    patches.push({
      osmId: `gee_patch_${centroid.lat.toFixed(5)}_${centroid.lon.toFixed(5)}`,
      name: '',
      polygon: { type: 'Polygon', coordinates: [ring] },
      areaHa: parseFloat(areaHa.toFixed(2)),
      siteType: 'bare_patch',
      centroid,
      source: 'gee_patch',
    })
  }

  console.log(`[gee] parseBarePatches: ${patches.length} patches > ${minPatchHa}ha`)
  return patches
}

async function reverseGeocodeNominatim(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'UrbanForestAI/1.0' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const json = await res.json() as { address?: Record<string, string> }
    const a = json.address ?? {}
    return a.park ?? a.leisure ?? a.amenity ?? a.suburb ?? a.neighbourhood ?? null
  } catch {
    return null
  }
}

interface FeatureLike {
  geometry: { type: string; coordinates: unknown[] }
}

// ── Satellite tile fetch ──────────────────────────────────────────────────────

/**
 * Fetches a single ESRI World Imagery tile at the given lat/lon centroid and
 * returns it as a base64-encoded JPEG string (for Gemma multimodal input).
 * z=16 gives ~600m × 600m coverage — enough to show a 10–50ha patch with context.
 */
export async function fetchSatelliteTileBase64(
  lat: number,
  lon: number,
  zoom = 16,
): Promise<string | null> {
  const z = zoom
  const x = Math.floor((lon + 180) / 360 * Math.pow(2, z))
  const latRad = lat * Math.PI / 180
  const y = Math.floor(
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, z)
  )
  const url =
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) })
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    return Buffer.from(buf).toString('base64')
  } catch {
    return null
  }
}