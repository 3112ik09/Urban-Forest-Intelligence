# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # start dev server at localhost:3000
npm run build    # production build (also runs type-check and lint)
npm run lint     # ESLint via next lint
npx tsc --noEmit # type-check without building
```

No test suite is configured. Verify behaviour by running the dev server and calling API routes directly:

```bash
curl -s -X POST http://localhost:3000/api/ndvi \
  -H "Content-Type: application/json" \
  -d '{"districtName":"Central Delhi","bbox":[77.165,28.612,77.264,28.786]}'

curl -s -X POST http://localhost:3000/api/analyse \
  -H "Content-Type: application/json" \
  -d '{"district":"Central Delhi","ndvi_pct":6,"canopy_pct":4,"avg_temp_c":38,"built_up_pct":97,"barren_ha":0,"available_rooftops":847,"road_km":23,"wall_count":312,"parking_lots":41,"source":"fallback"}'
```

## Architecture

**Routing split:** The project deliberately mixes Next.js App Router (`app/`) for the UI and Pages Router (`pages/api/`) for the two serverless functions. Do not move the API routes into `app/api/` — they need to stay in `pages/api/` to keep the Pages Router pipeline.

**Data flow on district click:**
1. `app/page.tsx` — user clicks a district → `handleDistrictClick`
2. `POST /api/ndvi` — tries GEE REST API; always falls back to hardcoded estimates if GEE fails; returns `NDVIResult`
3. Map colours update immediately with `canopy_pct` (no waiting for Gemma)
4. `POST /api/analyse` — receives `NDVIResult`, calls Gemma 4, returns `{ analysis, mode }`
5. `AnalysisPanel` renders stats + Gemma prose + strategy cards + PDF button

**GEE integration:** Fully working. Endpoint is `POST /v1/projects/{project}/value:compute` (not `:computeValue`). The expression body uses the format produced by the EE Python serializer (`result`/`values` envelope with `functionInvocationValue` nodes) — see `lib/earthengine.ts`. The service account requires **Earth Engine Resource Writer** role (not Viewer); Viewer lacks compute permission. The fallback in `pages/api/ndvi.ts` still fires if GEE is unreachable. To debug GEE auth/compute issues, run `python3 gee_test.py` (requires `.venv` with `earthengine-api` and `google-auth`).

**Gemma 4 output cleaning:** `gemma-4-31b-it` exposes chain-of-thought in its output. `extractFinalParagraphs()` in `lib/gemma.ts` strips it using two strategies: regex-matching `* *Paragraph N:*` bullet lines first, then falling back to the last 3 clean prose paragraphs. If the model changes its output format, update this function. The model occasionally returns 500s under load — `callGemma()` retries up to 3 times with 1.5s back-off before throwing.

**Leaflet SSR:** `DelhiMap` is loaded with `dynamic(..., { ssr: false })` in `app/page.tsx`. The `next.config.js` webpack config also externalises `leaflet` and `react-leaflet` on the server. Do not import Leaflet in any server-rendered component.

**GeoJSON re-keying:** `DelhiMap` passes `key={geoKey}` to the `<GeoJSON>` component where `geoKey` is derived from `ndviData` + `selectedDistrict`. This forces Leaflet to remount the layer and re-apply styles whenever a district is analysed or selected. Without this, Leaflet's internal style cache would not update.

**Type sharing:** `NDVIResult` is exported from `pages/api/ndvi.ts` and imported in `app/page.tsx`, `components/AnalysisPanel.tsx`, `components/PlantingCards.tsx`, `components/AlternativeCards.tsx`, and `components/ReportDownload.tsx`. `GemmaResponse` is exported from `lib/gemma.ts` and used in the same components. Both types compose into `FullResult = NDVIResult & GemmaResponse` at the page level.

## Environment variables

Required in `.env.local` (never `.env.example`):

| Variable | Purpose |
|---|---|
| `GEMMA_API_KEY` | Google AI Studio key — get from aistudio.google.com |
| `GEE_SERVICE_ACCOUNT` | Service account email for GEE OAuth |
| `GEE_PRIVATE_KEY` | PKCS8 private key; store with literal `\n` (the code does `.replace(/\\n/g, '\n')`) |
| `GEE_PROJECT_ID` | Google Cloud project ID registered with Earth Engine |

## Key files

- `lib/districts.ts` — canonical district name/bbox/center data; source of truth for all 11 districts
- `lib/earthengine.ts` — GEE OAuth2 JWT flow + Sentinel-2 expression builder
- `lib/gemma.ts` — Gemma 4 API call + chain-of-thought stripper + prompt builder
- `public/delhi-districts.geojson` — 11-district polygons fetched from OpenStreetMap Nominatim; do not regenerate unless boundaries need updating
