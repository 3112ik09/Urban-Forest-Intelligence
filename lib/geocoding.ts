const UA = 'UrbanForestAI/1.0'

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface GeocodedCity {
  displayName: string
  bbox: [number, number, number, number]
  osmId: string
  osmType: string
  geojson: GeoJSON.Geometry | null
  countryCode: string
}

export interface CityDistrict {
  name: string
  bbox: [number, number, number, number]
  center: { lat: number; lon: number }
  polygon: [number, number][]
  adminLevel?: string
}

// ── Configuration ─────────────────────────────────────────────────────────────

interface CityConfig {
  osmId: string
  osmType: 'R' | 'W' | 'N'
  districtLevels: string[]
  bboxOverride?: [number, number, number, number]
}

const CITY_OVERRIDES: Record<string, CityConfig> = {
  'tokyo': { osmId: '1543125', osmType: 'R', districtLevels: ['7'], bboxOverride: [138.9428, 35.5012, 139.9193, 35.8984] },
  'delhi': { osmId: '1942586', osmType: 'R', districtLevels: ['5'] },
  'new delhi': { osmId: '1942586', osmType: 'R', districtLevels: ['5'] },
  'new york': { osmId: '175905', osmType: 'R', districtLevels: ['6'] },
  'london': { osmId: '175342', osmType: 'R', districtLevels: ['8'] },
  'paris': { osmId: '7444', osmType: 'R', districtLevels: ['9'] },
  'berlin': { osmId: '62422', osmType: 'R', districtLevels: ['8'] },
  'mumbai': { osmId: '1953718', osmType: 'R', districtLevels: ['5'] },
  'bangalore': { osmId: '7888990', osmType: 'R', districtLevels: ['5'] },
  'bengaluru': { osmId: '7888990', osmType: 'R', districtLevels: ['5'] },
  'nairobi': { osmId: '192798', osmType: 'R', districtLevels: ['8'] },
  'lagos': { osmId: '3720712', osmType: 'R', districtLevels: ['8'] },
  'singapore': { osmId: '536780', osmType: 'R', districtLevels: ['8'] },
  'sydney': { osmId: '13428083', osmType: 'R', districtLevels: ['9'] },
}

// Country-level fallback when city not in overrides
const COUNTRY_DISTRICT_LEVELS: Record<string, string[]> = {
  'us': ['6', '8'],
  'gb': ['8', '9'],
  'fr': ['9'],
  'de': ['9', '10'],
  'jp': ['7'],
  'in': ['5', '6'],
  'br': ['9'],
  'cn': ['6'],
  'ru': ['5', '8'],
  'au': ['6', '8'],
  'ca': ['8', '9'],
  'es': ['9'],
  'it': ['9'],
  'ke': ['8'],
  'ng': ['8'],
  'sg': ['8'],
}

function getOverride(cityName: string): CityConfig | null {
  const lower = cityName.toLowerCase().trim()
  if (CITY_OVERRIDES[lower]) return CITY_OVERRIDES[lower]
  for (const [key, cfg] of Object.entries(CITY_OVERRIDES)) {
    if (lower.includes(key) || key.includes(lower)) return cfg
  }
  return null
}

// ── Geocode ───────────────────────────────────────────────────────────────────

export async function geocodeCity(cityName: string): Promise<GeocodedCity | null> {
  try {
    const override = getOverride(cityName)
    const url = override
      ? `https://nominatim.openstreetmap.org/lookup?osm_ids=${override.osmType}${override.osmId}&format=json&addressdetails=1&polygon_geojson=1`
      : `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1&addressdetails=1&polygon_geojson=1`

    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const data = await res.json()
    const item = Array.isArray(data) ? data[0] : data
    if (!item) return null

    const [minLat, maxLat, minLon, maxLon] = item.boundingbox ?? ['0', '0', '0', '0']
    const nominatimBbox: [number, number, number, number] = [
      parseFloat(minLon), parseFloat(minLat), parseFloat(maxLon), parseFloat(maxLat),
    ]

    return {
      displayName: item.display_name ?? cityName,
      bbox: override?.bboxOverride ?? nominatimBbox,
      osmId: item.osm_id ?? override?.osmId ?? '',
      osmType: item.osm_type ?? 'relation',
      geojson: item.geojson ?? null,
      countryCode: (item.address?.country_code ?? '').toLowerCase(),
    }
  } catch (err) {
    console.error('[geocoding] geocodeCity error:', err)
    return null
  }
}

