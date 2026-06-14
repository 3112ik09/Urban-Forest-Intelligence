'use client'
import { IconTrees, IconSparkles } from '@tabler/icons-react'

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

  const cards = [
    { border: '#EF9F27', label: 'Heat gap',  value: '+5.8°C',         sub: 'low vs high canopy' },
    { border: '#378ADD', label: 'Districts', value: totalDistricts && totalDistricts > 1 ? `${analysed} / ${totalDistricts}` : String(analysed), sub: districtSub },
    { border: '#E24B4A', label: 'Critical',  value: String(hotZones), sub: 'canopy < 15%' },
  ]

  return (
    <>
      <style>{`
        .hero-header {
          background: white;
          border-bottom: 0.5px solid #e5e7eb;
          padding: 1rem 1.5rem;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 24px;
          flex-wrap: wrap;
        }
        .hero-title-text {
          font-size: 26px;
          font-weight: 700;
          color: #111827;
          white-space: nowrap;
          letter-spacing: -0.4px;
        }
        .hero-stats-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
          margin-left: auto;
        }
        @media (max-width: 640px) {
          .hero-header { padding: 0.6rem 1rem; gap: 8px; }
          .hero-title-text { font-size: 18px; }
          .hero-stats-grid { grid-template-columns: repeat(3, 1fr); margin-left: 0; gap: 6px; width: 100%; }
        }
      `}</style>
      <div className="hero-header">
        {/* Left — title lockup */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '0 0 auto' }}>
          <IconTrees size={24} color="#3B6D11" stroke={1.75} />
          <span className="hero-title-text">
            Urban Forest Intelligence
          </span>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            background: '#EAF3DE', color: '#3B6D11',
            padding: '3px 9px', borderRadius: '20px',
            fontSize: '10px', fontWeight: 500, whiteSpace: 'nowrap',
          }}>
            <IconSparkles size={11} stroke={2} />
            Powered by Gemma 4
          </div>
        </div>

        {/* Right — stat cards */}
        <div className="hero-stats-grid">
          {cards.map(card => (
            <div
              key={card.label}
              style={{
                background: '#f9fafb',
                borderRadius: '8px',
                padding: '10px 14px',
                borderLeft: `3px solid ${card.border}`,
              }}
            >
              <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' }}>
                {card.label}
              </div>
              <div style={{ fontSize: '22px', fontWeight: 500, color: '#111827', lineHeight: 1.1 }}>
                {card.value}
              </div>
              <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '1px' }}>
                {card.sub}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
