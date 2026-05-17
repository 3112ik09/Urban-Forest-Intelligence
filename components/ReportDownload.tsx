'use client'
import { useState } from 'react'
import { SUPPORTED_LANGUAGES, sanitiseGemmaOutput, type LangCode } from '@/lib/gemma'
import type { NDVIResult } from '@/pages/api/ndvi'
import type { GemmaResponse, VerifiedZone } from '@/lib/gemma'
import { buildAlternativeStrategies, type AlternativeStrategy } from '@/lib/alternativeStrategies'

type FullResult = NDVIResult & GemmaResponse
type Status = 'idle' | 'translating' | 'building'

interface Props {
  district: string
  result: FullResult
  language?: LangCode
  onLanguageChange?: (lang: LangCode) => void
}

type PdfLabel = {
  title: string; zoneStats: string; greenCover: string; estTemp: string
  builtUp: string; barrenLand: string; plantScore: string; analysis: string
  recommendations: string; alternatives: string; combinedImpact: string
  cooling: string; treeEquiv: string; landCover: string; species: string
  location: string; area: string; mcda: string; basedOn: string
  priority: { high: string; medium: string; low: string }
  poweredBy: string
  noZonesText: string
  roadNetwork: string; rooftops: string; facades: string
  parkingLots: string; imperviousSurface: string; nativeSpecies: string
  evidenceTemplates: Record<string, string>
  zoneTypes: {
    ground_planting_open: string; ground_planting_median: string
    street_tree: string; rooftop: string; vertical: string
  }
  strategyTypes: Record<string, string>
  strategyDescriptions: Record<string, string>
}

