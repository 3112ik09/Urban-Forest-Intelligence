'use client'
import { useState, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import type { Map as LeafletMap, Marker } from 'leaflet'
import HeroStats from '@/components/HeroStats'
import AnalysisPanel from '@/components/AnalysisPanel'
import type { NDVIResult } from '@/pages/api/ndvi'
import type { GemmaResponse, VerifiedZone } from '@/lib/gemma'
import { DELHI_DISTRICTS } from '@/lib/districts'

// Leaflet must be client-side only
const DelhiMap = dynamic(() => import('@/components/DelhiMap'), { ssr: false })

export type FullResult = NDVIResult & GemmaResponse

export default function Home() {
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [ndviData, setNdviData] = useState<Record<string, number>>({})
  const [analysisResult, setAnalysisResult] = useState<FullResult | null>(null)
  const [zoneActive, setZoneActive] = useState(false)

  const mapRef = useRef<LeafletMap | null>(null)
  const zoneMarkerRef = useRef<Marker | null>(null)
  const resultCache = useRef<Map<string, FullResult>>(new Map())

  const handleZoneClick = useCallback(async (zone: VerifiedZone) => {
    if (!mapRef.current || !selectedDistrict) return
    const district = DELHI_DISTRICTS.find(d => d.name === selectedDistrict)
    if (!district) return

    const { lat, lon } = zone
    setZoneActive(true)
    mapRef.current.flyTo([lat, lon], 15, { animate: true, duration: 1.2 })

    const L = (await import('leaflet')).default
    const color = zone.site_type === 'open_ground' ? '#16a34a'
      : zone.site_type === 'road_median' ? '#2563eb'
      : zone.site_type === 'park' ? '#059669'
      : zone.site_type === 'rooftop' ? '#7c3aed'
      : '#d97706'

    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width:28px;height:28px;border-radius:50%;
        background:${color};
        color:#fff;font-size:12px;font-weight:700;
        display:flex;align-items:center;justify-content:center;
        border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);
      ">${zone.rank}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    })

    if (zoneMarkerRef.current) zoneMarkerRef.current.remove()
    zoneMarkerRef.current = L.marker([zone.lat, zone.lon], { icon })
      .addTo(mapRef.current)
      .bindPopup(`<b>Zone ${zone.rank}</b><br>${zone.gemma_reasoning}`)
      .openPopup()
  }, [selectedDistrict])

  const handleDistrictClick = useCallback(
    async (districtName: string, bbox: [number, number, number, number], polygonCoords: number[][][]) => {
      if (loading) return

      setSelectedDistrict(districtName)
      setZoneActive(false)

      // Return instantly from session cache
      const cached = resultCache.current.get(districtName)
      if (cached) {
        setAnalysisResult(cached)
        setLoading(false)
        return
      }

      setLoading(true)
      setAnalysisResult(null)

      try {
        const ndviRes = await fetch('/api/ndvi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ districtName, bbox, polygonCoords }),
        })
        if (!ndviRes.ok) throw new Error(`NDVI API ${ndviRes.status}`)
        const ndviJson: NDVIResult = await ndviRes.json()

        setNdviData(prev => ({ ...prev, [districtName]: ndviJson.green_cover_pct }))

        const gemmaRes = await fetch('/api/analyse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ndviJson),
        })
        const gemmaJson: GemmaResponse = gemmaRes.ok
          ? await gemmaRes.json()
          : { analysis: 'Analysis unavailable — Gemma API error.', mode: ndviJson.barren_ha > 2 ? 'planting' : 'alternative' }

        const fullResult: FullResult = { ...ndviJson, ...gemmaJson }
        resultCache.current.set(districtName, fullResult)
        setAnalysisResult(fullResult)
      } catch (err) {
        console.error('[page] district analysis failed:', err)
        setAnalysisResult(null)
      } finally {
        setLoading(false)
      }
    },
    [loading]
  )

  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#f9fafb', overflow: 'hidden' }}>
      <HeroStats ndviData={ndviData} />

      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1fr 420px',
        gap: '16px',
        padding: '16px',
        minHeight: 0,
      }}>
        <div style={{ position: 'relative', minHeight: 0 }}>
          <DelhiMap
            onDistrictClick={handleDistrictClick}
            selectedDistrict={selectedDistrict}
            ndviData={ndviData}
            mapRef={mapRef}
            dimDistrict={zoneActive}
            gridCells={analysisResult?.grid_cells}
          />
        </div>

        <AnalysisPanel
          district={selectedDistrict}
          loading={loading}
          result={analysisResult}
          onZoneClick={handleZoneClick}
        />
      </div>
    </main>
  )
}
