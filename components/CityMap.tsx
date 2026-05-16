'use client'
import { useEffect, useRef, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet'
import type { GeoJsonObject } from 'geojson'
import type { Layer, Map as LeafletMap, PathOptions } from 'leaflet'
import type { CityDistrict } from '@/lib/geocoding'
import 'leaflet/dist/leaflet.css'

interface Props {
  districts: CityDistrict[]
  cityBoundary?: GeoJSON.FeatureCollection | null
  selectedDistrict: string | null
  ndviData: Record<string, number>
  onDistrictClick: (district: CityDistrict) => void
  mapRef?: React.MutableRefObject<LeafletMap | null>
  dimDistrict?: boolean
}

function MapCapture({ mapRef }: { mapRef?: React.MutableRefObject<LeafletMap | null> }) {
  const map = useMap()
  useEffect(() => {
    if (mapRef) mapRef.current = map
  }, [map, mapRef])
  return null
}

function FitBounds({ districts }: { districts: CityDistrict[] }) {
  const map = useMap()
  const prevKey = useRef('')

  useEffect(() => {
    if (districts.length === 0) return
    const key = districts.map(d => d.name).join(',')
    if (key === prevKey.current) return
    prevKey.current = key

    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const d of districts) {
      const [dMinLon, dMinLat, dMaxLon, dMaxLat] = d.bbox
      if (dMinLon < minLon) minLon = dMinLon
      if (dMinLat < minLat) minLat = dMinLat
      if (dMaxLon > maxLon) maxLon = dMaxLon
      if (dMaxLat > maxLat) maxLat = dMaxLat
    }

    if (isFinite(minLon)) {
      map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [20, 20], animate: true })
    }
  }, [districts, map])

  return null
}

function getColor(canopy: number): string {
  if (canopy < 0) return '#e5e7eb'   // not yet analysed
  if (canopy >= 35) return '#97C459' // high
  if (canopy >= 15) return '#EF9F27' // medium
  return '#E24B4A'                   // low / critical
}

export default function CityMap({
  districts, cityBoundary, selectedDistrict, ndviData, onDistrictClick, mapRef, dimDistrict,
}: Props) {
  const selectedRef = useRef(selectedDistrict)
  selectedRef.current = selectedDistrict
  const dimRef = useRef(dimDistrict)
  dimRef.current = dimDistrict

  // district name → Leaflet Path layer
  const layersByName = useRef<Map<string, import('leaflet').Path>>(new Map())

  useEffect(() => {
    layersByName.current.forEach((layer, name) => {
      if (name === selectedRef.current) {
        layer.setStyle({ fillOpacity: dimDistrict ? 0.08 : 0.85 })
      }
    })
  }, [dimDistrict])

  // Build GeoJSON from districts prop
  const geoJson = useMemo<GeoJsonObject | null>(() => {
    if (districts.length === 0) return null
    return {
      type: 'FeatureCollection',
      features: districts.map(d => ({
        type: 'Feature',
        properties: { name: d.name },
        geometry: {
          type: 'Polygon',
          coordinates: [d.polygon],
        },
      })),
    } as GeoJsonObject
  }, [districts])

  const styleFeature = useCallback(
    (feature?: GeoJSON.Feature): PathOptions => {
      const name: string = feature?.properties?.name ?? ''
      const canopy = ndviData[name] ?? -1
      const isSelected = name === selectedRef.current
      return {
        fillColor: getColor(canopy),
        fillOpacity: isSelected ? 0.85 : 0.55,
        color: isSelected ? '#1e40af' : '#6b7280',
        weight: isSelected ? 3 : 1,
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ndviData, selectedDistrict]
  )

  const onEachFeature = useCallback(
    (feature: GeoJSON.Feature, layer: Layer) => {
      const name: string = feature.properties?.name ?? ''
      const district = districts.find(d => d.name === name)
      if (!district) return

      const path = layer as import('leaflet').Path
      layersByName.current.set(name, path)
      path.bindTooltip(name, { permanent: false, direction: 'center', className: 'district-tooltip' })
      path.on('click', () => onDistrictClick(district))
      path.on('mouseover', () => {
        if (selectedRef.current === name && dimRef.current) return
        path.setStyle({ fillOpacity: 0.8 })
      })
      path.on('mouseout', () => {
        const isSelected = selectedRef.current === name
        path.setStyle({ fillOpacity: isSelected ? (dimRef.current ? 0.08 : 0.85) : 0.55 })
      })
    },
    [districts, onDistrictClick]
  )

  // Re-key forces GeoJSON to remount and re-apply styles
  const geoKey = Object.keys(ndviData).sort().join(',') + (selectedDistrict ?? '') + districts.length

  return (
    <div style={{ height: '100%', width: '100%', borderRadius: '12px', overflow: 'hidden' }}>
      <MapContainer
        center={[20, 0]}
        zoom={2}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
      >
        <MapCapture mapRef={mapRef} />
        <FitBounds districts={districts} />
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          attribution="Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics"
          maxZoom={18}
        />
        {geoJson && (
          <GeoJSON
            key={geoKey}
            data={geoJson}
            style={styleFeature}
            onEachFeature={onEachFeature}
          />
        )}
      </MapContainer>

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: '32px', left: '16px', zIndex: 1000,
        background: 'white', borderRadius: '8px', padding: '8px 12px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)', fontSize: '11px', pointerEvents: 'none',
      }}>
        {[
          { color: '#97C459', label: 'Green cover ≥ 35%' },
          { color: '#EF9F27', label: 'Green cover 15–34%' },
          { color: '#E24B4A', label: 'Green cover < 15%' },
          { color: '#e5e7eb', label: 'Not analysed' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
            <div style={{ width: '12px', height: '12px', borderRadius: '2px', background: color, border: '1px solid #d1d5db' }} />
            <span style={{ color: '#374151' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
