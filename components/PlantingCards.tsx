'use client'
import type { VerifiedZone } from '@/lib/gemma'
import type { NDVIResult } from '@/pages/api/ndvi'
import type { GemmaResponse } from '@/lib/gemma'

type FullResult = NDVIResult & GemmaResponse

const TYPE_COLORS: Record<string, string> = {
  open_ground:  '#16a34a',
  road_median:  '#2563eb',
  rooftop:      '#7c3aed',
  parking_lot:  '#d97706',
  park:         '#059669',
  construction: '#9ca3af',
  unknown:      '#6b7280',
}

const TYPE_LABELS: Record<string, string> = {
  open_ground:  'Open ground',
  road_median:  'Road median',
  rooftop:      'Rooftop',
  parking_lot:  'Parking lot',
  park:         'Park / grounds',
  construction: 'Construction site',
  unknown:      'Unclassified',
}

interface Props {
  result: FullResult
  onZoneClick?: (zone: VerifiedZone) => void
}

export default function PlantingCards({ result, onZoneClick }: Props) {
  const zones = result.verified_zones ?? []

  return (
    <div style={{ padding: '0 12px 12px' }}>
      <div style={{ fontSize: '10px', color: '#5b21b6', background: '#ede9fe',
        padding: '3px 10px', borderRadius: '20px', display: 'inline-block',
        marginBottom: '10px', fontWeight: 500 }}>
        {result.satellite_image_used
          ? '✦ Gemma 4 vision verified from satellite image'
          : '✦ Gemma 4 estimated zones'}
      </div>

      {zones.length === 0 && (
        <div style={{ fontSize: '12px', color: '#9ca3af' }}>
          No plantable zones identified.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {zones.map((zone) => (
          <div
            key={zone.rank}
            onClick={() => onZoneClick?.(zone)}
            style={{
              border: '1px solid #e5e7eb',
              borderLeft: `3px solid ${TYPE_COLORS[zone.site_type] ?? '#6b7280'}`,
              borderRadius: '8px',
              padding: '10px 12px',
              cursor: onZoneClick ? 'pointer' : 'default',
              background: 'white',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => {
              if (onZoneClick)
                (e.currentTarget as HTMLDivElement).style.background = '#f9fafb'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLDivElement).style.background = 'white'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', marginBottom: '5px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <span style={{
                  width: '20px', height: '20px', borderRadius: '50%',
                  background: TYPE_COLORS[zone.site_type] ?? '#6b7280',
                  color: '#fff', fontSize: '10px', fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0
                }}>{zone.rank}</span>
                <span style={{ fontSize: '12px', fontWeight: 500, color: '#111827' }}>
                  {TYPE_LABELS[zone.site_type] ?? zone.site_type}
                </span>
              </div>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#16a34a' }}>
                {zone.cooling_impact}
              </span>
            </div>

            {zone.place_name && (
              <div style={{ fontSize: '11px', color: '#374151', marginBottom: '3px', fontWeight: 500 }}>
                {zone.place_name}
              </div>
            )}
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>
              {zone.estimated_trees.toLocaleString()} trees · {zone.planting_method}
            </div>

            <div style={{ fontSize: '11px', color: '#9ca3af', fontStyle: 'italic', lineHeight: 1.5 }}>
              &quot;{zone.gemma_reasoning}&quot;
            </div>

            {onZoneClick && (
              <div style={{ fontSize: '10px', color: '#2563eb', marginTop: '5px' }}>
                Click to fly to this zone →
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