const PDF_LABELS: Record<string, PdfLabel> = {
  en: {
    title: 'Policy Brief', zoneStats: 'Zone Statistics',
    greenCover: 'Green Cover (NDVI-derived)', estTemp: 'Est. Surface Temperature',
    builtUp: 'Built-up Area', barrenLand: 'Barren Land Available',
    plantScore: 'Plantation Suitability', analysis: 'Gemma 4 Analysis',
    recommendations: 'Recommendations', alternatives: 'Alternative Greening Strategies',
    combinedImpact: 'Combined estimated impact', cooling: 'cooling',
    treeEquiv: 'tree equiv.', landCover: 'Land Cover Overview',
    species: 'Recommended Species', location: 'Location',
    area: 'Plantable Area', mcda: 'Site Score', basedOn: 'Based on',
    priority: { high: 'High priority', medium: 'Medium', low: 'Low' },
    poweredBy: 'Powered by Gemma 4 multimodal AI and Google Earth Engine Sentinel-2 data.',
    noZonesText: 'No ground planting zones available — see alternative strategies below.',
    roadNetwork: 'road network', rooftops: 'eligible rooftops',
    facades: 'suitable facades', parkingLots: 'parking lots',
    imperviousSurface: 'impervious surface',
    nativeSpecies: 'Native species — suitable for local climate',
    evidenceTemplates: {
      road_corridors_osm: '{km} km of road corridors suitable for median or verge planting',
      road_network_overlay: '{km}km road network — permeable overlay viable on residential streets',
      rooftop_osm: '{count} flat-roof buildings identified from OSM footprints',
      facades_osm: '{count} building facades with suitable aspect and area',
      parking_osm: '{count} OSM-tagged parking lots with perimeter planting potential',
      built_up_density: 'Built-up area {pct}% — high thermal mass district',
      courtyard_density: 'Dense urban fabric with minimal open land — courtyards are primary opportunity',
    },
    zoneTypes: {
      ground_planting_open: 'Ground planting — open land',
      ground_planting_median: 'Ground planting — road median',
      street_tree: 'Street tree pit',
      rooftop: 'Rooftop greening',
      vertical: 'Vertical wall garden',
    },
    strategyTypes: {
      roadside_tree_pits: 'Roadside tree pits & medians',
      permeable_pavement: 'Permeable pavement network',
      rooftop_greening: 'Rooftop greening',
      vertical_wall: 'Vertical wall gardens',
      parking_desealing: 'Parking lot greening & de-sealing',
      reflective_surfaces: 'Cool roof & reflective surfaces',
    },
    strategyDescriptions: {
      roadside_tree_pits: 'Plant trees in road medians, verges and tree pits along existing road corridors. Creates shaded walking environments and urban corridors for biodiversity.',
      permeable_pavement: 'Replace sealed road and footpath surfaces with permeable paving. Reduces runoff, lowers surface temperature by 2–4°C on hot days, enables sub-surface soil moisture.',
      rooftop_greening: 'Install green roofs, roof gardens or planters on flat rooftops. Reduces surface temperature, extends roof lifespan and absorbs CO₂ in the densest parts of the city.',
      vertical_wall: 'Install modular planting systems on south-facing building facades. Provides insulation, reduces urban heat island effect and creates wildlife habitat.',
      parking_desealing: 'Add perimeter trees, replace asphalt with permeable paving and install shade canopies. Dramatically reduces surface temperature in heat-island hotspots.',
      reflective_surfaces: 'Apply high-albedo paint or membranes to rooftops and road surfaces. Reflects solar radiation instead of absorbing it — no planting required.',
    },
  },
  fr: {
    title: 'Rapport de politique', zoneStats: 'Statistiques de zone',
    greenCover: 'Couverture verte (NDVI)', estTemp: 'Température de surface estimée',
    builtUp: 'Zone urbanisée', barrenLand: 'Terrain nu disponible',
    plantScore: 'Score de plantation', analysis: 'Analyse Gemma 4',
    recommendations: 'Recommandations', alternatives: 'Stratégies alternatives de végétalisation',
    combinedImpact: 'Impact estimé combiné', cooling: 'refroidissement',
    treeEquiv: 'équiv. arbres', landCover: 'Aperçu de la couverture des sols',
    species: 'Espèces recommandées', location: 'Localisation',
    area: 'Surface plantable', mcda: 'Score de site', basedOn: 'Basé sur',
    priority: { high: 'Haute priorité', medium: 'Moyen', low: 'Faible' },
    poweredBy: 'Propulsé par Gemma 4 IA multimodale et Google Earth Engine données Sentinel-2.',
    noZonesText: 'Aucune zone de plantation au sol disponible — voir les stratégies alternatives ci-dessous.',
    roadNetwork: 'réseau routier', rooftops: 'toitures éligibles',
    facades: 'façades adaptées', parkingLots: 'parkings',
    imperviousSurface: 'surface imperméable',
    nativeSpecies: 'Espèces indigènes — adaptées au climat local',
    evidenceTemplates: {
      road_corridors_osm: '{km} km de corridors routiers aptes à la plantation en terre-plein ou accotement',
      road_network_overlay: '{km} km de réseau routier — revêtement permeable viable sur les rues résidentielles',
      rooftop_osm: '{count} bâtiments à toit plat identifiés dans OSM',
      facades_osm: '{count} façades avec orientation et superficie adaptées',
      parking_osm: '{count} parkings étiquetés OSM avec potentiel de plantation périphérique',
      built_up_density: 'Zone urbanisée {pct}% — district à forte masse thermique',
      courtyard_density: 'Tissu urbain dense avec peu de terrain libre — les cours intérieures sont la principale opportunité',
    },
    zoneTypes: {
      ground_planting_open: 'Plantation au sol — terrain ouvert',
      ground_planting_median: 'Plantation au sol — terre-plein central',
      street_tree: 'Fosse pour arbre de rue',
      rooftop: 'Toiture végétalisée',
      vertical: 'Jardin vertical',
    },
    strategyTypes: {
      roadside_tree_pits: 'Arbres en fosses et terre-pleins',
      permeable_pavement: 'Réseau de revêtement permeable',
      rooftop_greening: 'Végétalisation des toitures',
      vertical_wall: 'Jardins muraux verticaux',
      parking_desealing: 'Désimperméabilisation des parkings',
      reflective_surfaces: 'Toitures fraîches et surfaces réfléchissantes',
    },
    strategyDescriptions: {
      roadside_tree_pits: 'Planter des arbres dans les terre-pleins, les accotements et les fosses le long des voies existantes. Crée des environnements de marche ombragés et des corridors urbains pour la biodiversité.',
      permeable_pavement: 'Remplacer les surfaces imperméables des routes et des trottoirs par un revêtement permeable. Réduit le ruissellement, abaisse la température de surface de 2 à 4°C par temps chaud.',
      rooftop_greening: 'Installer des toits verts, des jardins en terrasse ou des bacs à plantes sur les toits plats. Réduit la température de surface, prolonge la durée de vie du toit et absorbe le CO₂.',
      vertical_wall: 'Installer des systèmes de plantation modulaires sur les façades exposées au sud. Fournit une isolation, réduit l’effet d’îlot de chaleur urbain et crée un habitat pour la faune.',
      parking_desealing: 'Ajouter des arbres en périphérie, remplacer l’asphalte par un revêtement permeable et installer des auvents ombragés. Réduit considérablement la température de surface.',
      reflective_surfaces: 'Appliquer de la peinture haute albédo ou des membranes sur les toits et les surfaces routières. Réfléchit le rayonnement solaire au lieu de l’absorber — aucune plantation requise.',
    },
  },
  es: {
    title: 'Informe de politica', zoneStats: 'Estadísticas de zona',
    greenCover: 'Cobertura verde (NDVI)', estTemp: 'Temperatura superficial estimada',
    builtUp: 'Área urbanizada', barrenLand: 'Terreno baldío disponible',
    plantScore: 'Puntuación de plantación', analysis: 'Análisis Gemma 4',
    recommendations: 'Recomendaciones', alternatives: 'Estrategias alternativas de revegetación',
    combinedImpact: 'Impacto estimado combinado', cooling: 'enfriamiento',
    treeEquiv: 'equiv. árboles', landCover: 'Resumen de cobertura del suelo',
    species: 'Especies recomendadas', location: 'Ubicación',
    area: 'Área plantable', mcda: 'Puntuación del sitio', basedOn: 'Basado en',
    priority: { high: 'Alta prioridad', medium: 'Media', low: 'Baja' },
    poweredBy: 'Desarrollado por Gemma 4 IA multimodal y datos Google Earth Engine Sentinel-2.',
    noZonesText: 'No hay zonas de plantación en suelo disponibles — ver estrategias alternativas a continuación.',
    roadNetwork: 'red vial', rooftops: 'cubiertas elegibles',
    facades: 'fachadas adecuadas', parkingLots: 'aparcamientos',
    imperviousSurface: 'superficie impermeable',
    nativeSpecies: 'Especies nativas — adecuadas al clima local',
    evidenceTemplates: {
      road_corridors_osm: '{km} km de corredores viales aptos para plantación en mediana o arcén',
      road_network_overlay: '{km} km de red vial — pavimento permeable viable en calles residenciales',
      rooftop_osm: '{count} edificios de cubierta plana identificados en OSM',
      facades_osm: '{count} fachadas con orientación y superficie adecuadas',
      parking_osm: '{count} aparcamientos etiquetados en OSM con potencial de plantación perimetral',
      built_up_density: 'Área urbanizada {pct}% — distrito de alta masa térmica',
      courtyard_density: 'Tejido urbano denso con escaso suelo libre — los patios interiores son la oportunidad principal',
    },
    zoneTypes: {
      ground_planting_open: 'Plantación en suelo — terreno abierto',
      ground_planting_median: 'Plantación en suelo — mediana vial',
      street_tree: 'Alcorque para árbol de calle',
      rooftop: 'Cubierta verde',
      vertical: 'Jardín vertical',
    },
    strategyTypes: {
      roadside_tree_pits: 'Alcorques y medianas arboladas',
      permeable_pavement: 'Red de pavimento permeable',
      rooftop_greening: 'Revegetación de cubiertas',
      vertical_wall: 'Jardines verticales en fachadas',
      parking_desealing: 'Desimpermeabilización de aparcamientos',
      reflective_surfaces: 'Cubiertas frescas y superficies reflectantes',
    },
    strategyDescriptions: {
      roadside_tree_pits: 'Plantar árboles en medianas, márgenes y alcorques a lo largo de los corredores viarios existentes. Crea entornos de paseo con sombra y corredores urbanos para la biodiversidad.',
      permeable_pavement: 'Reemplazar las superficies selladas de calzadas y aceras con pavimento permeable. Reduce la escorrentía, baja la temperatura superficial 2–4°C en días calurosos.',
      rooftop_greening: 'Instalar cubiertas verdes, jardines en azotea o maceteros en cubiertas planas. Reduce la temperatura superficial, prolonga la vida útil de la cubierta y absorbe CO₂.',
      vertical_wall: 'Instalar sistemas de plantación modulares en fachadas orientadas al sur. Proporciona aislamiento, reduce el efecto isla de calor urbano y crea hábitat para la fauna.',
      parking_desealing: 'Añadir árboles perimetrales, sustituir el asfalto por pavimento permeable e instalar marquesínas de sombra. Reduce drásticamente la temperatura superficial.',
      reflective_surfaces: 'Aplicar pintura de alta reflectancia o membranas en cubiertas y superficies viarias. Refleja la radiación solar en lugar de absorberla — no requiere plantación.',
    },
  },
  de: {
    title: 'Politikbericht', zoneStats: 'Zonenstatistiken',
    greenCover: 'Grünfläche (NDVI)', estTemp: 'Geschätzte Oberflächentemperatur',
    builtUp: 'Bebaute Fläche', barrenLand: 'Verfügbares Brachland',
    plantScore: 'Bepflanzungswert', analysis: 'Gemma 4 Analyse',
    recommendations: 'Empfehlungen', alternatives: 'Alternative Begrünungsstrategien',
    combinedImpact: 'Geschätzte Gesamtwirkung', cooling: 'Kühlung',
    treeEquiv: 'Baum-Äquiv.', landCover: 'Landbedeckungsübersicht',
    species: 'Empfohlene Arten', location: 'Standort',
    area: 'Bepflanzbare Fläche', mcda: 'Standortbewertung', basedOn: 'Basierend auf',
    priority: { high: 'Hohe Priorität', medium: 'Mittel', low: 'Niedrig' },
    poweredBy: 'Unterstützt durch Gemma 4 multimodale KI und Google Earth Engine Sentinel-2 Daten.',
    noZonesText: 'Keine Bodenpflanzungszonen verfügbar — siehe alternative Begrünungsstrategien unten.',
    roadNetwork: 'Straßennetz', rooftops: 'geeignete Dachflächen',
    facades: 'geeignete Fassaden', parkingLots: 'Parkplätze',
    imperviousSurface: 'versiegelte Fläche',
    nativeSpecies: 'Heimische Arten — standortgerecht',
    evidenceTemplates: {
      road_corridors_osm: '{km} km Straßenkorridore für Median- oder Randstreifenbepflanzung',
      road_network_overlay: '{km} km Straßennetz — wasserdurchlässiger Belag auf Wohnstraßen möglich',
      rooftop_osm: '{count} Flachdachgebäude aus OSM-Daten identifiziert',
      facades_osm: '{count} Fassaden mit geeigneter Ausrichtung und Fläche',
      parking_osm: '{count} OSM-Parkplätze mit Potenzial für Randbepflanzung',
      built_up_density: 'Bebaute Fläche {pct}% — Stadtbereich mit hoher Wärmespeicherung',
      courtyard_density: 'Dichtes Stadtgefüge mit wenig Freifläche — Innenhöfe sind die wichtigste Möglichkeit',
    },
    zoneTypes: {
      ground_planting_open: 'Bodenpflanzung — offenes Gelände',
      ground_planting_median: 'Bodenpflanzung — Mittelstreifen',
      street_tree: 'Straßenbaumgrube',
      rooftop: 'Dachbegrünung',
      vertical: 'Vertikalgarten',
    },
    strategyTypes: {
      roadside_tree_pits: 'Straßenbäume und Mittelstreifen',
      permeable_pavement: 'Wasserdurchlässiges Pflasternetz',
      rooftop_greening: 'Dachbegrünung',
      vertical_wall: 'Vertikale Wandgärten',
      parking_desealing: 'Entsiegelung von Parkplätzen',
      reflective_surfaces: 'Kühldächer und reflektierende Oberflächen',
    },
    strategyDescriptions: {
      roadside_tree_pits: 'Bäume in Mittelstreifen, Randstreifen und Baumgruben entlang bestehender Straßenkorridore pflanzen. Schafft schattige Gehwege und urbane Korridore für die Artenvielfalt.',
      permeable_pavement: 'Versiegelte Straßen- und Gehwegflächen durch wasserdurchlässiges Pflaster ersetzen. Reduziert Abfluss, senkt Oberflächentemperatur um 2–4°C an heißen Tagen.',
      rooftop_greening: 'Gründächer, Dachgärten oder Pflanzbehälter auf Flachdächern installieren. Senkt Oberflächentemperatur, verlängert Dachlebensdauer und absorbiert CO₂.',
      vertical_wall: 'Modulare Bepflanzungssysteme an südorientierten Gebäudefassaden installieren. Bietet Dämmung, reduziert den städtischen Wärmeinseleffekt und schafft Wildtierhabitat.',
      parking_desealing: 'Randbäume hinzufügen, Asphalt durch wasserdurchlässiges Pflaster ersetzen und Schattendächer installieren. Senkt die Oberflächentemperatur erheblich.',
      reflective_surfaces: 'Hochreflexive Farbe oder Membranen auf Dächer und Straßenoberflächen auftragen. Reflektiert Sonnenstrahlung statt sie zu absorbieren — keine Bepflanzung erforderlich.',
    },
  },
  hi: {
    title: 'Niti Sankshep', zoneStats: 'Kshetra Aankde',
    greenCover: 'Harit Aavaran (NDVI)', estTemp: 'Anumaanit Satah Taapman',
    builtUp: 'Nirmit Kshetra', barrenLand: 'Uplabdh Banjar Bhoomi',
    plantScore: 'Ropan Upyuktata', analysis: 'Gemma 4 Vishleshan',
    recommendations: 'Sifaarishen', alternatives: 'Vaikalpik Harit Rannitiyan',
    combinedImpact: 'Sanyukt Anumaanit Prabhav', cooling: 'Sheetalan',
    treeEquiv: 'Vriksh Samatulya', landCover: 'Bhoomi Aavaran Jaankaari',
    species: 'Anushansit Prjaatiyan', location: 'Sthan',
    area: 'Ropan Yogya Kshetra', mcda: 'Sthal Ank', basedOn: 'Aadhaar',
    priority: { high: 'Uchch Prathamikta', medium: 'Madhyam', low: 'Nimn' },
    poweredBy: 'Gemma 4 bahuvidh AI aur Google Earth Engine Sentinel-2 Data dwara sanchaalit.',
    noZonesText: 'Koi bhoomi ropan kshetra uplabdh nahi — niche vaikalpik rannitiyan dekhein.',
    roadNetwork: 'sadak netwerk', rooftops: 'upyukt chhatten',
    facades: 'upyukt divaren', parkingLots: 'parking sthal',
    imperviousSurface: 'abhedy satah',
    nativeSpecies: 'Sthaniy Prjaatiyan — sthanaiy jalvayu ke anurup',
    evidenceTemplates: {
      road_corridors_osm: '{km} km sadak corridor median ya kine mein ropan ke liye upyukt',
      road_network_overlay: '{km} km sadak netwerk — niwasi sadakon par permeable covering sambhav',
      rooftop_osm: '{count} saman chhattwaley bhawan OSM se chinhit',
      facades_osm: '{count} divaren — upyukt disha aur kshetrafal ke saath',
      parking_osm: '{count} OSM-tagged parking sthal — parimiti ropan sambhav',
      built_up_density: 'Nirmit kshetra {pct}% — uchch thermal dravyamaan wala kshetra',
      courtyard_density: 'Ghana nagariy dhanchha — aangan mukhya avsar hain',
    },
    zoneTypes: {
      ground_planting_open: 'Bhoomi ropan — khula maidan',
      ground_planting_median: 'Bhoomi ropan — sadak madhyan paati',
      street_tree: 'Sadak vriksh gaddha',
      rooftop: 'Chhath hariyaali',
      vertical: 'Urdhvaadhar vriksh vatika',
    },
    strategyTypes: {
      roadside_tree_pits: 'Sadak vriksh aur madhyan paati ropan',
      permeable_pavement: 'Praveshya pavement netwerk',
      rooftop_greening: 'Chhath hariyaali',
      vertical_wall: 'Diwar vatika',
      parking_desealing: 'Parking kshetra hariyaali',
      reflective_surfaces: 'Pratibimbit chhath avam satah',
    },
    strategyDescriptions: {
      roadside_tree_pits: 'Madhyan paati, kinare aur gaddhe mein vriksh lagaen. Chhayaadaar walkways aur biodiversity ke liye shahari corridors banate hain.',
      permeable_pavement: 'Sealed sadakon aur phootpaath surfaces ko praveshya paving se badlen. Abahaav ghatata hai, garmi ke dinon mein satah taapman 2-4 degree ghata hai.',
      rooftop_greening: 'Samaan chhaton par green roofs, roof gardens ya plantars lagaen. Satah taapman ghatata hai, chhath ki umra badhata hai aur CO2 absorb karta hai.',
      vertical_wall: 'Dakshin divaroan par modular ropan pranali lagaen. Insulation deta hai, shahari heat island effect ghatata hai aur janjiv niwas banata hai.',
      parking_desealing: 'Parimiti vriksh lagaen, asphalt ko praveshya paving se badlen. Satah taapman mein bhari giraawat aati hai.',
      reflective_surfaces: 'Chhaton aur sadak satahon par uchcha-albedo paint lagaen. Solar radiation absorb karne ke bajaay reflect karta hai.',
    },
  },
}

