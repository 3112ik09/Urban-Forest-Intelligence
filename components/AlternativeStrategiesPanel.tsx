'use client'
import { useState } from 'react'
import { buildAlternativeStrategies, type AlternativeStrategy } from '@/lib/alternativeStrategies'
import type { NDVIResult } from '@/pages/api/ndvi'
import type { LangCode } from '@/lib/gemma'

const NO_ZONES_HEADER: Record<string, (name: string) => string> = {
  en: (name) => `Urban greening strategies for ${name}`,
  fr: (name) => `Stratégies de verdissement pour ${name}`,
  es: (name) => `Estrategias de revegetación para ${name}`,
  de: (name) => `Begrünungsstrategien für ${name}`,
  hi: (name) => `${name} के लिए हरित रणनीतियां`,
}

const NO_ZONES_SUBHEADER: Record<string, string> = {
  en: 'No ground planting available — these methods work within the existing built fabric',
  fr: "Aucune plantation au sol possible — ces méthodes s'intègrent dans le tissu bâti existant",
  es: 'Sin plantación en suelo posible — estos métodos se integran en el tejido urbano existente',
  de: 'Keine Bodenpflanzung möglich — diese Methoden integrieren sich in das bestehende Stadtgefüge',
  hi: 'भूमि रोपण संभव नहीं — ये विधियां मौजूदा शहरी ढांचे में काम करती हैं',
}

const BADGE: Record<string, { background: string; color: string; label: string }> = {
  high:   { background: '#FCEBEB', color: '#A32D2D', label: 'High priority' },
  medium: { background: '#FAEEDA', color: '#633806', label: 'Medium' },
  low:    { background: '#EAF3DE', color: '#27500A', label: 'Low' },
}

const FALLBACK_BG: Record<string, string> = {
  rooftop_greening:    '#dcfce7',
  roadside_tree_pits:  '#dbeafe',
  vertical_wall:       '#d1fae5',
  parking_desealing:   '#fef3c7',
  reflective_surfaces: '#fef9c3',
  permeable_pavement:  '#e0f2fe',
}

function FallbackSvg({ strategyKey }: { strategyKey: string }) {
  const bg = FALLBACK_BG[strategyKey] ?? '#f3f4f6'
  const iconPaths: Record<string, JSX.Element> = {
    rooftop_greening: (
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" strokeLinejoin="round"/>
    ),
    roadside_tree_pits: (
      <>
        <path d="M3 12h18M12 3v18"/>
        <path d="M8 7c1 1 3 2 4 2s3-1 4-2"/>
      </>
    ),
    vertical_wall: (
      <>
        <rect x="3" y="3" width="7" height="18" rx="1"/>
        <path d="M14 3c2 4 3 8 3 9s-1 5-3 9M17 8c2 1 3 2 3 4"/>
      </>
    ),
    parking_desealing: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>
      </>
    ),
    reflective_surfaces: (
      <>
        <circle cx="12" cy="12" r="5"/>
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
      </>
    ),
    permeable_pavement: (
      <>
        <path d="M12 2v6M12 16v6M4.93 4.93l4.24 4.24M14.83 14.83l4.24 4.24M2 12h6M16 12h6"/>
        <circle cx="12" cy="12" r="2"/>
      </>
    ),
  }
  return (
    <div style={{
      width: '96px', flexShrink: 0, background: bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      borderRadius: '8px 0 0 8px',
    }}>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round">
        {iconPaths[strategyKey] ?? <circle cx="12" cy="12" r="8"/>}
      </svg>
    </div>
  )
}

function StrategyCard({ s }: { s: AlternativeStrategy }) {
  const [imgErr, setImgErr] = useState(false)
  const badge = BADGE[s.priority] ?? BADGE.low

  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden',
      display: 'flex', minHeight: '90px',
    }}>
      {!imgErr ? (
        <img
          src={s.photo}
          alt={s.title}
          onError={() => setImgErr(true)}
          style={{ width: '96px', flexShrink: 0, objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <FallbackSvg strategyKey={s.key} />
      )}

      <div style={{ padding: '9px 12px', flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '3px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#111827', flex: 1, lineHeight: 1.3 }}>
            {s.title}
          </span>
          <span style={{
            fontSize: '10px', fontWeight: 600, padding: '1px 7px', borderRadius: '10px',
            background: badge.background, color: badge.color, flexShrink: 0, whiteSpace: 'nowrap',
          }}>
            {badge.label}
          </span>
        </div>

        <div style={{ fontSize: '11px', color: '#6b7280', lineHeight: 1.5, marginBottom: '5px' }}>
          {s.description}
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
          <span style={{ fontSize: '10px', color: '#374151' }}>🌡 −{s.coolingC.toFixed(1)}°C cooling</span>
          <span style={{ fontSize: '10px', color: '#374151' }}>🌳 ~{s.treesEquiv.toLocaleString()} trees equiv.</span>
          <span style={{ fontSize: '10px', color: '#374151' }}>{s.triggerLabel}</span>
        </div>

        <div style={{ fontSize: '10px', color: '#9ca3af' }}>
          Based on: {s.dataEvidence}
        </div>
      </div>
    </div>
  )
}

interface Props {
  result: NDVIResult
  districtName: string
  cityName: string
  noZones?: boolean
  language?: LangCode
}

export default function AlternativeStrategiesPanel({ result, districtName, noZones = false, language = 'en' }: Props) {
  const strategies = buildAlternativeStrategies(result)
  if (strategies.length === 0) return null

  const totalCooling = strategies.reduce((acc, s) => acc + s.coolingC, 0)
  const totalTrees = strategies.reduce((acc, s) => acc + s.treesEquiv, 0)
  const showAlert = !noZones && result.barren_ha < 5

  const lang = (language in NO_ZONES_HEADER) ? language : 'en'
  const headerText = noZones
    ? (NO_ZONES_HEADER[lang] ?? NO_ZONES_HEADER.en)(districtName)
    : 'Alternative urban greening strategies'
  const subheaderText = noZones ? (NO_ZONES_SUBHEADER[lang] ?? NO_ZONES_SUBHEADER.en) : null

  return (
    <div style={{ padding: '0 16px 4px' }}>
      {showAlert && (
        <div style={{
          background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px',
          padding: '9px 12px', marginBottom: '10px', fontSize: '12px', color: '#92400e',
        }}>
          Ground planting not feasible here. Combined impact: −{totalCooling.toFixed(1)}°C estimated cooling
        </div>
      )}

      <div style={{ marginBottom: '8px' }}>
        <div style={{
          fontSize: noZones ? '12px' : '11px', fontWeight: 600, color: '#374151',
          textTransform: noZones ? 'none' : 'uppercase',
          letterSpacing: noZones ? '0' : '0.5px',
        }}>
          {headerText}
        </div>
        {subheaderText && (
          <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '3px', lineHeight: 1.4 }}>
            {subheaderText}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {strategies.map(s => <StrategyCard key={s.key} s={s} />)}
      </div>

      <div style={{
        marginTop: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0',
        borderRadius: '8px', padding: '10px 14px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#166534' }}>
            Combined estimated impact · all {strategies.length} strategies
          </div>
          <div style={{ fontSize: '11px', color: '#15803d', marginTop: '2px' }}>
            ~{totalTrees.toLocaleString()} tree equivalents added to {districtName}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '10px' }}>
          <div style={{ fontSize: '9px', color: '#6b7280', marginBottom: '2px' }}>surface temp reduction</div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#16a34a' }}>
            −{totalCooling.toFixed(1)}°C
          </div>
        </div>
      </div>
    </div>
  )
}
