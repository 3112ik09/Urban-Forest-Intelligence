import type { NDVIResult } from '@/pages/api/ndvi'

const STRATEGIES = [
  { key: 'available_rooftops', title: 'Rooftop greening',      unit: 'rooftops', cooling: '−2.8°C', bg: '#dcfce7', fg: '#166534' },
  { key: 'road_km',            title: 'Roadside planting',     unit: 'km of roads', cooling: '−1.6°C', bg: '#dbeafe', fg: '#1e40af' },
  { key: 'wall_count',         title: 'Vertical wall gardens', unit: 'walls',    cooling: '−0.9°C', bg: '#e0f2fe', fg: '#0369a1' },
  { key: 'parking_lots',       title: 'Parking lot greening',  unit: 'lots',     cooling: '−0.7°C', bg: '#fef3c7', fg: '#92400e' },
] as const

export default function AlternativeCards({ result }: { result: NDVIResult }) {
  return (
    <div style={{ padding: '0 16px 16px' }}>
      <div style={{
        background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px',
        padding: '10px 12px', marginBottom: '12px', fontSize: '12px', color: '#92400e',
      }}>
        No significant barren land found — showing alternative greening strategies for this dense urban zone
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        {STRATEGIES.map(s => (
          <div key={s.key} style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#111827', marginBottom: '4px' }}>
              {s.title}
            </div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '6px' }}>
              {(result[s.key] as number).toLocaleString()} {s.unit}
            </div>
            <div style={{
              fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
              display: 'inline-block', background: s.bg, color: s.fg,
            }}>
              Est. {s.cooling}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
