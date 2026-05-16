# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # start dev server at localhost:3000
npm run build    # production build (also runs type-check and lint)
npm run lint     # ESLint via next lint
npx tsc --noEmit # type-check without building
```


```bash
# Analyse a district in any city
curl -s -X POST http://localhost:3000/api/ndvi \
  -H "Content-Type: application/json" \
  -d '{"districtName":"Westminster","bbox":[-0.175,51.488,0.002,51.532],"cityName":"London"}'

curl -s -X POST http://localhost:3000/api/analyse \
  -H "Content-Type: application/json" \
  -d '{"district":"Westminster","cityName":"London","ndvi_pct":6,"canopy_pct":4,"avg_temp_c":38,"built_up_pct":97,"barren_ha":0,"available_rooftops":847,"road_km":23,"wall_count":312,"parking_lots":41,"source":"fallback"}'
```

## Architecture

See PROJECT_CONTEXT.md for full project history, all architectural decisions,
known bugs, and planned features before making any changes.
No test suite is configured. Verify behaviour by running the dev server and calling API routes directly.

**Routing split:** The project deliberately mixes Next.js App Router (`app/`) for the UI and Pages Router (`pages/api/`) for the two serverless functions. Do not move the API routes into `app/api/` — they need to stay in `pages/api/` to keep the Pages Router pipeline.

**Multi-city flow:**
1. User types a city name → `handleCitySearch` in `app/page.tsx`
2. `geocodeCity()` calls Nominatim to resolve the city to an OSM relation + bbox
3. `fetchCityDistricts()` calls Overpass to get admin sub-boundaries (admin_level 8/9 → 7 → 6 fallback)
4. If Overpass returns 0 districts, the whole city is treated as a single clickable district
5. User clicks a district polygon on the map → `handleDistrictClick`
6. `POST /api/ndvi` — tries GEE REST API; always falls back to generic urban estimates if GEE fails; streams NDJSON
7. Map colours update with `green_cover_pct`
8. `POST /api/analyse` — receives `NDVIResult` + `cityName`, calls Gemma 4, returns `{ analysis, mode }`
9. `AnalysisPanel` renders stats + Gemma prose + strategy cards + PDF button

**Overpass API:** Used for district boundary discovery. Rate limit: 1 req/sec recommended on the free public endpoint (`overpass-api.de`). The `fetchCityDistricts` function retries progressively lower admin_levels (8→9, then 7, then 6) if a level returns 0 results. For cities with no sub-districts in OSM, the whole city bbox is used as a single district.

**GEE integration:** Fully working. Endpoint is `POST /v1/projects/{project}/value:compute` (not `:computeValue`). The expression body uses the format produced by the EE Python serializer (`result`/`values` envelope with `functionInvocationValue` nodes) — see `lib/earthengine.ts`. The service account requires **Earth Engine Resource Writer** role (not Viewer); Viewer lacks compute permission. The fallback in `pages/api/ndvi.ts` still fires if GEE is unreachable. To debug GEE auth/compute issues, run `python3 gee_test.py` (requires `.venv` with `earthengine-api` and `google-auth`).

**Gemma 4 output cleaning:** `gemma-4-31b-it` exposes chain-of-thought in its output. `extractFinalParagraphs()` in `lib/gemma.ts` strips it using two strategies: regex-matching `* *Paragraph N:*` bullet lines first, then falling back to the last 3 clean prose paragraphs. If the model changes its output format, update this function. The model occasionally returns 500s under load — `callGemma()` retries up to 3 times with 1.5s back-off before throwing.

**Leaflet SSR:** `CityMap` is loaded with `dynamic(..., { ssr: false })` in `app/page.tsx`. The `next.config.js` webpack config also externalises `leaflet` and `react-leaflet` on the server. Do not import Leaflet in any server-rendered component.

**GeoJSON re-keying:** `CityMap` passes `key={geoKey}` to the `<GeoJSON>` component where `geoKey` is derived from `ndviData` + `selectedDistrict` + `districts.length`. This forces Leaflet to remount the layer and re-apply styles whenever a district is analysed, selected, or a new city is loaded.

**NDJSON streaming:** `/api/ndvi` streams two chunks: `{type:'stats'}` after Phase 1 (district-level land cover bands), and `{type:'result'}` after Phase 4b (Gemma visual re-ranking). The client reads these incrementally to show progressive results in `AnalysisPanel`.

**Type sharing:** `NDVIResult` is exported from `pages/api/ndvi.ts` and imported in `app/page.tsx`, `components/AnalysisPanel.tsx`, `components/PlantingCards.tsx`, `components/AlternativeCards.tsx`, and `components/ReportDownload.tsx`. `GemmaResponse` is exported from `lib/gemma.ts` and used in the same components. Both types compose into `FullResult = NDVIResult & GemmaResponse` at the page level. `CityDistrict` and `GeocodedCity` are exported from `lib/geocoding.ts`.

## Environment variables

Required in `.env.local` (never `.env.example`):

| Variable | Purpose |
|---|---|
| `GEMMA_API_KEY` | Google AI Studio key — get from aistudio.google.com |
| `GEE_SERVICE_ACCOUNT` | Service account email for GEE OAuth |
| `GEE_PRIVATE_KEY` | PKCS8 private key; store with literal `\n` (the code does `.replace(/\\n/g, '\n')`) |
| `GEE_PROJECT_ID` | Google Cloud project ID registered with Earth Engine |

## Key files

- `lib/geocoding.ts` — Nominatim city geocoding + Overpass district boundary discovery
- `lib/cityRegistry.ts` — Per-city GEE configuration overrides (bareThreshold, targetCanopyPct, geeScale, etc.)
- `lib/earthengine.ts` — GEE OAuth2 JWT flow + Sentinel-2 expression builder (city-agnostic)
- `lib/gemma.ts` — Gemma 4 API call + chain-of-thought stripper + prompt builder
- `components/CityMap.tsx` — Leaflet map that renders district polygons passed as props (replaces DelhiMap)
- `lib/districts.ts` — @deprecated Delhi-only district data; kept as reference, do not use in new code
- `public/delhi-districts.geojson` — Delhi district polygons from OpenStreetMap; kept as fallback reference
