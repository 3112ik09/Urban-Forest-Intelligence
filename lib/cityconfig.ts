export interface CityConfig {
  targetCanopyPct: number   // 0–1 — city tree cover target
  bareThreshold:   number   // 0–1 — min bare probability to flag a patch
  treesThreshold:  number   // 0–1 — min trees value to consider already vegetated
  minPatchHa:      number   // minimum viable patch size in hectares
  buildingConf:    number   // 0–1 — min Open Buildings confidence to include
  geeScale:        number   // metres — pixel scale for GEE operations
}

export const DEFAULT_CONFIG: CityConfig = {
  targetCanopyPct: 0.25,
  bareThreshold:   0.18,
  treesThreshold:  0.35,
  minPatchHa:      0.3,
  buildingConf:    0.70,
  geeScale:        20,
}

const OVERRIDES: Record<string, Partial<CityConfig>> = {
  delhi:   { targetCanopyPct: 0.25, bareThreshold: 0.18 },
  mumbai:  { targetCanopyPct: 0.25, bareThreshold: 0.20, minPatchHa: 0.2 },
  nairobi: { targetCanopyPct: 0.30, bareThreshold: 0.22 },
  lagos:   { targetCanopyPct: 0.20, bareThreshold: 0.20 },
  london:  { targetCanopyPct: 0.40, bareThreshold: 0.15 },
  berlin:  { targetCanopyPct: 0.35, bareThreshold: 0.15 },
}

export function getCityConfig(cityName: string): CityConfig {
  const key = cityName.toLowerCase().split(/[\s,_-]/)[0]
  return { ...DEFAULT_CONFIG, ...(OVERRIDES[key] ?? {}) }
}
