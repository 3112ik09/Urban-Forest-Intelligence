// Layer 2 — OSM Overpass polygon discovery.
// Fetches real named GeoJSON polygons for candidate planting sites.
// Returns OSMCandidate[] sorted by area descending.
//
// Handles both simple `way` features and `relation` multipolygons.
// Most large parks in Delhi (Nehru Park, Lodhi Garden, etc.) are OSM
// relations — skipping them caused 0 candidates in the previous version.

import type { OSMCandidate, OSMSiteType, OSMTagSet, GeoJSONPolygon, CityConfig } from './types'

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'
const TIMEOUT_S = 25
// Overpass uses a smaller min-area than the scoring phase — tiny parks are
// still worth returning so the scorer can weigh area against other factors.
const OVERPASS_MIN_PATCH_HA = 0.05

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch candidate planting polygons from OSM Overpass for a given bbox.
 * Returns up to maxResults candidates sorted by area descending.
 * Never throws — returns [] on any network or parse error.
 */
export async function fetchCandidatePolygons(
  bbox: [number, number, number, number],
  config: CityConfig,
  maxResults = 60,
): Promise<OSMCandidate[]> {
  const [minLon, minLat, maxLon, maxLat] = bbox
  // Overpass bbox order: south,west,north,east
  const overpassBbox = `${minLat},${minLon},${maxLat},${maxLon}`

  const query = buildOverpassQuery(overpassBbox, config.osmTags)
  console.log('[overpass] querying bbox:', overpassBbox)

  let raw: OverpassResponse
  try {
    const res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'DelhiForestAI/1.0 (urban-forest-planting-tool)',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(TIMEOUT_S * 1000),
    })
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`)
    raw = await res.json() as OverpassResponse
  } catch (err) {
    console.warn('[overpass] fetch failed:', err)
    return []
  }

  const candidates = parseOverpassResponse(raw, config.osmTags)
  const sorted = candidates
    .sort((a, b) => b.areaHa - a.areaHa)
    .slice(0, maxResults)

  console.log(`[overpass] ${sorted.length} candidates (ways: ${
    candidates.filter(c => c.osmId.startsWith('way')).length
  }, relations: ${
    candidates.filter(c => c.osmId.startsWith('relation')).length
  })`)
  return sorted
}

// ── Query builder ─────────────────────────────────────────────────────────────

function buildOverpassQuery(bbox: string, tagSets: OSMTagSet[]): string {
  const unions: string[] = []
  for (const ts of tagSets) {
    for (const val of ts.values) {
      unions.push(`way["${ts.key}"="${val}"](${bbox});`)
      unions.push(`relation["${ts.key}"="${val}"](${bbox});`)
    }
  }
  return `
