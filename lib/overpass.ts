export interface OSMClassification {
  plantable: boolean
  site_type: 'open_ground' | 'road_median' | 'park' | 'built_up' | 'unknown'
}

const BUILT_UP = new Set([
  'landuse=residential', 'landuse=commercial', 'landuse=industrial',
  'landuse=construction', 'landuse=retail',
])

const PLANTABLE_LANDUSE = new Set([
  'landuse=grass', 'landuse=meadow', 'landuse=scrub',
  'landuse=farmland', 'landuse=greenfield', 'landuse=brownfield',
  'natural=scrub', 'natural=heath', 'natural=grassland', 'natural=bare_rock',
])

export async function classifyZoneOSM(lat: number, lon: number): Promise<OSMClassification> {
  const query = `[out:json][timeout:8];
(
  way["building"](around:200,${lat},${lon});
  way["landuse"](around:200,${lat},${lon});
  way["leisure"="park"](around:200,${lat},${lon});
  way["highway"]["highway"!~"path|footway|cycleway|track"](around:80,${lat},${lon});
  node["natural"](around:200,${lat},${lon});
);
out tags;`

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) return { plantable: true, site_type: 'unknown' }

    const data = await res.json()
    const elements: Array<{ tags?: Record<string, string> }> = data.elements ?? []

    const tags = new Set<string>()
    for (const el of elements) {
      for (const [k, v] of Object.entries(el.tags ?? {})) tags.add(`${k}=${v}`)
    }

    const hasBuilding = [...tags].some(t => t.startsWith('building='))
    const isBuiltUp   = [...tags].some(t => BUILT_UP.has(t))
    if (hasBuilding || isBuiltUp) return { plantable: false, site_type: 'built_up' }

    if ([...tags].some(t => t === 'leisure=park'))       return { plantable: true, site_type: 'park' }
    if ([...tags].some(t => PLANTABLE_LANDUSE.has(t)))   return { plantable: true, site_type: 'open_ground' }
    if ([...tags].some(t => t.startsWith('highway=')))   return { plantable: true, site_type: 'road_median' }

    return { plantable: true, site_type: 'open_ground' }
  } catch {
    return { plantable: true, site_type: 'unknown' }
  }
}