export default function ReportDownload({ district, result, language = 'en', onLanguageChange }: Props) {
  const [status, setStatus] = useState<Status>('idle')

  const handleDownload = async () => {
    setStatus(language === 'en' ? 'building' : 'translating')
    try {
      const tagged = buildTranslatableContent(result)
      const translatedTagged = language === 'en' ? tagged : await fetchTranslation(tagged, language)
      setStatus('building')
      const sections = parseTranslatedSections(translatedTagged, result)
      await generatePDF(district, result, sections, language)
    } finally {
      setStatus('idle')
    }
  }

  const buttonLabel =
    status === 'translating' ? 'Translating with Gemma...' :
      status === 'building' ? 'Building PDF...' :
        'Download PDF policy brief'

  return (
    <div style={{ padding: '0 12px 16px', marginTop: 'auto' }}>
      <div style={{ marginBottom: '8px' }}>
        <label style={{ fontSize: '11px', color: '#9ca3af', display: 'block', marginBottom: '4px' }}>
          Report language
        </label>
        <select
          value={language}
          onChange={e => onLanguageChange?.(e.target.value as LangCode)}
          style={{
            width: '100%', padding: '7px 10px', fontSize: '12px',
            border: '1px solid #e5e7eb', borderRadius: '6px',
            background: '#f9fafb', color: '#111827', cursor: 'pointer',
          }}
        >
          {SUPPORTED_LANGUAGES.map(l => (
            <option key={l.code} value={l.code}>
              {l.nativeName} — {l.label}
            </option>
          ))}
        </select>
      </div>

      <button
        onClick={handleDownload}
        disabled={status !== 'idle'}
        style={{
          width: '100%', padding: '9px', border: '1px solid #e5e7eb',
          borderRadius: '8px',
          background: status !== 'idle' ? '#f3f4f6' : '#f9fafb',
          cursor: status !== 'idle' ? 'wait' : 'pointer',
          fontSize: '13px', color: '#374151', fontWeight: 500,
        }}
      >
        {buttonLabel}
      </button>

      {status === 'translating' && (
        <div style={{ fontSize: '11px', color: '#6b7280', textAlign: 'center', marginTop: '6px' }}>
          Gemma 4 is translating your report — this takes ~15s
        </div>
      )}
    </div>
  )
}

