'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, GeoJSON, Rectangle, useMap } from 'react-leaflet'
import type { GeoJsonObject } from 'geojson'
import type { Layer, Map as LeafletMap, PathOptions } from 'leaflet'
import 'leaflet/dist/leaflet.css'

interface Props {
  onDistrictClick: (districtName: string, bbox: [number, number, number, number], polygonCoords: number[][][]) => void
  selectedDistrict: string | null
  ndviData: Record<string, number>
  mapRef?: React.MutableRefObject<LeafletMap | null>
  dimDistrict?: boolean
  gridCells?: Array<{ bbox: [number, number, number, number]; score: number; bsi: number }>
}

function MapCapture({ mapRef }: { mapRef?: React.MutableRefObject<LeafletMap | null> }) {
  const map = useMap()
  useEffect(() => {
    if (mapRef) mapRef.current = map
  }, [map, mapRef])
  return null
}

function getColor(canopy: number): string {
  if (canopy < 0) return '#e5e7eb'   // not yet analysed
  if (canopy >= 35) return '#97C459' // high
  if (canopy >= 15) return '#EF9F27' // medium
  return '#E24B4A'                   // low / critical
}

function computeBbox(geometry: GeoJSON.Geometry): [number, number, number, number] {
  const lons: number[] = []
  const lats: number[] = []

  function collect(coords: unknown) {
    if (typeof (coords as number[])[0] === 'number') {
      const c = coords as [number, number]
      lons.push(c[0])
      lats.push(c[1])
    } else {
      ;(coords as unknown[]).forEach(collect)
    }
  }

  collect((geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon).coordinates)
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
}

export default function DelhiMap({ onDistrictClick, selectedDistrict, ndviData, mapRef, dimDistrict, gridCells }: Props) {
  const [geoJson, setGeoJson] = useState<GeoJsonObject | null>(null)
  const selectedRef = useRef(selectedDistrict)
  selectedRef.current = selectedDistrict
  const dimRef = useRef(dimDistrict)
  dimRef.current = dimDistrict

  // Map of district name → its Leaflet Path layer, populated by onEachFeature
  const layersByName = useRef<Map<string, import('leaflet').Path>>(new Map())

  // When dimDistrict flips, update the selected district's fill opacity in-place (no remount)
  useEffect(() => {
    layersByName.current.forEach((layer, name) => {
      if (name === selectedRef.current) {
        layer.setStyle({ fillOpacity: dimDistrict ? 0.08 : 0.85 })
      }
    })
  }, [dimDistrict])

  useEffect(() => {
    fetch('/delhi-districts.geojson')
      .then(r => r.json())
      .then(setGeoJson)
  }, [])

  const styleFeature = useCallback(
    (feature?: GeoJSON.Feature): PathOptions => {
      const name: string = feature?.properties?.district_name ?? ''
      const canopy = ndviData[name] ?? -1
      const isSelected = name === selectedRef.current
      return {
        fillColor: getColor(canopy),
        fillOpacity: isSelected ? 0.85 : 0.55,
        color: isSelected ? '#1e40af' : '#6b7280',
        weight: isSelected ? 3 : 1,
      }
    },
    // Re-derive styles when ndviData or selection changes — GeoJSON re-keyed below
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ndviData, selectedDistrict]
  )

  const onEachFeature = useCallback(
    (feature: GeoJSON.Feature, layer: Layer) => {
      const name: string = feature.properties?.district_name ?? ''
      const bbox = computeBbox(feature.geometry)

      const geom = feature.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon
      const polygonCoords: number[][][] = geom.type === 'MultiPolygon'
        ? (geom.coordinates[0] as number[][][])
        : (geom.coordinates as number[][][])

      const path = layer as import('leaflet').Path
      layersByName.current.set(name, path)
      path.bindTooltip(name, { permanent: false, direction: 'center', className: 'district-tooltip' })
      path.on('click', () => onDistrictClick(name, bbox, polygonCoords))
      path.on('mouseover', () => {
        const isSelected = selectedRef.current === name
        if (isSelected && dimRef.current) return
        path.setStyle({ fillOpacity: 0.8 })
      })
      path.on('mouseout', () => {
        const isSelected = selectedRef.current === name
        path.setStyle({ fillOpacity: isSelected ? (dimRef.current ? 0.08 : 0.85) : 0.55 })
      })
    },
    [onDistrictClick]
  )

  // Key forces GeoJSON to remount (and re-apply styles) when analysed districts change
  const geoKey = Object.keys(ndviData).sort().join(',') + (selectedDistrict ?? '')

  return (
    <div style={{ height: '100%', width: '100%', borderRadius: '12px', overflow: 'hidden' }}>
      <MapContainer
        center={[28.6139, 77.209]}
        zoom={10}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
      >
        <MapCapture mapRef={mapRef} />
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
        {gridCells?.map((cell, i) => {
          const [minLon, minLat, maxLon, maxLat] = cell.bbox
          const color = cell.score >= 60 ? '#ef4444'
            : cell.score >= 40 ? '#f97316'
            : cell.score >= 20 ? '#facc15'
            : '#94a3b8'
          const fillOpacity = cell.score >= 20 ? 0.28 : 0.08
          return (
            <Rectangle
              key={i}
              bounds={[[minLat, minLon], [maxLat, maxLon]]}
              pathOptions={{ color, fillColor: color, fillOpacity, weight: 1, opacity: 0.7 }}
            />
          )
        })}
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
