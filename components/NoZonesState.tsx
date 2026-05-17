'use client'
import type { LangCode } from '@/lib/gemma'

export type NoZonesReason = 'no_bare_land' | 'too_dense' | 'high_canopy' | 'fallback'

const HEADER: Record<string, string> = {
  en: 'No planting zones found',
  fr: 'Aucune zone de plantation trouvée',
  es: 'No se encontraron zonas de plantación',
  de: 'Keine Pflanzungszonen gefunden',
  hi: 'कोई रोपण क्षेत्र नहीं मिला',
}

const REASON_TEXT: Record<NoZonesReason, Record<string, string>> = {
  no_bare_land: {
    en: 'No plantable open land detected in this district.',
    fr: 'Aucun terrain nu plantable détecté dans ce quartier.',
    es: 'No se detectó terreno abierto plantable en este distrito.',
    de: 'Kein bepflanzbares Freigelände in diesem Bezirk erkannt.',
    hi: 'इस जिले में कोई रोपण योग्य खुली भूमि नहीं मिली।',
  },
  too_dense: {
    en: 'District is too densely built to support ground planting.',
    fr: 'Le quartier est trop densément bâti pour la plantation au sol.',
    es: 'El distrito está demasiado densamente construido para plantación en suelo.',
    de: 'Zu dichte Bebauung für Bodenpflanzungen in diesem Bezirk.',
    hi: 'यह जिला भूमि रोपण के लिए अत्यधिक घनी आबादी वाला है।',
  },
  high_canopy: {
    en: 'Existing canopy cover is already strong — focus is on expanding it further.',
    fr: "La canopée existante est déjà solide — l'objectif est de l'étendre davantage.",
    es: 'La cobertura de dosel existente ya es sólida — el objetivo es ampliarla.',
    de: 'Bestehende Kronendachdeckung ist bereits gut — Fokus auf Erweiterung.',
    hi: 'मौजूदा छतरी आवरण पहले से मजबूत है — इसे और बढ़ाने पर ध्यान दें।',
  },
  fallback: {
    en: 'No plantable open land detected in this district.',
    fr: 'Aucun terrain nu plantable détecté dans ce quartier.',
    es: 'No se detectó terreno abierto plantable en este distrito.',
    de: 'Kein bepflanzbares Freigelände in diesem Bezirk erkannt.',
    hi: 'इस जिले में कोई रोपण योग्य खुली भूमि नहीं मिली।',
  },
}

const SUBTEXT: Record<string, (cooling: string) => string> = {
  en: (c) => `Alternative urban greening methods can still reduce surface temperature by up to −${c}°C in this district.`,
  fr: (c) => `Des méthodes alternatives de verdissement peuvent tout de même réduire la température de surface jusqu'à −${c}°C dans ce quartier.`,
  es: (c) => `Los métodos alternativos de revegetación pueden reducir la temperatura superficial hasta −${c}°C en este distrito.`,
  de: (c) => `Alternative Stadtbegrünungsmethoden können die Oberflächentemperatur in diesem Bezirk noch um bis zu −${c}°C senken.`,
  hi: (c) => `वैकल्पिक शहरी हरित विधियां इस जिले में सतह का तापमान −${c}°C तक कम कर सकती हैं।`,
}

const SCROLL_LINK: Record<string, string> = {
  en: 'See alternative strategies below',
  fr: 'Voir les stratégies alternatives ci-dessous',
  es: 'Ver estrategias alternativas a continuación',
  de: 'Alternative Strategien unten ansehen',
  hi: 'नीचे वैकल्पिक रणनीतियां देखें',
}

interface Props {
  districtName: string
  greenCoverPct: number
  builtUpPct: number
  estTempC: number
  reason: NoZonesReason
  totalCooling: number
  strategyCount: number
  language?: LangCode
  onScrollToStrategies?: () => void
}

export default function NoZonesState({
  greenCoverPct,
  builtUpPct,
  estTempC,
  reason,
  totalCooling,
  language = 'en',
  onScrollToStrategies,
}: Props) {
  const lang = (language in HEADER) ? language : 'en'
  const header = HEADER[lang]
  const reasonText = REASON_TEXT[reason]?.[lang] ?? REASON_TEXT[reason]?.en
  const subtextFn = SUBTEXT[lang] ?? SUBTEXT.en
  const subtext = subtextFn(totalCooling.toFixed(1))
  const scrollLabel = SCROLL_LINK[lang] ?? SCROLL_LINK.en

  return (
    <div style={{ padding: '0 16px 12px' }}>
      {/* Amber header bar */}
      <div style={{
        background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px',
        padding: '10px 12px', marginBottom: '10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <span style={{ fontSize: '14px' }}>⚠</span>
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#92400e' }}>{header}</span>
        </div>
        <div style={{ fontSize: '11px', color: '#78350f', lineHeight: 1.5, paddingLeft: '22px' }}>
          {reasonText}
        </div>
      </div>

      {/* 3 key stat pills */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
        <StatPill label="canopy" value={`${greenCoverPct}%`} color="#dc2626" />
        <StatPill label="surface" value={`${estTempC}°C`} color="#dc2626" />
        <StatPill label="built-up" value={`${builtUpPct}%`} color="#6b7280" />
      </div>

      {/* Green info box with cooling estimate + scroll link */}
      <div style={{
        background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px',
        padding: '10px 12px',
      }}>
        <div style={{ fontSize: '11px', color: '#166534', lineHeight: 1.5, marginBottom: '8px' }}>
          {subtext}
        </div>
        {onScrollToStrategies && (
          <button
            onClick={onScrollToStrategies}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontSize: '11px', color: '#16a34a', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: '4px',
            }}
          >
            → {scrollLabel}
          </button>
        )}
      </div>
    </div>
  )
}

function StatPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px',
      padding: '8px 6px', textAlign: 'center',
    }}>
      <div style={{ fontSize: '16px', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '9px', color: '#9ca3af', marginTop: '2px' }}>{label}</div>
    </div>
  )
}