[out:json][timeout:${TIMEOUT_S}];
(
  ${unions.join('\n  ')}
);
out body;
>;
out skel qt;
`.trim()
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseOverpassResponse(
  raw: OverpassResponse,
  tagSets: OSMTagSet[],
): OSMCandidate[] {
  // Pass 1 — build node coordinate index
  const nodeMap = new Map<number, [number, number]>()
  for (const el of raw.elements) {
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      nodeMap.set(el.id, [el.lon, el.lat])
    }
  }

  // Pass 2 — build way-to-nodes index (includes skeleton ways from `>` expansion)
  const wayNodesMap = new Map<number, number[]>()
  for (const el of raw.elements) {
    if (el.type === 'way' && el.nodes) {
      wayNodesMap.set(el.id, el.nodes)
    }
  }

  const candidates: OSMCandidate[] = []

  // Pass 3a — process simple ways (have both nodes AND tags)
  for (const el of raw.elements) {
    if (el.type !== 'way' || !el.nodes || !el.tags) continue

    const ring = buildRingFromNodeIds(el.nodes, nodeMap)
    if (!ring) continue

    const areaHa = ringAreaHa(ring)
    if (areaHa < OVERPASS_MIN_PATCH_HA) continue

    candidates.push({
      osmId: `way/${el.id}`,
      name: el.tags.name ?? el.tags['name:en'] ?? '',
      polygon: { type: 'Polygon', coordinates: [ring] },
      areaHa: parseFloat(areaHa.toFixed(2)),
      siteType: classifyTags(el.tags, tagSets),
      centroid: ringCentroid(ring),
      source: 'osm',
    })
  }

  // Pass 3b — process relation multipolygons (where large parks live in OSM)
  for (const el of raw.elements) {
    if (el.type !== 'relation' || !el.tags || !el.members) continue

    // Collect outer member way IDs — role '' (empty) is also treated as outer
    const outerWayIds = el.members
      .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === ''))
      .map(m => m.ref)

    if (outerWayIds.length === 0) continue

    const ring = stitchWaysToRing(outerWayIds, wayNodesMap, nodeMap)
    if (!ring) continue

    const areaHa = ringAreaHa(ring)
    if (areaHa < OVERPASS_MIN_PATCH_HA) continue

    candidates.push({
      osmId: `relation/${el.id}`,
      name: el.tags.name ?? el.tags['name:en'] ?? '',
      polygon: { type: 'Polygon', coordinates: [ring] },
      areaHa: parseFloat(areaHa.toFixed(2)),
      siteType: classifyTags(el.tags, tagSets),
      centroid: ringCentroid(ring),
      source: 'osm',
    })
  }

  return candidates
}

// ── Way/ring assembly ─────────────────────────────────────────────────────────

function buildRingFromNodeIds(
  nodeIds: number[],
  nodeMap: Map<number, [number, number]>,
): [number, number][] | null {
  const coords = nodeIds
    .map(id => nodeMap.get(id))
    .filter((c): c is [number, number] => c !== undefined)

  if (coords.length < 4) return null

  const isClosed = coords[0][0] === coords[coords.length - 1][0] &&
                   coords[0][1] === coords[coords.length - 1][1]
  return isClosed ? coords : [...coords, coords[0]]
}

/**
 * Stitch multiple outer ways (from a multipolygon relation) into a single ring.
 * Attempts proper chain assembly by matching way endpoints. Falls back to
 * concatenation if ways are already in order (common for manually mapped parks).
 */
function stitchWaysToRing(
  wayIds: number[],
  wayNodesMap: Map<number, number[]>,
  nodeMap: Map<number, [number, number]>,
): [number, number][] | null {
  // Collect coord arrays for each way
  const segments: [number, number][][] = []
  for (const wid of wayIds) {
    const nodeIds = wayNodesMap.get(wid)
    if (!nodeIds) continue
    const coords = nodeIds
      .map(id => nodeMap.get(id))
      .filter((c): c is [number, number] => c !== undefined)
    if (coords.length >= 2) segments.push(coords)
  }

  if (segments.length === 0) return null

  // Single way — close it and return
  if (segments.length === 1) {
    const s = segments[0]
    const isClosed = s[0][0] === s[s.length - 1][0] && s[0][1] === s[s.length - 1][1]
    return isClosed ? s : [...s, s[0]]
  }

  // Multiple ways — chain by matching endpoints (greedy)
  const result: [number, number][] = [...segments[0]]
  const remaining = segments.slice(1)

  while (remaining.length > 0) {
    const tail = result[result.length - 1]
    let matched = false

    for (let i = 0; i < remaining.length; i++) {
      const seg = remaining[i]
      const head = seg[0]
      const rhead = seg[seg.length - 1]

      if (coordsMatch(tail, head)) {
        result.push(...seg.slice(1))
        remaining.splice(i, 1)
        matched = true
        break
      }
      if (coordsMatch(tail, rhead)) {
        result.push(...[...seg].reverse().slice(1))
        remaining.splice(i, 1)
        matched = true
        break
      }
    }

    // Can't chain — fall back to simple concatenation
    if (!matched) {
      for (const seg of remaining) result.push(...seg)
      break
    }
  }

  if (result.length < 4) return null

  const isClosed = coordsMatch(result[0], result[result.length - 1])
  return isClosed ? result : [...result, result[0]]
}

function coordsMatch(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7
}

function classifyTags(tags: Record<string, string>, tagSets: OSMTagSet[]): OSMSiteType {
  for (const ts of tagSets) {
    if (ts.values.includes(tags[ts.key])) return ts.siteType
  }
  return 'unknown'
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function ringAreaHa(ring: [number, number][]): number {
  let area = 0
  const n = ring.length
  for (let i = 0; i < n - 1; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    area += x1 * y2 - x2 * y1
  }
  const degSq = Math.abs(area) / 2
  const avgLat = ring.reduce((s, r) => s + r[1], 0) / ring.length
  const latM = 110570
  const lonM = 111320 * Math.cos(avgLat * Math.PI / 180)
  return (degSq * latM * lonM) / 10_000
}

function ringCentroid(ring: [number, number][]): { lat: number; lon: number } {
  const n = ring.length - 1  // exclude closing point
  const lon = ring.slice(0, n).reduce((s, r) => s + r[0], 0) / n
  const lat = ring.slice(0, n).reduce((s, r) => s + r[1], 0) / n
  return { lat, lon }
}

// ── Overpass response types ───────────────────────────────────────────────────

interface OverpassResponse {
  elements: OverpassElement[]
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  nodes?: number[]
  members?: Array<{ type: string; ref: number; role: string }>
  tags?: Record<string, string>
}