// ── Overpass helpers ──────────────────────────────────────────────────────────

type OverpassMember = { type: string; role: string; geometry?: Array<{ lat: number; lon: number }> }
type OverpassElement = { type: string; id: number; tags?: Record<string, string>; members?: OverpassMember[] }
type OverpassResponse = { elements?: OverpassElement[] }

async function queryOverpass(query: string): Promise<OverpassResponse | null> {
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) { console.error('[geocoding] overpass HTTP', res.status); return null }
    return await res.json() as OverpassResponse
  } catch (err) { console.error('[geocoding] overpass error:', err); return null }
}

// ── Geometry ──────────────────────────────────────────────────────────────────

function stitchOuterRing(members: OverpassMember[]): [number, number][] {
  const outerWays = members
    .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry?.length)
    .map(m => m.geometry!.map(p => [p.lon, p.lat] as [number, number]))
  if (!outerWays.length) return []
  const result: [number, number][] = [...outerWays[0]]
  const remaining = outerWays.slice(1)
  while (remaining.length > 0) {
    const tail = result[result.length - 1]
    let matched = false
    for (let i = 0; i < remaining.length; i++) {
      const seg = remaining[i]
      if (coordsClose(tail, seg[0])) { result.push(...seg.slice(1)); remaining.splice(i, 1); matched = true; break }
      if (coordsClose(tail, seg[seg.length - 1])) { result.push(...[...seg].reverse().slice(1)); remaining.splice(i, 1); matched = true; break }
    }
    if (!matched) { for (const seg of remaining) result.push(...seg); break }
  }
  if (result.length > 0 && !coordsClose(result[0], result[result.length - 1])) result.push([result[0][0], result[0][1]])
  return result
}

function coordsClose(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
}

function bboxFromRing(ring: [number, number][]): [number, number, number, number] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon; if (lat < minLat) minLat = lat
    if (lon > maxLon) maxLon = lon; if (lat > maxLat) maxLat = lat
  }
  return [minLon, minLat, maxLon, maxLat]
}

function centroidFromRing(ring: [number, number][]): { lat: number; lon: number } {
  const n = ring.length
  return { lon: ring.reduce((s, p) => s + p[0], 0) / n, lat: ring.reduce((s, p) => s + p[1], 0) / n }
}

function coverageOk(districts: CityDistrict[], cityBbox: [number, number, number, number]): boolean {
  if (!districts.length) return false
  const [cMinLon, cMinLat, cMaxLon, cMaxLat] = cityBbox
  const cityW = cMaxLon - cMinLon, cityH = cMaxLat - cMinLat
  if (!cityW || !cityH) return true
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const d of districts) {
    const [a, b, c, e] = d.bbox
    if (a < minLon) minLon = a; if (b < minLat) minLat = b
    if (c > maxLon) maxLon = c; if (e > maxLat) maxLat = e
  }
  return (maxLon - minLon) / cityW >= 0.40 && (maxLat - minLat) / cityH >= 0.40
}

function parseDistricts(elements: OverpassElement[], levelFilter?: string[]): CityDistrict[] {
  const result: CityDistrict[] = []
  for (const el of elements) {
    if (el.type !== 'relation' || !el.members) continue
    if (levelFilter && !levelFilter.includes(el.tags?.admin_level ?? '')) continue
    const name = el.tags?.name ?? el.tags?.['name:en'] ?? ''
    if (!name) continue
    const ring = stitchOuterRing(el.members)
    if (ring.length < 4) continue
    result.push({ name, bbox: bboxFromRing(ring), center: centroidFromRing(ring), polygon: ring, adminLevel: el.tags?.admin_level })
  }
  return result
}

// ── Two query strategies ──────────────────────────────────────────────────────
// Strategy A: area() — most accurate, uses OSM spatial index
// Strategy B: bbox — universal fallback, works even when area() isn't indexed

async function fetchViaArea(osmId: string, osmType: string, levels: string[]): Promise<CityDistrict[]> {
  const areaId = Number(osmId) + (osmType === 'relation' ? 3_600_000_000 : 2_400_000_000)
  const levelPattern = levels.join('|')
  const query = `[out:json][timeout:30];
area(${areaId})->.searchArea;
(
  relation["admin_level"~"^(${levelPattern})$"]["boundary"="administrative"](area.searchArea);
  relation["admin_level"~"^(${levelPattern})$"](area.searchArea);
);
out geom;`
  const data = await queryOverpass(query)
  return parseDistricts(data?.elements ?? [], levels)
}

