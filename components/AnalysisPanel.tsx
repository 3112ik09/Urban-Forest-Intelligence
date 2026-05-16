import type { NDVIResult } from '@/pages/api/ndvi'
import type { GemmaResponse, VerifiedZone } from '@/lib/gemma'
import PlantingCards from './PlantingCards'
import AlternativeCards from './AlternativeCards'
import ReportDownload from './ReportDownload'

type FullResult = NDVIResult & GemmaResponse

interface Props {
  district: string | null
  loading: boolean
  loadingStep?: number
  result: FullResult | null
  partialResult?: NDVIResult | null
  onZoneClick?: (zone: VerifiedZone) => void
  cityName?: string
}

const PIPELINE_STEPS = [
  'Connecting to Earth Engine',
  'Scanning land cover bands',
  'Discovering planting zones',
  'Ranking sites with Gemma vision',
  'Writing AI policy brief',
]

const STAT_COLOR = (label: string, value: number) => {
  if (label === 'Green cover') {
    return value >= 35 ? '#16a34a' : value >= 15 ? '#d97706' : '#dc2626'
  }
  if (label === 'Est. temp') return '#dc2626'
  if (label === 'Planting score') return value >= 50 ? '#16a34a' : value >= 30 ? '#d97706' : '#6b7280'
  return '#6b7280'
}

export default function AnalysisPanel({ district, loading, loadingStep = 1, result, partialResult, onZoneClick, cityName }: Props) {
  const showStats = loading && (loadingStep ?? 0) >= 3 && !!partialResult
  const statsData: NDVIResult | null = result ?? (showStats ? partialResult! : null)
  const hasZones = (statsData?.verified_zones?.length ?? 0) > 0
  const showBriefSkeleton = loading && (loadingStep ?? 0) >= 5 && hasZones
  const derivedMode: 'planting' | 'alternative' =
    result?.mode ?? (statsData && statsData.barren_ha > 2 ? 'planting' : 'alternative')

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
      {/* Header */}
      <div style={{ padding: '16px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>{district}</h2>
        <p style={{ fontSize: '12px', color: '#6b7280', margin: '4px 0 0' }}>
          {cityName ?? 'Satellite analysis'}
        </p>
      </div>

      {/* Loading — pipeline steps */}
      {loading && (
        <div style={{ padding: '24px 20px' }}>
          <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Analysing district…
          </div>
          {PIPELINE_STEPS.map((label, i) => {
            const step = i + 1
            const done = step < loadingStep
            const active = step === loadingStep
            return (
              <div key={step} style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                marginBottom: '14px',
                opacity: done || active ? 1 : 0.3,
                transition: 'opacity 0.4s ease',
              }}>
                {/* Icon */}
                {done ? (
                  <div style={{
                    width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
                    background: '#dcfce7', border: '1.5px solid #86efac',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '11px', color: '#16a34a', fontWeight: 700,
                  }}>✓</div>
                ) : active ? (
                  <div style={{
                    width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
                    border: '2px solid #bfdbfe', borderTopColor: '#2563eb',
                    animation: 'step-spin 0.7s linear infinite',
                  }} />
                ) : (
                  <div style={{
                    width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
                    background: '#f3f4f6', border: '1.5px solid #e5e7eb',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '11px', color: '#9ca3af',
                  }}>{step}</div>
                )}
                {/* Label */}
                <span style={{
                  fontSize: '13px',
                  color: done ? '#16a34a' : active ? '#1d4ed8' : '#6b7280',
                  fontWeight: active ? 600 : 400,
                }}>
                  {label}
                </span>
              </div>
            )
          })}
        </div>
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
            </div>
          ))}
        </div>
      )}

      {/* Source badge — only when complete */}
      {!loading && result?.source === 'fallback' && (
        <div style={{
          margin: '-8px 16px 8px', fontSize: '11px', color: '#92400e',
          background: '#fef3c7', border: '1px solid #fcd34d',
          borderRadius: '6px', padding: '5px 10px',
        }}>
          GEE unavailable — showing estimated values
        </div>
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
          ? <PlantingCards result={statsData as FullResult} onZoneClick={statsData?.source !== 'fallback' ? onZoneClick : undefined} />
          : <AlternativeCards result={statsData} />
      )}

      {/* Report download — only when complete */}
      {result && !loading && (
        <ReportDownload district={district} result={result} />
      )}
    </div>
  )
}
