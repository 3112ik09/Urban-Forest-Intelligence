export async function fetchSatelliteTile(bbox: number[]): Promise<string> {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const url =
    `https://export.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/export` +
    `?bbox=${minLon},${minLat},${maxLon},${maxLat}` +
    `&bboxSR=4326&size=512,512&imageSR=4326&format=jpg&f=image`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return ''
    const buf = await res.arrayBuffer()
    return Buffer.from(buf).toString('base64')
  } catch {
    return ''
  }
}
