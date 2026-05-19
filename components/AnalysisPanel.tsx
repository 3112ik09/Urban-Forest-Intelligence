'use client'
import { useRef } from 'react'
import type { NDVIResult } from '@/pages/api/ndvi'
import type { GemmaResponse, VerifiedZone, LangCode } from '@/lib/gemma'
import { buildAlternativeStrategies } from '@/lib/alternativeStrategies'
import PlantingCards from './PlantingCards'
import AlternativeCards from './AlternativeCards'
import AlternativeStrategiesPanel from './AlternativeStrategiesPanel'
import NoZonesState from './NoZonesState'
import ReportDownload from './ReportDownload'
import ProgressPanel from './ProgressPanel'

type FullResult = NDVIResult & GemmaResponse

interface Props {
  district: string | null
  loading: boolean
  loadingStep?: number
  result: FullResult | null
  partialResult?: NDVIResult | null
  error?: string | null
  onZoneClick?: (zone: VerifiedZone) => void
  cityName?: string
  imagesCurrent?: number
  imagesTotal?: number
  estimatedSecsRemaining?: number
  language?: LangCode
  onLanguageChange?: (lang: LangCode) => void
}

// Step durations for pct calculation (must match ProgressPanel.tsx)
const STEP_DURATIONS = [4, 7, 6, 30, 8, 10, 6]
const TOTAL_DURATION = 71

function computePct(step: number, imagesCurrent: number, imagesTotal: number): number {
  const completed = STEP_DURATIONS.slice(0, step - 1).reduce((a, b) => a + b, 0)
  if (step === 4 && imagesTotal > 0) {
    const within = (imagesCurrent / imagesTotal) * STEP_DURATIONS[3]
    return Math.round(Math.min(100, ((completed + within) / TOTAL_DURATION) * 100))
  }
  return Math.round((completed / TOTAL_DURATION) * 100)
}

const STEP_LABELS: Record<number, string> = {
  1: 'Connecting to Earth Engine',
  2: 'Scanning land cover bands',
  3: 'Discovering planting candidates',
  4: 'Agent 1 — reviewing satellite imagery',
  5: 'Spatial validator — checking constraints',
  6: 'Agent 2 — creating planting plans',
  7: 'Writing AI policy brief',
}

// Seconds remaining when each step starts
const STEP_REMAINING: Record<number, number> = {
  1: 59, 2: 55, 3: 48, 4: 42, 5: 24, 6: 16, 7: 6,
}

const STAT_COLOR = (label: string, value: number) => {
  if (label === 'Green cover') {
    return value >= 35 ? '#16a34a' : value >= 15 ? '#d97706' : '#dc2626'
  }
  if (label === 'Est. temp') return '#dc2626'
  if (label === 'Planting score') return value >= 50 ? '#16a34a' : value >= 30 ? '#d97706' : '#6b7280'
  return '#6b7280'
}

const STAT_SUB: Record<string, string> = {
  'Green cover':    '% of area with tree canopy',
  'Est. temp':      'Based on canopy + built-up %',
  'Built-up':       '% impervious surface',
  'Planting score': 'Space available for new trees',
}

