'use client'
import { useState, useCallback, useRef, useEffect } from 'react'
import dynamic from 'next/dynamic'
import type { Map as LeafletMap, Marker } from 'leaflet'
import HeroStats from '@/components/HeroStats'
import AnalysisPanel from '@/components/AnalysisPanel'
import type { NDVIResult } from '@/pages/api/ndvi'
import type { GemmaResponse, VerifiedZone } from '@/lib/gemma'
import {
  geocodeCity, fetchCityDistricts, getCityBoundaryGeoJSON,
  type GeocodedCity, type CityDistrict,
} from '@/lib/geocoding'
import { type LangCode } from '@/lib/gemma'

// Leaflet must be client-side only
const CityMap = dynamic(() => import('@/components/CityMap'), { ssr: false })

export type FullResult = NDVIResult & GemmaResponse

export default function Home() {
  // ── City search ───────────────────────────────────────────────────────────
  const [cityInput, setCityInput] = useState('')
  const [currentCity, setCurrentCity] = useState<GeocodedCity | null>(null)
  const [cityDistricts, setCityDistricts] = useState<CityDistrict[]>([])
  const [cityBoundary, setCityBoundary] = useState<GeoJSON.FeatureCollection | null>(null)
  const [geocoding, setGeocoding] = useState(false)
  const [geocodeError, setGeocodeError] = useState<string | null>(null)

  // ── Analysis state ────────────────────────────────────────────────────────
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [ndviData, setNdviData] = useState<Record<string, number>>({})
  const [analysisResult, setAnalysisResult] = useState<FullResult | null>(null)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [partialNdvi, setPartialNdvi] = useState<NDVIResult | null>(null)
  const [zoneActive, setZoneActive] = useState(false)
  const [imagesCurrent, setImagesCurrent] = useState(0)
  const [imagesTotal, setImagesTotal] = useState(0)
  const [estimatedSecsRemaining, setEstimatedSecsRemaining] = useState(59)

  const [reportLanguage, setReportLanguage] = useState<LangCode>('en')
  const reportLanguageRef = useRef<LangCode>('en')

  const mapRef = useRef<LeafletMap | null>(null)
  const zoneMarkerRef = useRef<Marker | null>(null)
  const resultCache = useRef<Map<string, FullResult>>(new Map())
  const abortRef = useRef<AbortController | null>(null)
  const stepTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const currentCityRef = useRef<GeocodedCity | null>(null)
  // ── City search handler ───────────────────────────────────────────────────
  const handleCitySearch = useCallback(async () => {
    const input = cityInput.trim()
    if (!input) return

    setGeocodeError(null)
    setGeocoding(true)
    setSelectedDistrict(null)
    setAnalysisResult(null)
    setPartialNdvi(null)
    setNdviData({})
    setZoneActive(false)

    // Cancel any in-flight analysis
    if (abortRef.current) abortRef.current.abort()
    stepTimers.current.forEach(clearTimeout)
    stepTimers.current = []

    try {
      const city = await geocodeCity(input)
      if (!city) {
        setGeocodeError('City not found — try a more specific name')
        return
      }

      setCurrentCity(city)
      currentCityRef.current = city

      // Fetch districts and boundary in parallel
      const [districts, boundary] = await Promise.all([
        fetchCityDistricts(input, city),
        getCityBoundaryGeoJSON(city.osmType, city.osmId),
      ])

      // If Overpass returned no districts, treat the whole city as one district
      const finalDistricts: CityDistrict[] = districts.length > 0
        ? districts
        : [{
            name: city.displayName.split(',')[0].trim(),
            bbox: city.bbox,
            center: {
              lat: (city.bbox[1] + city.bbox[3]) / 2,
              lon: (city.bbox[0] + city.bbox[2]) / 2,
            },
            polygon: [
              [city.bbox[0], city.bbox[1]],
              [city.bbox[2], city.bbox[1]],
              [city.bbox[2], city.bbox[3]],
              [city.bbox[0], city.bbox[3]],
              [city.bbox[0], city.bbox[1]],
            ],
          }]

      setCityDistricts(finalDistricts)
      setCityBoundary(boundary)
    } catch (err) {
      console.error('[page] city search failed:', err)
      setGeocodeError('Search failed — please try again')
    } finally {
      setGeocoding(false)
    }
  }, [cityInput])

  const handleSetLanguage = useCallback((lang: LangCode) => {
    reportLanguageRef.current = lang
    setReportLanguage(lang)
  }, [])

  // ── Zone click → fly map to zone ─────────────────────────────────────────
  const handleZoneClick = useCallback(async (zone: VerifiedZone) => {
    if (!mapRef.current) return

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
  }, [])

  // ── District click → run analysis pipeline ────────────────────────────────
  const handleDistrictClick = useCallback(async (district: CityDistrict) => {
    // Cancel any in-flight request and its pending step timers
    if (abortRef.current) abortRef.current.abort()
    stepTimers.current.forEach(clearTimeout)
    stepTimers.current = []

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const districtName = district.name
    const bbox = district.bbox
    const city = currentCityRef.current

    setSelectedDistrict(districtName)
    setZoneActive(false)
    setPartialNdvi(null)
    setImagesCurrent(0)
    setImagesTotal(0)
    setEstimatedSecsRemaining(59)

    // Return instantly from session cache
    const cacheKey = `${city?.osmId ?? 'local'}:${districtName}`
    const cached = resultCache.current.get(cacheKey)
    if (cached) {
      setAnalysisResult(cached)
      setLoading(false)
      setLoadingStep(0)
      return
    }

    setLoading(true)
    setLoadingStep(1)
    setAnalysisResult(null)
    setAnalysisError(null)

    // Advance through steps during the long ndvi call (steps 1-4 are simulated)
    stepTimers.current = [
      setTimeout(() => setLoadingStep(s => Math.max(s, 2)), 5000),
      setTimeout(() => setLoadingStep(s => Math.max(s, 3)), 11000),
      setTimeout(() => setLoadingStep(s => Math.max(s, 4)), 17000),
    ]

    try {
      const ndviRes = await fetch('/api/ndvi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          districtName,
          bbox,
          districtPolygon: district.polygon,
          cityName: city?.displayName.split(',')[0].trim() ?? districtName,
          language: reportLanguageRef.current,
        }),
        signal: ctrl.signal,
      })
      if (!ndviRes.ok) throw new Error(`NDVI API ${ndviRes.status}`)

      // Read NDJSON stream: 'stats' chunk arrives after Phase 1, 'result' after Phase 4b
      const reader = ndviRes.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let ndviJson: NDVIResult | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (value) buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line) continue
          const chunk = JSON.parse(line) as {
            type: string; reason?: string
            current?: number; total?: number
            step?: number; stepLabel?: string; estimatedSecondsRemaining?: number
          } & NDVIResult

          if (chunk.type === 'error') {
            stepTimers.current.forEach(clearTimeout)
            stepTimers.current = []
            setAnalysisError(chunk.reason ?? 'Analysis failed — please try again.')
            setLoading(false)
            setLoadingStep(0)
            return
          } else if (chunk.type === 'step_change') {
            setLoadingStep(s => Math.max(s, chunk.step ?? 0))
            if (chunk.estimatedSecondsRemaining != null) {
              setEstimatedSecsRemaining(chunk.estimatedSecondsRemaining)
            }
          } else if (chunk.type === 'image_progress') {
            setImagesCurrent(chunk.current ?? 0)
            setImagesTotal(chunk.total ?? 0)
            setLoadingStep(s => Math.max(s, 4))
          } else if (chunk.type === 'stats') {
            stepTimers.current.forEach(clearTimeout)
            stepTimers.current = [
              setTimeout(() => setLoadingStep(s => Math.max(s, 4)), 6000),
            ]
            setPartialNdvi(chunk)
            setLoadingStep(s => Math.max(s, 3))
          } else if (chunk.type === 'result') {
            stepTimers.current.forEach(clearTimeout)
            stepTimers.current = []
            ndviJson = chunk
            setPartialNdvi(chunk)
            setNdviData(prev => ({ ...prev, [districtName]: chunk.green_cover_pct }))
            // Use Math.max so a backend step_change(7) before result is not overwritten
            setLoadingStep(s => Math.max(s, 5))
          }
        }
        if (done) break
      }

      if (!ndviJson) throw new Error('NDVI stream ended without result')

      const gemmaRes = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...ndviJson,
          cityName: city?.displayName.split(',')[0].trim() ?? districtName,
          language: reportLanguageRef.current,
        }),
        signal: ctrl.signal,
      })
      const gemmaJson: GemmaResponse = gemmaRes.ok
        ? await gemmaRes.json()
        : { analysis: 'Analysis unavailable — Gemma API error.', mode: ndviJson.barren_ha > 2 ? 'planting' : 'alternative' }

      const fullResult: FullResult = { ...ndviJson, ...gemmaJson }
      resultCache.current.set(cacheKey, fullResult)
      setAnalysisResult(fullResult)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      console.error('[page] district analysis failed:', err)
      setAnalysisResult(null)
    } finally {
      if (abortRef.current === ctrl) {
        stepTimers.current.forEach(clearTimeout)
        stepTimers.current = []
        setLoading(false)
        setLoadingStep(0)
      }
    }
  }, [])

  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#f9fafb', overflow: 'hidden' }}>
      <HeroStats
        ndviData={ndviData}
        cityName={currentCity?.displayName.split(',')[0].trim()}
        totalDistricts={cityDistricts.length}
      />

      {/* City search bar */}
      <div style={{
        background: 'white', borderBottom: '1px solid #e5e7eb',
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0,
      }}>
        <input
          type="text"
          value={cityInput}
          onChange={e => setCityInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCitySearch()}
          placeholder="Enter any city — Delhi, Mumbai, London, Nairobi…"
          style={{
            flex: 1, padding: '8px 12px', fontSize: '13px',
            border: '1px solid #e5e7eb', borderRadius: '8px',
            outline: 'none', color: '#111827',
          }}
        />
        <button
          onClick={handleCitySearch}
          disabled={geocoding || !cityInput.trim()}
          style={{
            padding: '8px 18px', fontSize: '13px', fontWeight: 600,
            background: geocoding ? '#f3f4f6' : '#16a34a',
            color: geocoding ? '#9ca3af' : 'white',
            border: 'none', borderRadius: '8px', cursor: geocoding ? 'wait' : 'pointer',
            whiteSpace: 'nowrap', transition: 'background 0.15s',
          }}
        >
          {geocoding ? 'Searching…' : 'Analyse'}
        </button>
        {geocodeError && (
          <span style={{ fontSize: '12px', color: '#dc2626' }}>{geocodeError}</span>
        )}
        {currentCity && !geocoding && (() => {
          const parts = currentCity.displayName.split(',')
          const resolvedName = parts.length > 1
            ? `${parts[0].trim()}, ${parts[parts.length - 1].trim()}`
            : parts[0].trim()
          return (
            <span style={{ fontSize: '12px', color: '#6b7280', whiteSpace: 'nowrap', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <span style={{ color: '#374151', fontWeight: 500 }}>{resolvedName}</span>
              {' · '}{cityDistricts.length} district{cityDistricts.length !== 1 ? 's' : ''}
            </span>
          )
        })()}
      </div>

      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1fr 420px',
        gap: '16px',
        padding: '16px',
        minHeight: 0,
      }}>
        <div style={{ position: 'relative', minHeight: 0 }}>
          <CityMap
            districts={cityDistricts}
            cityBoundary={cityBoundary}
            onDistrictClick={handleDistrictClick}
            selectedDistrict={selectedDistrict}
            ndviData={ndviData}
            mapRef={mapRef}
            dimDistrict={zoneActive}
          />
          {/* Hint — appears once districts load, disappears on first click */}
          {cityDistricts.length > 0 && !selectedDistrict && !loading && (
            <div style={{
              position: 'absolute', bottom: '90px', left: '50%',
              transform: 'translateX(-50%)', zIndex: 1000, pointerEvents: 'none',
            }}>
              <div style={{
                background: 'rgba(255,255,255,0.96)',
                borderRadius: '10px', padding: '9px 18px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.13)',
                border: '1px solid #e5e7eb',
                display: 'flex', alignItems: 'center', gap: '10px',
                whiteSpace: 'nowrap',
              }}>
                <span className="animate-pulse" style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: '#16a34a', flexShrink: 0, display: 'inline-block',
                }} />
                <span style={{ fontSize: '13px', color: '#374151', fontWeight: 500 }}>
                  Click any district on the map to begin satellite analysis
                </span>
              </div>
            </div>
          )}
        </div>

        <AnalysisPanel
          district={selectedDistrict}
          loading={loading}
          loadingStep={loadingStep}
          result={analysisResult}
          partialResult={partialNdvi}
          error={analysisError}
          onZoneClick={handleZoneClick}
          cityName={currentCity?.displayName.split(',')[0].trim()}
          imagesCurrent={imagesCurrent}
          imagesTotal={imagesTotal}
          estimatedSecsRemaining={estimatedSecsRemaining}
          language={reportLanguage}
          onLanguageChange={handleSetLanguage}
        />
      </div>
    </main>
  )
}