// ── Translatable content — tagged so Gemma preserves structure ────────────────

function buildTranslatableContent(result: FullResult): string {
  const zones = result.verified_zones ?? []
  const altStrategies = buildAlternativeStrategies(result)

  // Only dynamic content goes through Gemma translation.
  // Static UI labels come from PDF_LABELS (pre-translated per language).
  const parts: string[] = [
    `[ANALYSIS]\n${result.analysis}\n[/ANALYSIS]`,
  ]

  zones.forEach((z, i) => {
    const n = i + 1
    const typeLabel = z.site_type.replace(/_/g, ' ')
    parts.push(`[ZONE_TITLE_${n}]${z.planting_method} at ${typeLabel}[/ZONE_TITLE_${n}]`)
    parts.push(`[ZONE_REASONING_${n}]\n${z.gemma_reasoning}\n[/ZONE_REASONING_${n}]`)
    if (z._species?.length) {
      z._species.forEach((sp, si) => {
        parts.push(`[ZONE_SPECIES_${n}_${si + 1}]${sp.name} — ${sp.why}[/ZONE_SPECIES_${n}_${si + 1}]`)
      })
    }
  })

  // Strategy titles and descriptions are now pre-translated via PDF_LABELS.
  // Only zone-level dynamic content (reasoning, species) needs Gemma translation.

  return parts.join('\n\n')
}