export default function AnalysisPanel({ district, loading, loadingStep = 1, result, partialResult, error, onZoneClick, cityName, imagesCurrent = 0, imagesTotal = 0, estimatedSecsRemaining, language = 'en', onLanguageChange }: Props) {
  const altStrategiesRef = useRef<HTMLDivElement>(null)

  const showStats = loading && (loadingStep ?? 0) >= 3 && !!partialResult
  const statsData: NDVIResult | null = result ?? (showStats ? partialResult! : null)
  const hasZones = (statsData?.verified_zones?.length ?? 0) > 0
  const showBriefSkeleton = loading && (loadingStep ?? 0) >= 7 && hasZones
  const derivedMode: 'planting' | 'alternative' =
    result?.mode ?? (statsData && statsData.barren_ha > 2 ? 'planting' : 'alternative')
  const noZones = result != null && (result.verified_zones?.length ?? 0) === 0
  const showAltStrategies = result != null && (result.barren_ha < 5 || result.built_up_pct > 65 || noZones)

  const noZonesReason = (noZones && result)
    ? (result.built_up_pct > 65 ? 'too_dense' as const
      : result.green_cover_pct > 35 && result.barren_ha < 2 ? 'high_canopy' as const
      : result.barren_ha < 2 ? 'no_bare_land' as const
      : 'fallback' as const)
    : 'fallback' as const
  const noZonesStrategies = (noZones && result) ? buildAlternativeStrategies(result) : []
  const noZonesTotalCooling = noZonesStrategies.reduce((acc, s) => acc + s.coolingC, 0)

  if (!district) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', background: 'white', borderRadius: '12px',
        border: '1px solid #e5e7eb', color: '#9ca3af', fontSize: '14px',
        textAlign: 'center', padding: '24px', lineHeight: 1.6,
      }}>
        {cityName
          ? `Click a district on the map to analyse ${cityName}`
          : 'Click any district on the map to analyse its tree canopy and get Gemma 4 recommendations'
        }
      </div>
    )
  }

  return (
    <div style={{
      background: 'white', borderRadius: '12px', border: '1px solid #e5e7eb',
      overflowY: 'auto', display: 'flex', flexDirection: 'column',
    }}>
      {/* Header — hidden while ProgressPanel renders its own */}
      {!loading && (
        <div style={{ padding: '16px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>{district}</h2>
          <p style={{ fontSize: '12px', color: '#6b7280', margin: '4px 0 0' }}>
            {cityName ?? 'Satellite analysis'}
          </p>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div style={{ padding: '24px 20px' }}>
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px',
            padding: '14px 16px',
          }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#991b1b', marginBottom: '6px' }}>
              Analysis could not complete
            </div>
            <div style={{ fontSize: '12px', color: '#7f1d1d', lineHeight: 1.6 }}>
              {error}
            </div>
          </div>
        </div>
      )}

      {/* Loading — ProgressPanel */}
      {loading && (
        <ProgressPanel
          district={district ?? ''}
          cityName={cityName}
          currentStep={loadingStep}
          stepLabel={STEP_LABELS[loadingStep] ?? ''}
          imagesCurrent={imagesCurrent}
          imagesTotal={imagesTotal}
          estimatedSecsRemaining={estimatedSecsRemaining ?? STEP_REMAINING[loadingStep] ?? 59}
          pct={computePct(loadingStep, imagesCurrent, imagesTotal)}
        />
      )}

      {/* Key stats — shown as soon as Phase 1 (land cover bands) completes */}
      {statsData && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: (showStats && !result) ? '0 16px 16px' : '16px' }}>
          {([
            { label: 'Green cover',    value: statsData.green_cover_pct,  display: `${statsData.green_cover_pct}%` },
            { label: 'Est. temp',      value: statsData.estimated_temp_c, display: `${statsData.estimated_temp_c}°C` },
            { label: 'Built-up',       value: statsData.built_up_pct,     display: `${statsData.built_up_pct}%` },
            { label: 'Planting score', value: statsData.plantation_score, display: `${statsData.plantation_score}/100` },
          ] as const).map(s => (
            <div key={s.label} style={{
              background: '#f9fafb', borderRadius: '8px', padding: '10px', textAlign: 'center',
            }}>
              <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px' }}>{s.label}</div>
              <div style={{ fontSize: '20px', fontWeight: 600, color: STAT_COLOR(s.label, s.value) }}>
                {s.display}
              </div>
              <div style={{ fontSize: '9px', color: '#d1d5db', marginTop: '2px', lineHeight: 1.3 }}>
                {STAT_SUB[s.label]}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* No-zones state — replaces old source badge; shown when analysis completes with zero planting zones */}
      {!loading && noZones && result && (
        <NoZonesState
          districtName={district ?? ''}
          greenCoverPct={result.green_cover_pct}
          builtUpPct={result.built_up_pct}
          estTempC={result.estimated_temp_c}
          reason={noZonesReason}
          totalCooling={noZonesTotalCooling}
          strategyCount={noZonesStrategies.length}
          language={language}
          onScrollToStrategies={() => altStrategiesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        />
      )}

      {/* Zone discovery placeholder — while waiting for zones (step 3 active, no zones yet) */}
      {loading && showStats && !hasZones && (
        <div style={{
          margin: '0 16px 12px', background: '#f0fdf4', borderRadius: '8px',
          padding: '10px 12px', fontSize: '12px', color: '#166534',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          <div style={{
            width: '14px', height: '14px', borderRadius: '50%', flexShrink: 0,
            border: '2px solid #86efac', borderTopColor: '#16a34a',
            animation: 'step-spin 0.7s linear infinite',
          }} />
          Scanning satellite imagery for planting zones…
        </div>
      )}

      {/* Alternative strategies — shown when barren_ha < 5, built_up > 65, or no zones found */}
      {showAltStrategies && (
        <div ref={altStrategiesRef}>
          <AlternativeStrategiesPanel
            result={result!}
            districtName={district ?? ''}
            cityName={cityName ?? ''}
            noZones={noZones}
            language={language}
          />
        </div>
      )}

      {/* Divider between alternative strategies and Gemma only when planting zones also exist */}
      {showAltStrategies && derivedMode === 'planting' && !noZones && (
        <div style={{ borderTop: '1px solid #f3f4f6', margin: '0 16px 12px' }} />
      )}

      {/* Gemma analysis — skeleton during step 5 (zones ready, brief not yet), real text when done */}
      {(result || showBriefSkeleton) && (
        <div style={{ margin: '0 16px 16px', background: '#f5f3ff', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{
            background: '#ede9fe', padding: '8px 12px',
            fontSize: '11px', fontWeight: 600, color: '#5b21b6',
          }}>
            Gemma 4 — {showBriefSkeleton ? 'writing policy brief…' : 'satellite analysis'}
          </div>
          {result ? (
            <div style={{ padding: '12px', fontSize: '12px', color: '#374151', lineHeight: 1.7 }}>
              {result.analysis}
            </div>
          ) : (
            <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {[90, 78, 62].map((w, i) => (
                <div key={i} style={{
                  height: '11px', background: '#d8b4fe', borderRadius: '3px', width: `${w}%`,
                  animation: `brief-pulse 1.4s ease-in-out ${i * 0.18}s infinite`,
                }} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Zone / alternative cards — shown once zones are discovered */}
      {statsData && hasZones && (
        derivedMode === 'planting'
          ? <PlantingCards result={statsData as FullResult} onZoneClick={onZoneClick} />
          : <AlternativeCards result={statsData} />
      )}

      {/* Report download — only when complete */}
      {result && !loading && (
        <ReportDownload district={district} result={result} language={language} onLanguageChange={onLanguageChange} />
      )}
    </div>
  )
}
