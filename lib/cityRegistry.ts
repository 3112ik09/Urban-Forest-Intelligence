// City configuration registry for multi-city urban forest analysis.
// Superset of lib/cityconfig.ts — structurally compatible so objects pass through
// to earthengine.ts functions without type errors.

export interface CityConfig {
  displayName: string
  country: string
  defaultBbox: [number, number, number, number]
  bareThreshold: number
  minPatchHa: number
  targetCanopyPct: number
  geeScale: number
  // Legacy fields kept for earthengine.ts structural compatibility
  treesThreshold: number
  buildingConf: number
}

export const DEFAULT_CITY_CONFIG: CityConfig = {
  displayName: 'City',
  country: '',
  defaultBbox: [0, 0, 0, 0],
  bareThreshold: 0.18,
  minPatchHa: 0.2,
  targetCanopyPct: 0.25,
  geeScale: 20,
  treesThreshold: 0.35,
  buildingConf: 0.70,
}

const OVERRIDES: Record<string, Partial<CityConfig>> = {
  delhi:     { displayName: 'Delhi',     country: 'India',   defaultBbox: [76.839, 28.405, 77.345, 28.883], bareThreshold: 0.18, targetCanopyPct: 0.25 },
  mumbai:    { displayName: 'Mumbai',    country: 'India',   defaultBbox: [72.775, 18.894, 72.987, 19.268], bareThreshold: 0.20, minPatchHa: 0.2 },
  bangalore: { displayName: 'Bangalore', country: 'India',   defaultBbox: [77.460, 12.830, 77.780, 13.143], bareThreshold: 0.18, targetCanopyPct: 0.30 },
  bengaluru: { displayName: 'Bangalore', country: 'India',   defaultBbox: [77.460, 12.830, 77.780, 13.143], bareThreshold: 0.18, targetCanopyPct: 0.30 },
  chennai:   { displayName: 'Chennai',   country: 'India',   defaultBbox: [80.178, 12.878, 80.310, 13.230], bareThreshold: 0.20 },
  kolkata:   { displayName: 'Kolkata',   country: 'India',   defaultBbox: [88.254, 22.430, 88.492, 22.707], bareThreshold: 0.20, minPatchHa: 0.2 },
  london:    { displayName: 'London',    country: 'UK',      defaultBbox: [-0.489, 51.286, 0.236, 51.686],  bareThreshold: 0.10, minPatchHa: 0.15, targetCanopyPct: 0.40, geeScale: 10 },
  new:       { displayName: 'New York',  country: 'USA',     defaultBbox: [-74.259, 40.478, -73.700, 40.917], bareThreshold: 0.10, minPatchHa: 0.15, targetCanopyPct: 0.35, geeScale: 10 },
  lagos:     { displayName: 'Lagos',     country: 'Nigeria', defaultBbox: [3.100, 6.395, 3.690, 6.704],    bareThreshold: 0.20, targetCanopyPct: 0.20 },
  nairobi:   { displayName: 'Nairobi',   country: 'Kenya',   defaultBbox: [36.650, -1.444, 37.102, -1.163], bareThreshold: 0.22, targetCanopyPct: 0.30 },
}

export function getCityConfig(cityName: string): CityConfig {
  const key = cityName.toLowerCase().split(/[\s,_-]/)[0]
  return { ...DEFAULT_CITY_CONFIG, ...(OVERRIDES[key] ?? {}) }
}
