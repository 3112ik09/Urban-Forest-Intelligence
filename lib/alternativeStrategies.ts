import type { NDVIResult } from '@/pages/api/ndvi'

export interface AlternativeStrategy {
  key: string
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  coolingC: number
  treesEquiv: number
  triggerValue: number
  triggerUnit: string
  triggerLabel: string
  photo: string
  icon: string
  dataEvidence: string   // kept for backward compat
  evidenceKey: string
  evidenceParams: Record<string, string | number>
}

export function buildAlternativeStrategies(result: NDVIResult): AlternativeStrategy[] {
  const { available_rooftops, road_km, wall_count, parking_lots, built_up_pct } = result
  const strategies: AlternativeStrategy[] = []

  if (available_rooftops > 0) {
    strategies.push({
      key: 'rooftop_greening',
      title: 'Rooftop greening',
      description: 'Install green roofs, roof gardens or planters on flat rooftops. Reduces surface temperature, extends roof lifespan and absorbs CO₂ in the densest parts of the city.',
      priority: available_rooftops > 200 ? 'high' : 'medium',
      coolingC: +Math.min(3.0, available_rooftops * 0.003).toFixed(1),
      treesEquiv: Math.round(available_rooftops * 3),
      triggerValue: available_rooftops,
      triggerUnit: 'rooftops',
      triggerLabel: `${available_rooftops.toLocaleString()} eligible rooftops`,
      photo: '/strategies/rooftop_greening.jpg',
      icon: 'ti-building',
      dataEvidence: `${available_rooftops.toLocaleString()} flat-roof buildings identified from OSM footprints`,
      evidenceKey: 'rooftop_osm',
      evidenceParams: { count: available_rooftops },
    })
  }

  if (road_km > 0) {
    strategies.push({
      key: 'roadside_tree_pits',
      title: 'Roadside tree pits & medians',
      description: 'Plant trees in road medians, verges and tree pits along existing road corridors. Creates shaded walking environments and urban corridors for biodiversity.',
      priority: 'high',
      coolingC: +Math.min(2.5, road_km * 0.07).toFixed(1),
      treesEquiv: Math.round(road_km * 15),
      triggerValue: road_km,
      triggerUnit: 'km road',
      triggerLabel: `${road_km} km road network`,
      photo: '/strategies/roadside_tree_pits.jpg',
      icon: 'ti-road',
      dataEvidence: `${road_km} km of OSM road corridors suitable for median or verge planting`,
      evidenceKey: 'road_corridors_osm',
      evidenceParams: { km: road_km },
    })
  }

  if (wall_count > 0) {
    strategies.push({
      key: 'vertical_wall',
      title: 'Vertical wall gardens',
      description: 'Install modular planting systems on south-facing building facades. Provides insulation, reduces urban heat island effect and creates wildlife habitat.',
      priority: 'low',
      coolingC: +Math.min(1.5, wall_count * 0.003).toFixed(1),
      treesEquiv: Math.round(wall_count * 0.5),
      triggerValue: wall_count,
      triggerUnit: 'walls',
      triggerLabel: `${wall_count.toLocaleString()} suitable facades`,
      photo: '/strategies/vertical_wall.jpg',
      icon: 'ti-wall',
      dataEvidence: `${wall_count.toLocaleString()} building facades with suitable aspect and area`,
      evidenceKey: 'facades_osm',
      evidenceParams: { count: wall_count },
    })
  }

  if (parking_lots > 0) {
    strategies.push({
      key: 'parking_desealing',
      title: 'Parking lot greening & de-sealing',
      description: 'Add perimeter trees, replace asphalt with permeable paving and install shade canopies. Dramatically reduces surface temperature in heat-island hotspots.',
      priority: parking_lots > 20 ? 'medium' : 'low',
      coolingC: +Math.min(1.2, parking_lots * 0.015).toFixed(1),
      treesEquiv: Math.round(parking_lots * 5),
      triggerValue: parking_lots,
      triggerUnit: 'lots',
      triggerLabel: `${parking_lots} parking lots`,
      photo: '/strategies/parking_desealing.jpg',
      icon: 'ti-parking',
      dataEvidence: `${parking_lots} OSM-tagged parking lots with perimeter planting potential`,
      evidenceKey: 'parking_osm',
      evidenceParams: { count: parking_lots },
    })
  }

  if (built_up_pct > 70) {
    strategies.push({
      key: 'reflective_surfaces',
      title: 'Cool roof & reflective surfaces',
      description: 'Apply high-albedo paint or membranes to rooftops and road surfaces. Reflects solar radiation instead of absorbing it — no planting required.',
      priority: built_up_pct > 75 ? 'medium' : 'low',
      coolingC: 0.25,
      treesEquiv: Math.round(built_up_pct * 2),
      triggerValue: built_up_pct,
      triggerUnit: '% built-up',
      triggerLabel: `${built_up_pct}% impervious surface`,
      photo: 'https://images.unsplash.com/photo-1599809275671-b5942cabc7a2?w=200&q=80',
      icon: 'ti-sun',
      dataEvidence: `Built-up % over 70 — high thermal mass district`,
      evidenceKey: 'built_up_density',
      evidenceParams: { pct: built_up_pct },
    })
  }

  if (road_km > 8) {
    strategies.push({
      key: 'permeable_pavement',
      title: 'Permeable pavement network',
      description: 'Replace sealed road and footpath surfaces with permeable paving. Reduces runoff, lowers surface temperature by 2–4°C on hot days, enables sub-surface soil moisture.',
      priority: 'high',
      coolingC: +(road_km * 0.012).toFixed(1),
      treesEquiv: Math.round(road_km * 4),
      triggerValue: road_km,
      triggerUnit: 'km road',
      triggerLabel: `${road_km} km road network`,
      photo: '/strategies/permeable_pavement.jpg',
      icon: 'ti-droplet',
      dataEvidence: `${road_km}km road network — permeable overlay viable on residential streets and footpaths`,
      evidenceKey: 'road_network_overlay',
      evidenceParams: { km: road_km },
    })
  }

  const priOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
  strategies.sort((a, b) => priOrder[a.priority] - priOrder[b.priority])
  return strategies
}