// ── Parse translated tagged content ──────────────────────────────────────────

interface TranslatedSections {
  analysis: string
  zoneReasonings: string[]
  zoneTitles: string[]
  zoneSpecies: string[][]
}

function extractTag(text: string, tag: string, fallback: string): string {
  const m = text.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`))
  return m?.[1]?.trim() || fallback
}

function parseTranslatedSections(text: string, result: FullResult): TranslatedSections {
  const zones = result.verified_zones ?? []
  return {
    analysis: extractTag(text, 'ANALYSIS', result.analysis),
    zoneTitles: zones.map((z, i) => {
      const typeLabel = z.site_type.replace(/_/g, ' ')
      return extractTag(text, `ZONE_TITLE_${i + 1}`, `${z.planting_method} at ${typeLabel}`)
    }),
    zoneReasonings: zones.map((z, i) =>
      extractTag(text, `ZONE_REASONING_${i + 1}`, z.gemma_reasoning)
    ),
    zoneSpecies: zones.map((z, i) =>
      (z._species ?? []).map((sp, si) =>
        extractTag(text, `ZONE_SPECIES_${i + 1}_${si + 1}`, `${sp.name} — ${sp.why}`)
      )
    ),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTranslation(text: string, lang: LangCode): Promise<string> {
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang }),
    })
    if (!res.ok) return text
    const data = await res.json()
    return data.translated ?? text
  } catch {
    return text
  }
}

// ── PDF translation helpers ───────────────────────────────────────────────────

function renderEvidence(key: string, params: Record<string, string | number>, t: PdfLabel): string {
  const template = t.evidenceTemplates[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
}

function translateZoneType(siteType: string, t: PdfLabel): string {
  const s = siteType.toLowerCase()
  if (s.includes('median')) return t.zoneTypes.ground_planting_median
  if (s.includes('street_tree') || s.includes('street tree')) return t.zoneTypes.street_tree
  if (s.includes('rooftop') || s.includes('roof')) return t.zoneTypes.rooftop
  if (s.includes('vertical') || s.includes('wall')) return t.zoneTypes.vertical
  return t.zoneTypes.ground_planting_open
}

function renderTriggerLabel(s: AlternativeStrategy, t: PdfLabel): string {
  const v = s.triggerValue
  if (s.triggerUnit === 'rooftops') return `${v.toLocaleString()} ${t.rooftops}`
  if (s.triggerUnit === 'km road') return `${v} km ${t.roadNetwork}`
  if (s.triggerUnit === 'walls') return `${v.toLocaleString()} ${t.facades}`
  if (s.triggerUnit === 'lots') return `${v} ${t.parkingLots}`
  if (s.triggerUnit === '% built-up') return `${v}% ${t.imperviousSurface}`
  return s.triggerLabel
}

function getStrategyTitle(s: AlternativeStrategy, t: PdfLabel): string {
  return t.strategyTypes[s.key] ?? s.title
}

function getStrategyDescription(s: AlternativeStrategy, t: PdfLabel): string {
  return t.strategyDescriptions[s.key] ?? s.description
}

function isAgentFallbackSpecies(sp: string): boolean {
  const l = sp.toLowerCase()
  return (
    l.includes('native species') || l.includes('agent 2') ||
    l.includes('unavailable') || l.includes('formula') ||
    sp.trim().startsWith('"') || sp.trim().startsWith("'")
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any

// Draw a horizontal bar (gray track + colored fill)
function drawBar(
  doc: Doc,
  x: number, y: number, w: number,
  pct: number, max: number,
  r: number, g: number, b: number,
  barH = 5,
) {
  doc.setFillColor(229, 231, 235)
  doc.roundedRect(x, y, w, barH, 1, 1, 'F')
  const fill = Math.max(barH, (pct / max) * w)
  doc.setFillColor(r, g, b)
  doc.roundedRect(x, y, fill, barH, 1, 1, 'F')
}

// Section heading — consistent style across all sections
function sectionHeading(doc: Doc, label: string, x: number, y: number): number {
  doc.setFontSize(10)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(40, 40, 40)
  doc.text(label.toUpperCase(), x, y)
  return y + 7
}


// Add this sanitiser near the top of your PDF helpers
function sanitisePdfText(text: string): string {
  return text
    .replace(/CO₂/g, 'CO2')
    .replace(/CO\u2082/g, 'CO2')   // unicode escape variant
    .replace(/[^\x00-\xFF]/g, c => {
      // Replace any other non-Latin-1 char with ASCII fallback
      const fallbacks: Record<string, string> = {
        '°': 'deg', '–': '-', '—': '-', '\u2019': "'", '\u201C': '"', '\u201D': '"',
      }
      return fallbacks[c] ?? '?'
    })
}

// Horizontal divider then advance y by 8
function divider(doc: Doc, x: number, y: number, w: number): number {
  doc.setDrawColor(220, 220, 220)
  doc.line(x, y, x + w, y)
  return y + 8
}

function addPageIfNeeded(doc: Doc, y: number, PH: number, M: number): number {
  if (y > PH - 35) { doc.addPage(); return M }
  return y
}

// ── PDF generator ─────────────────────────────────────────────────────────────

async function generatePDF(
  district: string,
  result: FullResult,
  sections: TranslatedSections,
  lang: LangCode,
) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF()
  const PW = 210
  const PH = 297
  const M = 20
  const CW = PW - M * 2
  const CARD_TEXT_W = CW - 20
  const t: PdfLabel = PDF_LABELS[lang] ?? PDF_LABELS['en']
  const langLabel = SUPPORTED_LANGUAGES.find(l => l.code === lang)?.label ?? 'English'
  const zones = result.verified_zones ?? []
  const altStrategies = buildAlternativeStrategies(result)

  // ── Header ────────────────────────────────────────────────────────────────
  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(21, 128, 61)
  doc.text('Urban Forest Intelligence', M, 20)

  doc.setFontSize(11)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(55, 65, 81)
  doc.text(`${t.title} — ${district}`, M, 29)

  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text(`${langLabel}  |  Gemma 4 + Earth Engine`, M, 36)
  doc.text(
    `Generated: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    M, 42,
  )

  doc.setDrawColor(200, 200, 200)
  doc.line(M, 46, PW - M, 46)

  let y = 54

  // ── Zone statistics ───────────────────────────────────────────────────────
  y = sectionHeading(doc, t.zoneStats, M, y)

  const VAL_X = M + 90
  const statRows = [
    { label: t.greenCover, value: `${result.green_cover_pct}%` },
    { label: t.estTemp, value: `${result.estimated_temp_c}°C` },
    { label: t.builtUp, value: `${result.built_up_pct}%` },
    { label: t.barrenLand, value: `${result.barren_ha} ha` },
    { label: t.plantScore, value: `${result.plantation_score}/100` },
  ]
  doc.setFontSize(9.5)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(55, 65, 81)
  statRows.forEach(({ label, value }) => {
    doc.text(label, M, y)
    doc.setFont('helvetica', 'bold')
    doc.text(value, VAL_X, y)
    doc.setFont('helvetica', 'normal')
    y += 5.5
  })
  y += 4

  // ── Bar charts ────────────────────────────────────────────────────────────
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(75, 85, 99)
  doc.text(t.landCover, M, y)
  y += 6

  const LABEL_W = 38
  const BAR_W = CW - LABEL_W - 16
  const bars = [
    { label: t.greenCover.split(' (')[0], pct: result.green_cover_pct, r: 22, g: 163, b: 74 },
    { label: t.builtUp, pct: result.built_up_pct, r: 217, g: 119, b: 6 },
    { label: t.plantScore, pct: result.plantation_score, r: 37, g: 99, b: 235 },
  ]
  bars.forEach(bar => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(75, 85, 99)
    doc.text(bar.label, M, y + 4)
    drawBar(doc, M + LABEL_W, y, BAR_W, bar.pct, 100, bar.r, bar.g, bar.b)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(55, 65, 81)
    doc.text(`${bar.pct}%`, M + LABEL_W + BAR_W + 3, y + 4)
    y += 11
  })
  y += 2

  // ── Gemma 4 analysis ──────────────────────────────────────────────────────
  y = divider(doc, M, y, CW)
  y = sectionHeading(doc, t.analysis, M, y)

  const cleanAnalysis = sanitiseGemmaOutput(sections.analysis)
  const analysisText = cleanAnalysis.length > 30
    ? cleanAnalysis
    : sections.analysis.length > 30
      ? sections.analysis
      : result.analysis || '[Analysis unavailable for this district]'
  doc.setFontSize(9.5)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(55, 65, 81)
  const analysisLines = doc.splitTextToSize(analysisText, CW) as string[]
  doc.text(analysisLines, M, y)
  y += analysisLines.length * 4.8 + 6

  // ── Recommendations ───────────────────────────────────────────────────────
  y = divider(doc, M, y, CW)
  y = sectionHeading(doc, t.recommendations, M, y)

  if (zones.length === 0) {
    doc.setFontSize(9)
    doc.setFont('helvetica', 'italic')
    doc.setTextColor(107, 114, 128)
    doc.text(t.noZonesText, M, y)
    doc.setFont('helvetica', 'normal')
    y += 10
  } else {
    const maxTrees = Math.max(...zones.map(z => z.estimated_trees), 1)

    zones.forEach((z: VerifiedZone, i: number) => {
      y = addPageIfNeeded(doc, y, PH, M)

      doc.setFontSize(9.5)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(40, 40, 40)
      const title = translateZoneType(z.site_type, t)
      doc.text(`${i + 1}. ${title}`, M, y)
      y += 5.5

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(75, 85, 99)
      doc.text(
        `${z.estimated_trees.toLocaleString()} trees — ${t.cooling} ${z.cooling_impact}` +
        (z.place_name ? `  |  ${z.place_name}` : ''),
        M, y,
      )
      y += 5

      drawBar(doc, M, y, CW * 0.55, z.estimated_trees, maxTrees, 22, 163, 74, 4)
      doc.setFontSize(7.5)
      doc.setTextColor(107, 114, 128)
      doc.text(`${z.estimated_trees.toLocaleString()} trees`, M + CW * 0.55 + 3, y + 3)
      y += 8

      const metricParts: string[] = []
      if (z._carbon_10yr != null) metricParts.push(`CO2 ~${z._carbon_10yr.toFixed(0)} t/10yr`)
      if (z._people_impacted != null) metricParts.push(`~${z._people_impacted.toLocaleString()} people`)
      if (z._cost_inr != null) metricParts.push(`INR ${(Math.round(z._cost_inr / 100000 * 10) / 10).toFixed(1)}L est.`)
      if (metricParts.length > 0) {
        doc.setFontSize(8.5)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(107, 114, 128)
        doc.text(metricParts.join('  |  '), M, y)
        y += 5
      }

      const detailParts: string[] = []
      if (z._plantable_ha != null) detailParts.push(`${t.area}: ${z._plantable_ha} ha`)
      if (z._mcda_score != null) detailParts.push(`${t.mcda}: ${z._mcda_score}/100`)
      if (detailParts.length > 0) {
        doc.setFontSize(8.5)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(107, 114, 128)
        doc.text(detailParts.join('  |  '), M, y)
        y += 5
      }

      doc.setFontSize(8)
      doc.setTextColor(156, 163, 175)
      doc.text(`${t.location}: ${z.lat.toFixed(5)}N, ${z.lon.toFixed(5)}E`, M, y)
      y += 5

      const speciesList = sections.zoneSpecies[i] ?? []
      if (speciesList.length > 0) {
        y = addPageIfNeeded(doc, y, PH, M)
        doc.setFontSize(8.5)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(21, 128, 61)
        doc.text(`${t.species}:`, M, y)
        y += 4.5
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(55, 65, 81)
        speciesList.forEach(sp => {
          y = addPageIfNeeded(doc, y, PH, M)
          const spText = isAgentFallbackSpecies(sp)
            ? t.nativeSpecies
            : sp.replace(/^["']|["']$/g, '').trim()
          const spLines = doc.splitTextToSize(`  ${spText}`, CW - 4) as string[]
          doc.setFontSize(8.5)
          doc.text(spLines, M + 2, y)
          y += spLines.length * 4.2
        })
      }

      const reasoning = sections.zoneReasonings[i] || z.gemma_reasoning
      const reasoningIsAgentFallback = /agent 2|unavailable|formula estimate/i.test(reasoning)
      if (!reasoningIsAgentFallback) {
        y = addPageIfNeeded(doc, y, PH, M)
        doc.setFontSize(9)
        doc.setFont('helvetica', 'italic')
        doc.setTextColor(107, 114, 128)
        const rLines = doc.splitTextToSize(`"${reasoning}"`, CW) as string[]
        doc.text(rLines, M, y)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9)
        doc.setTextColor(75, 85, 99)
        y += rLines.length * 4.5 + 8
      } else {
        y += 6
      }

      if (i < zones.length - 1) {
        doc.setDrawColor(240, 240, 240)
        doc.line(M, y - 4, PW - M, y - 4)
      }
    })
  } // end else (zones.length > 0)

  // ── Alternative greening strategies ──────────────────────────────────────
  if (altStrategies.length > 0) {
    y = addPageIfNeeded(doc, y, PH, M)
    y = divider(doc, M, y, CW)
    y = sectionHeading(doc, t.alternatives, M, y)

    const PRI_RGB: Record<string, [number, number, number]> = {
      high: [163, 45, 45],
      medium: [163, 120, 6],
      low: [39, 80, 10],
    }
    const priLabel = (p: string) =>
      p === 'high' ? t.priority.high :
        p === 'medium' ? t.priority.medium : t.priority.low

    altStrategies.forEach((s, i) => {
      y = addPageIfNeeded(doc, y, PH, M)

      // Reset font state before measuring — splitTextToSize uses current font metrics
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(75, 85, 99)

      const [r, g, b] = PRI_RGB[s.priority] ?? [107, 114, 128]
      const titleText = `${getStrategyTitle(s, t)}  [${priLabel(s.priority)}]`
      const descText = sanitisePdfText(getStrategyDescription(s, t))
      const analysisText = sanitisePdfText(cleanAnalysis)
      const evidenceText = renderEvidence(s.evidenceKey, s.evidenceParams, t)

      // Measure with the correct font before rendering
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9.5)
      const titleLines = doc.splitTextToSize(titleText, CARD_TEXT_W) as string[]

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      const descLines = doc.splitTextToSize(descText, CARD_TEXT_W) as string[]

      doc.setFontSize(8)
      const evidenceLines = doc.splitTextToSize(`${t.basedOn}: ${evidenceText}`, CARD_TEXT_W) as string[]

      const cardH = titleLines.length * 5 + 2 + descLines.length * 4.5 + 3 + 5 + evidenceLines.length * 4 + 4

      doc.setFillColor(r, g, b)
      doc.rect(M, y - 1, 3, cardH, 'F')

      doc.setFontSize(9.5)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(40, 40, 40)
      doc.text(titleLines, M + 6, y + 4)
      y += titleLines.length * 5 + 2

      doc.setFontSize(9)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(75, 85, 99)
      doc.text(descLines, M + 6, y)
      y += descLines.length * 4.5 + 3

      doc.setFontSize(8.5)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(107, 114, 128)
      doc.text(
        `-${s.coolingC.toFixed(1)}°C ${t.cooling}  |  ~${s.treesEquiv.toLocaleString()} ${t.treeEquiv}  |  ${renderTriggerLabel(s, t)}`,
        M + 6, y,
      )
      y += 5

      doc.setFontSize(8)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(156, 163, 175)
      doc.text(evidenceLines, M + 6, y)
      y += evidenceLines.length * 4 + 5
    })

    const totalCooling = altStrategies.reduce((acc, s) => acc + s.coolingC, 0)
    const totalTrees = altStrategies.reduce((acc, s) => acc + s.treesEquiv, 0)
    y = addPageIfNeeded(doc, y, PH, M)
    doc.setFillColor(240, 253, 244)
    doc.roundedRect(M, y, CW, 14, 2, 2, 'F')
    doc.setDrawColor(187, 247, 208)
    doc.roundedRect(M, y, CW, 14, 2, 2, 'S')
    doc.setFontSize(9.5)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(22, 101, 52)
    doc.text(
      `${t.combinedImpact}: -${totalCooling.toFixed(1)}°C  |  ~${totalTrees.toLocaleString()} ${t.treeEquiv}`,
      M + 6, y + 9,
    )
    y += 20
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const lastPage = (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages()
  doc.setPage(lastPage)
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(160, 160, 160)
  doc.line(M, PH - 18, PW - M, PH - 18)
  doc.text(t.poweredBy, M, PH - 12)
  doc.text('Urban Forest Intelligence  |  Gemma 4 Impact Challenge  |  Global Resilience Track', M, PH - 6)

  doc.save(`urban-forest-${district.replace(/\s+/g, '-').toLowerCase()}-${lang}.pdf`)
}
