# Urban Forest Intelligence (UFI)

An AI-powered urban greening platform that identifies, ranks, and plans tree-planting zones across any city using satellite imagery, geospatial analysis, and multi-agent AI.

---

## What it does

1. **City search** — Type any city name. The app geocodes it via Nominatim and fetches administrative district boundaries from OpenStreetMap (Overpass API).
2. **District analysis** — Click a district on the map. The app calls Google Earth Engine to analyse Sentinel-2 satellite imagery and compute:
   - Green cover %, canopy %, built-up %, barren land (ha)
   - Available rooftops, road network (km), wall count, parking lots
   - Surface temperature estimate
3. **Zone discovery** — Barren/degraded patches inside the district are scored using a multi-criteria analysis (MCDA). A two-agent Gemma 4 pipeline then verifies and ranks them:
   - **Agent 1 (Critic)** — reviews each patch against satellite tiles and MCDA scores; approves, flags for review, or rejects
   - **Spatial Validator** — pure TypeScript checks for shape compactness and boundary containment
   - **Agent 2 (Planner)** — receives only approved patches; outputs final ranking, native species recommendations, planting methods, and climate impact estimates
4. **Alternative strategies** — When ground planting is limited, the app surfaces rooftop greening, roadside tree pits, vertical gardens, parking lot de-sealing, reflective surfaces, and permeable pavement as alternatives
5. **PDF report** — Download a full analysis report with zone maps, species lists, and impact projections
6. **Multi-language** — Analysis prose can be translated into English, Hindi, French, Spanish, or German via Gemma

---

## Architecture

```
app/                    Next.js App Router (UI)
  page.tsx              Main page — city search, map, analysis panel
  layout.tsx            Root layout

components/
  CityMap.tsx           Leaflet map — district polygons + zone markers
  AnalysisPanel.tsx     Stats, Gemma prose, zone cards, strategy cards
  PlantingCards.tsx     Individual zone cards with species + impact data
  AlternativeStrategiesPanel.tsx  Alternative greening strategy cards
  ReportDownload.tsx    jsPDF report generator

pages/api/              Next.js Pages Router (serverless functions)
  ndvi.ts               Main analysis endpoint — GEE + zone discovery + Agent pipeline
  analyse.ts            Gemma prose generation endpoint
  translate.ts          Multi-language translation endpoint
  debug-zones.ts        Debug endpoint for zone pipeline inspection

lib/
  geocoding.ts          Nominatim city geocoding + Overpass district boundaries
  earthengine.ts        Google Earth Engine OAuth2 + Sentinel-2 expressions
  gemma.ts              Gemma 4 API client + Agent 1/2 prompts + CoT stripper
  alternativeStrategies.ts  Strategy card data builder
  cityRegistry.ts       Per-city GEE configuration overrides

scripts/                Debug and development utilities (not deployed)
  debugZones.ts         Zone pipeline inspector
  gee_debug.py          GEE auth and compute debugger
  fetch_districts.py    Overpass district boundary fetcher
  gee_node_test.mjs     Node.js GEE token test
```

**Routing:** App Router (`app/`) for UI, Pages Router (`pages/api/`) for API — do not move API routes.

**Streaming:** `/api/ndvi` streams two NDJSON chunks: `{type:'stats'}` after land-cover analysis, `{type:'result'}` after the Agent 2 ranking.

---

## Installation

### Prerequisites

- Node.js 20+
- A [Google AI Studio](https://aistudio.google.com) API key (Gemma 4)
- A Google Cloud project registered with [Earth Engine](https://earthengine.google.com) and a service account with **Earth Engine Resource Writer** role

### 1. Clone and install

```bash
git clone https://github.com/3112ik09/Urban-Forest-Intelligence.git
cd Urban-Forest-Intelligence
npm install
```

### 2. Environment variables

Create `.env.local` in the project root:

```env
GEMMA_API_KEY=your_google_ai_studio_key

GEE_SERVICE_ACCOUNT=your-service-account@your-project.iam.gserviceaccount.com
GEE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----
GEE_PROJECT_ID=your-gcp-project-id
```

> **Note:** Store `GEE_PRIVATE_KEY` with literal `\n` between lines (not actual newlines). The code handles the conversion.

### 3. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 4. Build for production

```bash
npm run build
npm start
```

---

## API reference

### `POST /api/ndvi`

Analyses a district and discovers planting zones.

```json
{
  "districtName": "Westminster",
  "bbox": [-0.175, 51.488, 0.002, 51.532],
  "cityName": "London"
}
```

Streams two NDJSON lines: `{type:"stats", ...}` then `{type:"result", ...}`.

### `POST /api/analyse`

Generates Gemma prose summary for a district.

```json
{
  "district": "Westminster",
  "cityName": "London",
  "ndvi_pct": 6,
  "canopy_pct": 4,
  "avg_temp_c": 38,
  "built_up_pct": 97,
  "barren_ha": 0,
  "available_rooftops": 847,
  "road_km": 23,
  "wall_count": 312,
  "parking_lots": 41,
  "source": "fallback"
}
```

---

## Deployment

Deploy to [Railway](https://railway.app) for zero-config hosting without serverless timeout limits (the analysis pipeline takes ~60s):

1. Push to GitHub
2. New Project → Deploy from GitHub repo
3. Add the 4 environment variables in the Variables tab
4. Settings → Networking → Generate Domain

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App + Pages Router) |
| Map | Leaflet + react-leaflet |
| Satellite data | Google Earth Engine (Sentinel-2) |
| AI agents | Gemma 4 (`gemma-4-31b-it`) via Google AI Studio |
| Geocoding | Nominatim (OpenStreetMap) |
| District boundaries | Overpass API |
| PDF generation | jsPDF |
| Styling | Tailwind CSS |
| Language | TypeScript |
