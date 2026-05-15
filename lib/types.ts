// Shared types for the four-layer Urban Forest AI pipeline.
// NDVIResult stays in pages/api/ndvi.ts — it is the API response contract.

export interface HotspotZone {
  bbox: [number, number, number, number]  // [minLon, minLat, maxLon, maxLat]
  canopyDeficit: number   // targetCanopyPct - actualTreePct, clamped 0–1
  avgBare: number
  avgBuilt: number
  rank: number
}

export type OSMSiteType =
  | 'park'
  | 'playground'
  | 'grass'
  | 'recreation_ground'
  | 'scrub'
  | 'vacant'
  | 'brownfield'
  | 'institutional'
  | 'road_median'
  | 'rail_buffer'
  | 'canal_bank'
  | 'bare_patch'      // discovered by GEE reduceToVectors, not OSM
  | 'unknown'

export interface OSMCandidate {
  osmId: string
  name: string              // real place name from OSM, or '' if unnamed
  polygon: GeoJSONPolygon   // exact boundary
  areaHa: number
  siteType: OSMSiteType
  centroid: { lat: number; lon: number }
  source: 'osm' | 'gee_patch'  // where this candidate came from
}

export interface ValidatedCandidate extends OSMCandidate {
  meanBare: number
  meanTrees: number
  meanBuilt: number
  meanShrub: number
  canopyPct: number         // (meanTrees + meanShrub) as 0–100
  validated: boolean        // false if GEE call failed, use OSM data only
}

export interface GeoJSONPolygon {
  type: 'Polygon'
  coordinates: number[][][]
}

export interface CityConfig {
  targetCanopyPct: number   // 0–1, city tree-cover target
  bareThreshold: number     // 0–1, min bare probability to flag a patch
  minPatchHa: number        // smallest patch worth returning
  osmTags: OSMTagSet[]
  geeScale: number          // metres per pixel for GEE calls (10 = Sentinel-2)
}

export interface OSMTagSet {
  key: string               // OSM tag key, e.g. 'leisure'
  values: string[]          // e.g. ['park', 'playground']
  siteType: OSMSiteType     // how to classify matches
}