async function fetchViaBbox(levels: string[], cityBbox: [number, number, number, number]): Promise<CityDistrict[]> {
  const [minLon, minLat, maxLon, maxLat] = cityBbox
  const bboxStr = `${minLat},${minLon},${maxLat},${maxLon}`
  const conditions = levels.map(l =>
    `  relation["admin_level"="${l}"]["boundary"="administrative"](${bboxStr});\n  relation["admin_level"="${l}"](${bboxStr});`
  ).join('\n')
  const query = `[out:json][timeout:30];\n(\n${conditions}\n);\nout geom;`
  const data = await queryOverpass(query)
  return parseDistricts(data?.elements ?? [], levels)
}

async function autoDiscoverLevels(cityBbox: [number, number, number, number]): Promise<string[]> {
  const [minLon, minLat, maxLon, maxLat] = cityBbox
  const bboxStr = `${minLat},${minLon},${maxLat},${maxLon}`
  const data = await queryOverpass(
    `[out:json][timeout:20];relation["boundary"="administrative"](${bboxStr});out tags;`
  )
  const counts = new Map<string, number>()
  for (const el of data?.elements ?? []) {
    const lvl = el.tags?.admin_level ?? ''
    if (lvl) counts.set(lvl, (counts.get(lvl) ?? 0) + 1)
  }
  console.log('[geocoding] auto-discover levels:', Object.fromEntries(counts))
  // Pick levels with 3–60 subdivisions, coarsest first
  return [...counts.entries()]
    .filter(([, c]) => c >= 3 && c <= 60)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
    .map(([l]) => l)
}

// ── Public API ────────────────────────────────────────────────────────────────

// FIX: signature is now (cityName, city) matching the new GeocodedCity object.
// Update callers in page.tsx: fetchCityDistricts(inputValue, cityResult)
export async function fetchCityDistricts(
  cityName: string,
  city: GeocodedCity,
): Promise<CityDistrict[]> {
  try {
    const override = getOverride(cityName)
    const levels = override?.districtLevels
      ?? COUNTRY_DISTRICT_LEVELS[city.countryCode]
      ?? null

    if (levels) {
      console.log(`[geocoding] "${cityName}" → levels ${levels} (${override ? 'override' : 'country rule'})`)

      // Try area() first, bbox fallback if it returns nothing
      let districts = await fetchViaArea(city.osmId, city.osmType, levels)
      if (districts.length >= 2 && coverageOk(districts, city.bbox)) {
        console.log(`[geocoding] area() → ${districts.length} districts`)
        return districts
      }

      districts = await fetchViaBbox(levels, city.bbox)
      if (districts.length >= 2) {
        console.log(`[geocoding] bbox fallback → ${districts.length} districts`)
        return districts
      }

      console.warn(`[geocoding] both strategies returned <2 districts for ${cityName}`)
    }

    // Unknown city/country: auto-discover
    console.log(`[geocoding] auto-discovering levels for "${cityName}"`)
    const discovered = await autoDiscoverLevels(city.bbox)
    if (discovered.length > 0) {
      const districts = await fetchViaBbox(discovered.slice(0, 2), city.bbox)
      if (districts.length >= 2) return districts
    }

    console.warn('[geocoding] no districts found for', cityName)
    return []
  } catch (err) {
    console.error('[geocoding] fetchCityDistricts error:', err)
    return []
  }
}

// Kept for backward compatibility — geojson now comes from geocodeCity directly
export async function getCityBoundaryGeoJSON(
  osmType: string,
  osmId: string,
): Promise<GeoJSON.FeatureCollection | null> {
  try {
    const data = await queryOverpass(`[out:json][timeout:10];relation(${osmId});out geom;`)
    if (!data?.elements?.length) return null
    const el = data.elements[0]
    if (!el?.members) return null
    const ring = stitchOuterRing(el.members)
    if (ring.length < 4) return null
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
    } as GeoJSON.FeatureCollection
  } catch (err) {
    console.error('[geocoding] getCityBoundaryGeoJSON error:', err)
    return null
  }
}