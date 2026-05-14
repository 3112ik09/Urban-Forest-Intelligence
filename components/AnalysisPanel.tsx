import type { NDVIResult } from '@/pages/api/ndvi'
import type { GemmaResponse, VerifiedZone } from '@/lib/gemma'
import PlantingCards from './PlantingCards'
import AlternativeCards from './AlternativeCards'
import ReportDownload from './ReportDownload'

type FullResult = NDVIResult & GemmaResponse

interface Props {
  district: string | null
  loading: boolean
  result: FullResult | null
  onZoneClick?: (zone: VerifiedZone) => void
}

const STAT_COLOR = (label: string, value: number) => {
  if (label === 'Green cover') {
    return value >= 35 ? '#16a34a' : value >= 15 ? '#d97706' : '#dc2626'
  }
  if (label === 'Est. temp') return '#dc2626'
  if (label === 'Planting score') return value >= 50 ? '#16a34a' : value >= 30 ? '#d97706' : '#6b7280'
  return '#6b7280'
}

export default function AnalysisPanel({ district, loading, result, onZoneClick }: Props) {
  if (!district) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', background: 'white', borderRadius: '12px',
        border: '1px solid #e5e7eb', color: '#9ca3af', fontSize: '14px',
        textAlign: 'center', padding: '24px', lineHeight: 1.6,
      }}>
        Click any district on the map to analyse its tree canopy and get Gemma 4 recommendations
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
          Delhi NCT · Satellite analysis
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ padding: '32px', textAlign: 'center', color: '#6b7280', fontSize: '13px', lineHeight: 1.8 }}>
          <div style={{ marginBottom: '8px' }}>Fetching satellite data from Google Earth Engine…</div>
          <div>Gemma 4 is analysing this district</div>
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <>
          {/* Key stats */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: '16px' }}>
            {([
              { label: 'Green cover',    value: result.green_cover_pct,  display: `${result.green_cover_pct}%` },
              { label: 'Est. temp',      value: result.estimated_temp_c, display: `${result.estimated_temp_c}°C` },
              { label: 'Built-up',       value: result.built_up_pct,     display: `${result.built_up_pct}%` },
              { label: 'Planting score', value: result.plantation_score, display: `${result.plantation_score}/100` },
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

          {/* Source badge */}
          {result.source === 'fallback' && (
            <div style={{
              margin: '-8px 16px 8px', fontSize: '11px', color: '#92400e',
              background: '#fef3c7', border: '1px solid #fcd34d',
              borderRadius: '6px', padding: '5px 10px',
            }}>
              GEE unavailable — showing estimated values
            </div>
          )}

          {/* Gemma analysis */}
          <div style={{ margin: '0 16px 16px', background: '#f5f3ff', borderRadius: '8px', overflow: 'hidden' }}>
            <div style={{
              background: '#ede9fe', padding: '8px 12px',
              fontSize: '11px', fontWeight: 600, color: '#5b21b6',
            }}>
              Gemma 4 — satellite analysis
            </div>
            <div style={{ padding: '12px', fontSize: '12px', color: '#374151', lineHeight: 1.7 }}>
              {result.analysis}
            </div>
          </div>

          {/* Cards branch */}
          {result.mode === 'planting'
            ? <PlantingCards result={result} onZoneClick={onZoneClick} />
            : <AlternativeCards result={result} />
          }

          <ReportDownload district={district} result={result} />
        </>
      )}
    </div>
  )
}
