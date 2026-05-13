export interface District {
  name: string
  code: string
  bbox: [number, number, number, number] // [minLon, minLat, maxLon, maxLat]
  center: [number, number]               // [lat, lon] for Leaflet
}

export const DELHI_DISTRICTS: District[] = [
  { name: 'Central Delhi',    code: 'DL-C',  bbox: [77.165, 28.612, 77.264, 28.786], center: [28.699, 77.215] },
  { name: 'East Delhi',       code: 'DL-E',  bbox: [77.253, 28.570, 77.342, 28.656], center: [28.613, 77.298] },
  { name: 'New Delhi',        code: 'DL-ND', bbox: [77.050, 28.481, 77.255, 28.646], center: [28.564, 77.153] },
  { name: 'North Delhi',      code: 'DL-N',  bbox: [76.962, 28.691, 77.224, 28.883], center: [28.787, 77.093] },
  { name: 'North East Delhi', code: 'DL-NE', bbox: [77.206, 28.660, 77.299, 28.787], center: [28.724, 77.253] },
  { name: 'North West Delhi', code: 'DL-NW', bbox: [76.942, 28.658, 77.190, 28.818], center: [28.738, 77.066] },
  { name: 'Shahdara',         code: 'DL-SH', bbox: [77.254, 28.638, 77.333, 28.714], center: [28.676, 77.294] },
  { name: 'South Delhi',      code: 'DL-S',  bbox: [77.112, 28.405, 77.248, 28.566], center: [28.486, 77.180] },
  { name: 'South East Delhi', code: 'DL-SE', bbox: [77.199, 28.480, 77.345, 28.610], center: [28.545, 77.272] },
  { name: 'South West Delhi', code: 'DL-SW', bbox: [76.839, 28.501, 77.103, 28.672], center: [28.587, 76.971] },
  { name: 'West Delhi',       code: 'DL-W',  bbox: [76.951, 28.608, 77.197, 28.701], center: [28.655, 77.074] },
]

export const DISTRICT_NAMES = DELHI_DISTRICTS.map(d => d.name)

export function getDistrictByName(name: string): District | undefined {
  return DELHI_DISTRICTS.find(d => d.name === name)
}

export function getBbox(districtName: string): [number, number, number, number] | null {
  return getDistrictByName(districtName)?.bbox ?? null
}
