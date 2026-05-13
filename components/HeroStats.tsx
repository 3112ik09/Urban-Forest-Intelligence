interface Props {
  ndviData: Record<string, number> // districtName -> canopy_pct
}

export default function HeroStats({ ndviData }: Props) {
  const analysed = Object.keys(ndviData).length
  const hotZones = Object.values(ndviData).filter(v => v < 15).length

  return (
    <div style={{
      background: 'white', borderBottom: '1px solid #e5e7eb',
      padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '32px',
      flexShrink: 0,
    }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '18px', fontWeight: 700, color: '#111827', whiteSpace: 'nowrap' }}>
          Delhi Urban Forest Intelligence
        </span>
        <span style={{
          fontSize: '11px', background: '#dcfce7', color: '#166534',
          padding: '3px 10px', borderRadius: '20px', fontWeight: 500, whiteSpace: 'nowrap',
        }}>
          Gemma 4 · Global Resilience
        </span>
      </div>

      {/* Stats */}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: '32px' }}>
        {[
          { label: 'Avg heat difference', value: '+5.8°C', sub: 'low vs high canopy zones' },
          { label: 'Districts analysed',  value: String(analysed), sub: analysed === 0 ? 'click map to begin' : `of 11 total` },
          { label: 'Critical heat zones', value: String(hotZones), sub: 'canopy < 15%' },
        ].map(s => (
          <div key={s.label} style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '11px', color: '#9ca3af' }}>{s.label}</div>
            <div style={{
              fontSize: '22px', fontWeight: 700, lineHeight: 1.1,
              color: s.label === 'Critical heat zones' && hotZones > 0 ? '#dc2626' : '#111827',
            }}>
              {s.value}
            </div>
            <div style={{ fontSize: '10px', color: '#d1d5db' }}>{s.sub}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
