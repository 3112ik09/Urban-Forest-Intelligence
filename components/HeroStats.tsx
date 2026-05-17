interface Props {
  ndviData: Record<string, number>
  cityName?: string
  totalDistricts?: number
}

export default function HeroStats({ ndviData, cityName, totalDistricts }: Props) {
  const analysed = Object.keys(ndviData).length
  const hotZones = Object.values(ndviData).filter(v => v < 15).length

  const districtSub = analysed === 0
    ? 'click map to begin'
    : totalDistricts && totalDistricts > 1
      ? `of ${totalDistricts} total`
      : 'analysed'

  return (
    <div style={{
      background: 'white', borderBottom: '1px solid #e5e7eb',
      padding: '10px 16px 8px', flexShrink: 0,
    }}>
      {/* Row 1 — Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <span style={{ fontSize: '22px', fontWeight: 700, color: '#111827', whiteSpace: 'nowrap', letterSpacing: '-0.3px' }}>
          Urban Forest Intelligence
        </span>
        <span style={{
          fontSize: '10px', background: '#dcfce7', color: '#166534',
          padding: '2px 8px', borderRadius: '20px', fontWeight: 500, whiteSpace: 'nowrap',
        }}>
          Gemma 4
        </span>
      </div>

      {/* Row 2 — Stats */}
      <div style={{ display: 'flex', gap: '28px' }}>
        {[
          { label: 'Urban heat gap',      value: '+5.8°C', sub: 'low vs high canopy districts',       hot: false },
          { label: 'Districts analysed',  value: String(analysed), sub: districtSub,                  hot: false },
          { label: 'Critical heat zones', value: String(hotZones), sub: 'canopy below 15%',            hot: hotZones > 0 },
        ].map(s => (
          <div key={s.label}>
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '1px' }}>{s.label}</div>
            <div style={{
              fontSize: '20px', fontWeight: 700, lineHeight: 1.1,
              color: s.hot ? '#dc2626' : '#111827',
            }}>
              {s.value}
            </div>
            <div style={{ fontSize: '10px', color: '#9ca3af' }}>{s.sub}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
