#!/usr/bin/env python3
"""
debug_richmond.py — Full pipeline replay for Richmond County (Staten Island, NYC).

Mirrors every stage of pages/api/ndvi.ts + lib/earthengine.ts + lib/gemma.ts:
  Phase 1  — 4×4 hotspot grid (canopy-deficit ranking)
  Phase 2  — GEE bare-threshold vectorisation → open patches
             + 100ha size cap (same as app)
  Phase 3  — Per-polygon DW band validation + site type inference
  Filter R — Restricted zone filter (Overpass: airports, ports, military…)
  Filter A — Water-band filter (water > 0.20 → drop)
  Filter B — MCDA scoring + pre-filter (built>0.45 | area<0.5ha | water>0.15 → drop)
  Agent 1  — Gemma 4 vision critique, one call PER SITE in parallel (matches app)
  Validator— Spatial compactness check
  Agent 2  — Gemma 4 planner, one call per approved site in parallel (matches app)

Outputs → debug_output/
  tiles/            satellite JPEG tiles for ALL patches, organised by stage
  agent1_raw/       raw Gemma Agent 1 replies per site
  agent2_raw/       raw Gemma Agent 2 replies per site
  agent1_verdicts.json  parsed Agent 1 JSON verdicts
  agent2_plans.json     parsed Agent 2 planting plans
  results.json      structured pipeline results for ALL patches with failure reasons
  grid.png          visual comparison of ALL patches, colour-coded by stage
  pipeline.log      full trace

Usage:
  cd /path/to/delhi-forest-ai
  pip install requests matplotlib pillow cryptography
  python3 debug_richmond.py
"""

import os, sys, json, math, time, base64, datetime, textwrap, io
import concurrent.futures
import requests
from pathlib import Path
from typing import Optional

# ── Optional viz deps ──────────────────────────────────────────────────────────
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    import numpy as np
    from PIL import Image
    HAS_VIZ = True
except ImportError:
    HAS_VIZ = False
    print("[warn] pip install matplotlib pillow numpy  →  to get the visual grid")

# ── Richmond County config ────────────────────────────────────────────────────
DISTRICT_NAME = "Richmond County"
CITY_NAME     = "New York"

# Staten Island bbox [minLon, minLat, maxLon, maxLat]
BBOX = [-74.2606, 40.4774, -74.0342, 40.6505]

# Matches cityRegistry.ts 'new york' key
CONFIG = {
    "bareThreshold":   0.10,
    "minPatchHa":      0.15,
    "targetCanopyPct": 0.35,
    "geeScale":        10,
}

OUT_DIR       = Path("debug_output")
TILE_DIR      = OUT_DIR / "tiles"
A1_RAW_DIR    = OUT_DIR / "agent1_raw"
A2_RAW_DIR    = OUT_DIR / "agent2_raw"
LOG_FILE      = OUT_DIR / "pipeline.log"

# Stage sub-dirs under tiles/
STAGE_DIRS = [
    "size_cap_rejected", "restricted_rejected", "water_rejected",
    "mcda_rejected", "agent1_rejected", "agent2_rejected", "selected"
]

# ── Load .env.local ────────────────────────────────────────────────────────────
def load_env(path=".env.local"):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        print(f"[error] {path} not found — run from the project root")
        sys.exit(1)
    return env

ENV         = load_env()
GEMMA_KEY   = ENV.get("GEMMA_API_KEY", "")
GEE_SA      = ENV.get("GEE_SERVICE_ACCOUNT", "")
GEE_PEM     = ENV.get("GEE_PRIVATE_KEY", "").replace("\\n", "\n")
GEE_PROJECT = ENV.get("GEE_PROJECT_ID", "")

if not all([GEMMA_KEY, GEE_SA, GEE_PEM, GEE_PROJECT]):
    print("[error] Missing env vars. Check .env.local for GEMMA_API_KEY, "
          "GEE_SERVICE_ACCOUNT, GEE_PRIVATE_KEY, GEE_PROJECT_ID")
    sys.exit(1)

# ── Logging ────────────────────────────────────────────────────────────────────
OUT_DIR.mkdir(exist_ok=True)
TILE_DIR.mkdir(exist_ok=True)
A1_RAW_DIR.mkdir(exist_ok=True)
A2_RAW_DIR.mkdir(exist_ok=True)
for sd in STAGE_DIRS:
    (TILE_DIR / sd).mkdir(exist_ok=True)

_log: list[str] = []

def log(msg: str, level="INFO"):
    ts   = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    _log.append(line)

def save_log():
    LOG_FILE.write_text("\n".join(_log))

# ── GEE auth ───────────────────────────────────────────────────────────────────
def _make_jwt() -> str:
    try:
        from cryptography.hazmat.primitives import hashes as ch, serialization as cs
        from cryptography.hazmat.primitives.asymmetric import padding as cp
        from cryptography.hazmat.backends import default_backend
    except ImportError:
        print("[error] pip install cryptography")
        sys.exit(1)

    now = int(time.time())
    hdr = base64.urlsafe_b64encode(
        json.dumps({"alg": "RS256", "typ": "JWT"}).encode()
    ).rstrip(b"=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "iss":   GEE_SA,
        "scope": "https://www.googleapis.com/auth/earthengine",
        "aud":   "https://oauth2.googleapis.com/token",
        "iat":   now, "exp": now + 3600,
    }).encode()).rstrip(b"=")

    msg = hdr + b"." + payload
    key = cs.load_pem_private_key(GEE_PEM.encode(), password=None,
                                   backend=default_backend())
    sig = key.sign(msg, cp.PKCS1v15(), ch.SHA256())
    return (msg + b"." + base64.urlsafe_b64encode(sig).rstrip(b"=")).decode()

def get_gee_token() -> str:
    log("Getting GEE token...")
    r = requests.post(
        "https://oauth2.googleapis.com/token",
        data=f"grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={_make_jwt()}",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    r.raise_for_status()
    tok = r.json()["access_token"]
    log("GEE auth OK")
    return tok

# ── GEE expression builders (mirrors earthengine.ts) ──────────────────────────
def c(v):           return {"constantValue": v}
def fn(name, args): return {"functionInvocationValue": {"functionName": name, "arguments": args}}

def _dates():
    end   = datetime.date.today()
    start = end.replace(year=end.year - 1)
    return str(start), str(end)

def _dw_mean():
    s, e = _dates()
    return fn("reduce.mean", {"collection": fn("Collection.filter", {
        "collection": fn("ImageCollection.load", {"id": c("GOOGLE/DYNAMICWORLD/V1")}),
        "filter": fn("Filter.dateRangeContains", {
            "leftValue": fn("DateRange", {"start": c(s), "end": c(e)}),
            "rightField": c("system:time_start"),
        }),
    })})

def _dw_all_bands():
    return fn("Image.select", {
        "input": _dw_mean(),
        "bandSelectors": c(["trees","grass","bare","built","water","shrub_and_scrub"]),
    })

def _bare_mask(thr):
    return fn("Image.selfMask", {"image": fn("Image.gt", {
        "image1": fn("Image.select", {"input": _dw_mean(), "bandSelectors": c(["bare"])}),
        "image2": fn("Image.constant", {"value": c(thr)}),
    })})

def _poly_node(coords):
    return fn("GeometryConstructors.Polygon", {"coordinates": c(coords), "evenOdd": c(True)})

def _bbox_ring(bbox):
    a, b, d, e = bbox
    return [[[a,b],[d,b],[d,e],[a,e],[a,b]]]

def gee_compute(token: str, expr) -> dict:
    wrapped = {"result": "0", "values": {"0": expr}}
    url = f"https://earthengine.googleapis.com/v1/projects/{GEE_PROJECT}/value:compute"
    r = requests.post(url,
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type":  "application/json"},
        json={"expression": wrapped},
        timeout=90)
    if not r.ok:
        raise RuntimeError(f"GEE {r.status_code}: {r.text[:400]}")
    return r.json().get("result") or {}

# ── DW band helpers ────────────────────────────────────────────────────────────
BAND_KEYS = ["trees","grass","bare","built","water","shrub_and_scrub"]

def _parse_bands(result) -> dict:
    r = result if isinstance(result, dict) else {}
    return {k: float(r.get(k, 0)) for k in BAND_KEYS}

def fetch_bands(ring: list, token: str, scale: int) -> dict:
    closed = ring if ring[0] == ring[-1] else ring + [ring[0]]
    expr = fn("Image.reduceRegion", {
        "image":      _dw_all_bands(),
        "reducer":    fn("Reducer.mean", {}),
        "geometry":   _poly_node([closed]),
        "scale":      c(scale),
        "maxPixels":  c(int(1e8)),
        "bestEffort": c(True),
    })
    return _parse_bands(gee_compute(token, expr))

# ── Geometry helpers ───────────────────────────────────────────────────────────
def ring_area_ha(ring: list) -> float:
    area = 0.0
    for i in range(len(ring) - 1):
        area += ring[i][0]*ring[i+1][1] - ring[i+1][0]*ring[i][1]
    avg_lat = sum(r[1] for r in ring) / len(ring)
    return abs(area)/2 * 110_570 * 111_320 * math.cos(avg_lat*math.pi/180) / 10_000

def ring_centroid(ring: list) -> dict:
    n = len(ring) - 1
    return {"lat": sum(r[1] for r in ring[:n])/n,
            "lon": sum(r[0] for r in ring[:n])/n}

def ring_compactness(ring: list) -> float:
    if len(ring) < 4: return 0.5
    area = abs(sum(ring[i][0]*ring[i+1][1] - ring[i+1][0]*ring[i][1]
                   for i in range(len(ring)-1))) / 2
    peri = sum(math.hypot(ring[i+1][0]-ring[i][0], ring[i+1][1]-ring[i][1])
               for i in range(len(ring)-1))
    return (4*math.pi*area / peri**2) if peri > 0 else 0

def infer_site_type(b: dict) -> str:
    trees, grass, bare, built, water, shrub = (
        b["trees"], b["grass"], b["bare"], b["built"], b["water"], b["shrub_and_scrub"])
    if water > 0.12 or built > 0.45: return "unknown"
    if grass > 0.25:                  return "park_or_green"
    if bare > 0.20 and shrub > 0.10:  return "degraded_scrub"
    if bare > 0.20 and built < 0.35:  return "vacant_land"
    if shrub > 0.20:                  return "scrubland"
    if trees > 0.15:                  return "low_canopy"
    return "mixed_open"

# ── Point-in-polygon (ray casting) ───────────────────────────────────────────
# ring is list of [lon, lat] pairs — GeoJSON order, same as app
def point_in_polygon(lat: float, lon: float, ring: list) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]   # xi=lon, yi=lat
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

# ── Restricted zone filter (mirrors fetchRestrictedPolygons in ndvi.ts) ────────
def fetch_restricted_polygons(bbox: list) -> list:
    min_lon, min_lat, max_lon, max_lat = bbox
    query = (
        f"[out:json][timeout:20];("
        f'way["aeroway"~"aerodrome|runway|taxiway|apron"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'relation["aeroway"="aerodrome"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'way["landuse"~"military|industrial|landfill|quarry|railway|port|harbour"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'relation["landuse"~"military|industrial|landfill|quarry|railway|port|harbour"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'way["man_made"~"pier|jetty|breakwater|quay|dock|wharf"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'way["waterway"="dock"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'way["natural"="water"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'relation["natural"="water"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'way["leisure"="marina"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'way["railway"~"rail|light_rail|subway|tram"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'way["amenity"="prison"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f'way["power"~"plant|substation"]({min_lat},{min_lon},{max_lat},{max_lon});'
        f");out geom;"
    )
    try:
        r = requests.post(
            "https://overpass-api.de/api/interpreter",
            data={"data": query},
            timeout=28,
        )
        if not r.ok:
            log(f"Overpass restricted zones: {r.status_code} — skipping filter", "WARN")
            return []
        elements = r.json().get("elements", [])
        polygons = []
        for el in elements:
            if el.get("type") == "way" and el.get("geometry"):
                ring = [[n["lon"], n["lat"]] for n in el["geometry"]]
                if len(ring) >= 3:
                    polygons.append(ring)
            elif el.get("type") == "relation" and el.get("members"):
                # Build outer ring by concatenating outer member way geometries
                outer_pts: list = []
                for m in el["members"]:
                    if m.get("type") == "way" and m.get("role") in ("outer", "") and m.get("geometry"):
                        seg = [[n["lon"], n["lat"]] for n in m["geometry"]]
                        outer_pts.extend(seg)
                if len(outer_pts) >= 3:
                    polygons.append(outer_pts)
        log(f"Restricted zones: {len(polygons)} polygons from Overpass "
            f"({len(elements)} OSM elements)")
        return polygons
    except Exception as ex:
        log(f"fetch_restricted_polygons failed (non-fatal): {ex}", "WARN")
        return []

# ── Phase 1 — Hotspot scan ────────────────────────────────────────────────────
def phase1_hotspots(bbox, token, cfg) -> list:
    log("═"*60)
    log("PHASE 1 — 4×4 coarse grid hotspot scan")
    minLon, minLat, maxLon, maxLat = bbox
    rows = cols = 4
    dLon = (maxLon - minLon) / cols
    dLat = (maxLat - minLat) / rows

    cells = []
    for r in range(rows):
        for col in range(cols):
            cells.append([minLon + col*dLon, minLat + r*dLat,
                          minLon + (col+1)*dLon, minLat + (r+1)*dLat])

    results = []
    log(f"Fetching DW bands for {len(cells)} grid cells...")
    for i, cbb in enumerate(cells):
        try:
            b = fetch_bands(_bbox_ring(cbb)[0], token, cfg["geeScale"])
            deficit = max(0, cfg["targetCanopyPct"] - b["trees"] - b["shrub_and_scrub"])
            results.append({"bbox": cbb, "bands": b,
                            "canopyDeficit": round(deficit, 3),
                            "avgBare": round(b["bare"], 3),
                            "avgBuilt": round(b["built"], 3)})
            log(f"  Cell {i+1:02d}: bare={b['bare']:.3f} built={b['built']:.3f} "
                f"trees={b['trees']:.3f} water={b['water']:.3f} deficit={deficit:.3f}")
        except Exception as ex:
            log(f"  Cell {i+1:02d} FAILED: {ex}", "WARN")

    results.sort(key=lambda x: -x["canopyDeficit"])
    top8    = results[:8]
    reserve = results[8:]
    log(f"Phase 1 done — top 8 hotspots by canopy deficit:")
    for i, h in enumerate(top8):
        log(f"  Hotspot {i+1}: bare={h['avgBare']} built={h['avgBuilt']} "
            f"deficit={h['canopyDeficit']}  bbox={[round(x,4) for x in h['bbox']]}")
    log(f"  Reserve cells: {len(reserve)} (used if Phase 2 yields < 5 patches)")
    return top8, reserve

# ── Phase 2 — Open-ground patch discovery ─────────────────────────────────────
def phase2_patches(hotspot_bboxes, token, cfg) -> list:
    log("═"*60)
    log(f"PHASE 2 — GEE reduceToVectors in {len(hotspot_bboxes)} hotspot areas "
        f"(bare > {cfg['bareThreshold']}, minPatch={cfg['minPatchHa']}ha)")
    all_patches = []

    for idx, area_bbox in enumerate(hotspot_bboxes):
        minLon, minLat, maxLon, maxLat = area_bbox
        expr = fn("Image.reduceToVectors", {
            "image":          _bare_mask(cfg["bareThreshold"]),
            "scale":          c(cfg["geeScale"] * 2),
            "geometry":       _poly_node([[[minLon,minLat],[maxLon,minLat],
                                           [maxLon,maxLat],[minLon,maxLat],[minLon,minLat]]]),
            "maxPixels":      c(int(5e6)),
            "bestEffort":     c(True),
            "geometryType":   c("polygon"),
            "eightConnected": c(False),
            "labelProperty":  c(None),
        })
        try:
            result = gee_compute(token, expr)
            feats  = result.get("features", []) if isinstance(result, dict) else []
            log(f"  Area {idx+1}: {len(feats)} raw polygon features from GEE")
            for j, feat in enumerate(feats):
                geom = feat.get("geometry", {})
                if geom.get("type") != "Polygon": continue
                ring = geom["coordinates"][0]
                if len(ring) < 4: continue
                area_ha = ring_area_ha(ring)
                if area_ha < cfg["minPatchHa"]: continue
                all_patches.append({
                    "id":       f"p{idx}_{j}",
                    "ring":     ring,
                    "areaHa":   round(area_ha, 2),
                    "centroid": ring_centroid(ring),
                })
        except Exception as ex:
            log(f"  Area {idx+1} FAILED: {ex}", "WARN")

    all_patches.sort(key=lambda x: -x["areaHa"])
    log(f"Phase 2 done — {len(all_patches)} patches ≥ {cfg['minPatchHa']}ha")
    return all_patches

# ── Phase 3 — Per-polygon validation ──────────────────────────────────────────
def phase3_validate(patches, token, cfg) -> list:
    log("═"*60)
    log(f"PHASE 3 — Per-polygon DW band validation ({min(len(patches),20)} patches)")
    validated = []

    for i, p in enumerate(patches[:20]):
        try:
            ring   = p["ring"]
            closed = ring if ring[0] == ring[-1] else ring + [ring[0]]
            b      = fetch_bands(closed, token, cfg["geeScale"])
            stype  = infer_site_type(b)
            canopy = round((b["trees"] + b["shrub_and_scrub"]) * 100)

            place = None
            try:
                lat, lon = p["centroid"]["lat"], p["centroid"]["lon"]
                r = requests.get(
                    f"https://nominatim.openstreetmap.org/reverse"
                    f"?lat={lat}&lon={lon}&format=json&zoom=16",
                    headers={"User-Agent": "UrbanForestDebug/1.0"}, timeout=6)
                if r.ok:
                    addr  = r.json().get("address", {})
                    place = (addr.get("park") or addr.get("leisure") or
                             addr.get("amenity") or addr.get("suburb") or
                             addr.get("neighbourhood"))
            except Exception: pass
            time.sleep(0.5)

            validated.append({**p, "bands": b, "siteType": stype,
                              "placeName": place, "canopyPct": canopy})
            log(f"  {i+1:02d}. {p['id']:12s} {stype:15s} {p['areaHa']:.1f}ha  "
                f"bare={b['bare']:.2f} built={b['built']:.2f} "
                f"water={b['water']:.2f} trees={b['trees']:.2f}  "
                f"name={place or '—'}")
        except Exception as ex:
            log(f"  {i+1:02d}. {p['id']} FAILED: {ex}", "WARN")

    log(f"Phase 3 done — {len(validated)} validated")
    return validated

# ── MCDA + pre-filter (mirrors computeMCDA + topCandidates logic in ndvi.ts) ──
SITE_BONUS = {
    "park_or_green": 0.90, "degraded_scrub": 0.70, "scrubland": 0.65,
    "vacant_land": 0.60, "low_canopy": 0.50, "mixed_open": 0.40, "unknown": 0.10,
}

def mcda_and_prefilter(patches, cfg) -> tuple[list, list]:
    """Mirrors computeMCDA() + topCandidates filter in buildZonesWithGemma()."""
    log("═"*60)
    log("FILTER B — MCDA scoring + pre-filter (built>0.45 | area<0.5ha | water>0.15)")

    scored = []
    for p in patches:
        b       = p["bands"]
        deficit = max(0, cfg["targetCanopyPct"] - b["trees"] - b["shrub_and_scrub"])
        open_   = max(0, 1 - b["built"])
        area_s  = min(1, math.log10(max(p["areaHa"], 0.3)) / math.log10(50))
        bonus   = SITE_BONUS.get(p["siteType"], 0.10)
        raw     = deficit*0.35 + open_*0.30 + area_s*0.20 + bonus*0.15
        scored.append({**p, "mcdaRaw": raw, "mcdaScore": round(raw * 100)})

    # Normalise against max (same as app's computeMCDA)
    max_s = max((s["mcdaScore"] for s in scored), default=1)
    for s in scored:
        s["mcdaScore"] = round(s["mcdaScore"] / max_s * 100)

    log("  MCDA scores (all patches):")
    for p in sorted(scored, key=lambda x: -x["mcdaScore"]):
        log(f"    MCDA={p['mcdaScore']:3d}  {p['id']:12s}  {p['siteType']:15s}  "
            f"area={p['areaHa']:.1f}ha")

    # Top-10 by MCDA, then hard-filter (same as app: built<=0.45, area>=0.5, water<=0.15)
    top10 = sorted(scored, key=lambda x: -x["mcdaScore"])[:10]
    candidates = []
    rejected   = []
    for p in top10:
        b = p["bands"]
        reasons = []
        if b["built"]  > 0.45: reasons.append(f"built={b['built']:.2f}>0.45")
        if p["areaHa"] < 0.5:  reasons.append(f"area={p['areaHa']:.2f}<0.5ha")
        if b["water"]  > 0.15: reasons.append(f"water={b['water']:.2f}>0.15")
        if reasons:
            p["drop_reason"] = ", ".join(reasons)
            rejected.append(p)
            log(f"  DROP {p['id']:12s} MCDA={p['mcdaScore']:3d}: {p['drop_reason']}")
        elif len(candidates) >= 7:
            p["drop_reason"] = "outside top-7 cap"
            rejected.append(p)
            log(f"  DROP {p['id']:12s} MCDA={p['mcdaScore']:3d}: outside top-7 cap")
        else:
            candidates.append(p)

    log(f"Pre-filter: top10 → {len(candidates)} candidates for Agent 1")
    return candidates, rejected

# ── Satellite tile ─────────────────────────────────────────────────────────────
def fetch_tile(lat: float, lon: float, zoom=16):
    z  = zoom
    x  = int((lon + 180) / 360 * 2**z)
    lr = lat * math.pi / 180
    y  = int((1 - math.log(math.tan(lr) + 1/math.cos(lr)) / math.pi) / 2 * 2**z)
    url = (f"https://server.arcgisonline.com/ArcGIS/rest/services/"
           f"World_Imagery/MapServer/tile/{z}/{y}/{x}")
    try:
        r = requests.get(url, timeout=10)
        return r.content if r.ok else None
    except Exception:
        return None

def save_tile(patch, stage: str) -> Optional[Path]:
    lat, lon = patch["centroid"]["lat"], patch["centroid"]["lon"]
    data = fetch_tile(lat, lon)
    if not data:
        log(f"  Tile fetch failed for {patch['id']}", "WARN")
        return None
    fpath = TILE_DIR / stage / f"{patch['id']}.jpg"
    fpath.write_bytes(data)
    return fpath

# ── Agent 1 — single-site call (matches app's per-site runAgentCritic) ────────
def _agent1_single(p: dict, tile_bytes: Optional[bytes]) -> dict:
    """One Agent 1 call for ONE site — mirrors the app's parallel per-site approach."""
    b = p["bands"]
    site_desc = (
        f"[UNKNOWN TYPE — infer from image]" if p["siteType"] == "unknown"
        else (p.get("placeName") or p["siteType"])
    )
    site_line = (
        f"Site 1 (id: {p['id']}): {site_desc} — "
        f"MCDA: {p['mcdaScore']}/100, area: {p['areaHa']:.1f}ha, "
        f"canopy: {p['canopyPct']}%, "
        f"bare: {round(b['bare']*100)}%, built: {round(b['built']*100)}%, "
        f"water: {round(b['water']*100)}%, "
        f"trees: {round(b['trees']*100)}%, grass: {round(b['grass']*100)}%"
    )

    prompt = f"""You are Agent 1 — Urban Forest Site Critic for {DISTRICT_NAME}, {CITY_NAME}.

Your job: Review each candidate planting site using BOTH the MCDA score AND the satellite image.
The MCDA score is computed from satellite band data. Your visual inspection may confirm or override it.

MCDA Formula:
  Score = canopy_deficit×0.35 + openness×0.30 + area_score×0.20 + site_type_bonus×0.15
  100 = ideal planting site. 0 = completely unsuitable.

Satellite tiles are attached above — one per site in the same order as the list below.

Sites to evaluate:
{site_line}

RULES:
- REJECT if image shows: active construction, water body, ferry terminal, port/dock apron, pier, quay, marina, rooftop, airport/runway, highway surface
- REJECT if built fraction > 0.45 (dense urban fabric, not plantable)
- REVIEW if MCDA > 60 but image shows fragmented or narrow shape
- APPROVE if image confirms open/bare land matching the band data
- Your adjusted_score should reflect both the formula AND what you see

For sites marked [UNKNOWN TYPE — infer from image]:
  Look at the surrounding context in the satellite tile — nearby roads, buildings, vegetation patches, fences, lot boundaries.
  Deduce the most likely land use (vacant lot, road median, parking area, brownfield, etc.) and set inferred_site_type accordingly.
  Use that inferred type to decide verdict and adjusted_score, not the "unknown" label.

Return ONLY a valid JSON array. No prose, no markdown fences.
Each element must have exactly these keys:
{{"site_id":"<id string>","verdict":"approve"|"review"|"reject","mcda_score":<number>,"visual_confidence":<0-1>,"adjusted_score":<0-100>,"issues":["..."],"positive_signals":["..."],"reasoning":"<one sentence>","inferred_site_type":"<only for unknown sites, else omit>"}}"""

    parts: list = []
    if tile_bytes:
        parts.append({"inlineData": {"mimeType": "image/jpeg",
                                      "data": base64.b64encode(tile_bytes).decode()}})
    parts.append({"text": prompt})

    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 4096},
    }
    url = (f"https://generativelanguage.googleapis.com/v1beta/"
           f"models/gemma-4-31b-it:generateContent?key={GEMMA_KEY}")

    for attempt in range(1, 4):
        r = requests.post(url, json=body, timeout=90)
        if r.status_code == 500 and attempt < 3:
            time.sleep(attempt * 1.5)
            continue
        if not r.ok:
            raise RuntimeError(f"Gemma {r.status_code}: {r.text[:300]}")
        raw = (r.json()
               .get("candidates", [{}])[0]
               .get("content", {})
               .get("parts", [{}])[0]
               .get("text", ""))
        break
    else:
        raise RuntimeError("Gemma failed after 3 attempts")

    # Save raw reply
    (A1_RAW_DIR / f"{p['id']}.txt").write_text(raw)

    # Extract last well-formed JSON array (strip chain-of-thought)
    parsed = _extract_json_array(raw)
    if parsed:
        for item in parsed:
            if isinstance(item, dict) and "verdict" in item:
                return item

    log(f"  Agent 1 JSON parse failed for {p['id']} — defaulting to approve", "WARN")
    return {
        "site_id": p["id"], "verdict": "approve",
        "mcda_score": p["mcdaScore"], "visual_confidence": 0.5,
        "adjusted_score": p["mcdaScore"], "issues": [],
        "positive_signals": [], "reasoning": "Agent 1 parsing failed — defaulting to approve",
    }

def _extract_json_array(text: str) -> Optional[list]:
    """Mirrors extractJsonArray in gemma.ts — backward scan from last ']'."""
    clean = text.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1] if "\n" in clean else clean[3:]
    if clean.endswith("```"):
        clean = clean.rsplit("```", 1)[0]
    clean = clean.strip()

    try:
        p = json.loads(clean)
        if isinstance(p, list) and len(p) > 0:
            return p
    except Exception: pass

    end = clean.rfind("]")
    while end >= 0:
        depth, in_str, esc, start = 0, False, False, -1
        for i in range(end, -1, -1):
            ch = clean[i]
            if esc: esc = False; continue
            if ch == "\\" and in_str: esc = True; continue
            if ch == '"': in_str = not in_str; continue
            if in_str: continue
            if ch in "]}": depth += 1
            elif ch == "{": depth -= 1
            elif ch == "[":
                depth -= 1
                if depth == 0: start = i; break
        if start != -1:
            try:
                p = json.loads(clean[start:end+1])
                if isinstance(p, list) and len(p) > 0:
                    return p
            except Exception: pass
        end = clean.rfind("]", 0, end)
    return None

def run_agent1_parallel(candidates: list, tile_bytes_map: dict) -> dict:
    """One Agent 1 call per site, all in parallel — matches app behavior."""
    log("═"*60)
    log(f"AGENT 1 — Gemma 4 vision critique, {len(candidates)} parallel per-site calls")

    results: dict[str, dict] = {}

    def _call(p):
        try:
            return p["id"], _agent1_single(p, tile_bytes_map.get(p["id"]))
        except Exception as ex:
            log(f"  Agent 1 failed for {p['id']}: {ex}", "WARN")
            return p["id"], {
                "site_id": p["id"], "verdict": "approve",
                "mcda_score": p["mcdaScore"], "visual_confidence": 0.5,
                "adjusted_score": p["mcdaScore"], "issues": [],
                "positive_signals": [], "reasoning": "Agent 1 call failed",
            }

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(7, len(candidates))) as ex:
        futures = [ex.submit(_call, p) for p in candidates]
        for f in concurrent.futures.as_completed(futures):
            pid, verdict = f.result()
            results[pid] = verdict
            log(f"  ✓ Agent 1 done: {pid} → {verdict['verdict']} "
                f"(adjusted_score={verdict['adjusted_score']})")

    log(f"Agent 1 done: "
        f"{sum(1 for v in results.values() if v['verdict']=='approve')} approved, "
        f"{sum(1 for v in results.values() if v['verdict']=='review')} review, "
        f"{sum(1 for v in results.values() if v['verdict']=='reject')} rejected")
    return results

# ── Spatial Validator ──────────────────────────────────────────────────────────
def spatial_validator(candidates: list, verdict_map: dict) -> dict:
    log("═"*60)
    log("SPATIAL VALIDATOR — compactness check")
    results: dict[str, dict] = {}
    for p in candidates:
        v        = verdict_map.get(p["id"])
        verdict  = v["verdict"] if v else "approve"
        adj      = v["adjusted_score"] if v else 50
        comp     = ring_compactness(p.get("ring", []))

        if verdict == "reject":
            passed, reason = False, "Agent 1 reject"
        elif verdict == "approve" and comp < 0.10:
            passed, reason = False, f"shape too fragmented (compactness={comp:.3f})"
        elif verdict == "review" and adj > 50 and comp >= 0.10:
            passed, reason = True, "review + high adjusted score"
        elif verdict == "review":
            passed, reason = False, "review + low adjusted score"
        else:
            passed, reason = True, "approved"

        log(f"  {p['id']:12s}: verdict={verdict:6s} compactness={comp:.3f} "
            f"passed={passed} ({reason})")
        results[p["id"]] = {"passed": passed, "compactness": comp, "reason": reason}
    return results

# ── Agent 2 — single-site call (matches app's per-site runAgentPlanner) ───────
def _resolve_species_guidance(city: str) -> str:
    c = city.lower()
    if any(x in c for x in ["delhi","lucknow","agra","jaipur","chandigarh"]):
        return "Delhi/North India: Neem, Peepal, Amaltas, Arjun, Jamun"
    if any(x in c for x in ["mumbai","pune","goa","surat","thane"]):
        return "Mumbai/Coastal: Coconut, Rain Tree, Gulmohar, Mangrove (near water)"
    if any(x in c for x in ["bangalore","bengaluru","hyderabad","mysore"]):
        return "Bangalore/Deccan: Silver Oak, Tabebuia, Rain Tree, Honge"
    if any(x in c for x in ["london","manchester","edinburgh","bristol","birmingham"]):
        return "London/Temperate: Oak, Lime, Plane, Hawthorn, Rowan"
    if any(x in c for x in ["new york","chicago","toronto","boston","philadelphia"]):
        return "New York/Continental: Red Maple, Sweetgum, Ginkgo, London Plane"
    if any(x in c for x in ["tokyo","osaka","seoul","kyoto","yokohama"]):
        return "Tokyo/Humid subtropical: Cherry (Sakura), Zelkova, Camphor, Ginkgo"
    if any(x in c for x in ["nairobi","addis","kampala","kigali"]):
        return "Nairobi/Tropical highland: Grevillea, Jacaranda, Nandi Flame, Croton"
    return "Generic: select drought-tolerant native species appropriate for the climate"

def _agent2_single(p: dict, critique: dict, rank_hint: int, tile_bytes: Optional[bytes]) -> dict:
    """One Agent 2 call for ONE approved site."""
    plantable_ha = min(p["areaHa"] * 0.70, 40)
    species_guidance = _resolve_species_guidance(CITY_NAME)
    site_line = (
        f"Site 1 (id: {p['id']}): {p.get('placeName') or p['siteType']} — "
        f"{p['areaHa']:.1f}ha total, ~{plantable_ha:.1f}ha plantable, "
        f"Agent 1: \"{critique.get('reasoning','approved')}\", "
        f"adjusted_score: {critique.get('adjusted_score', p.get('mcdaScore', 50))}"
        + (f", issues: {', '.join(critique['issues'])}" if critique.get("issues") else "")
        + (f", positives: {', '.join(critique['positive_signals'])}"
           if critique.get("positive_signals") else "")
    )

    prompt = f"""You are Agent 2 — Urban Forest Planner for {DISTRICT_NAME}, {CITY_NAME}.
Agent 1 has already critiqued and approved this site.
Your job: create an actionable planting plan using Agent 1's visual analysis.

Climate zone species guidance: {species_guidance}

Impact estimation formulas (err conservative):
  estimated_trees ≈ plantableHa × 650 (cap at 25000)
  temp_reduction_c ≈ plantableHa × 0.12 (cap at 2.5)
  carbon_10yr_tons ≈ estimated_trees × 0.025
  people_impacted ≈ plantableHa × 150
  cost_estimate_inr ≈ estimated_trees × 450

Approved site:
{site_line}

Satellite tile for this site is attached above.
Recommend 2-3 species native/suitable to {CITY_NAME}'s climate.

Return ONLY a valid JSON array with one AgentPlan object. No prose, no markdown.
Each element: {{"site_id":"<id>","final_rank":{rank_hint},"plantable":true,"species":[{{"name":"<s>","why":"<phrase>"}}],"planting_method":"<method>","estimated_trees":<n>,"temp_reduction_c":<n>,"carbon_10yr_tons":<n>,"people_impacted":<n>,"cost_estimate_inr":<n>,"reasoning":"<one sentence>"}}"""

    parts: list = []
    if tile_bytes:
        parts.append({"inlineData": {"mimeType": "image/jpeg",
                                      "data": base64.b64encode(tile_bytes).decode()}})
    parts.append({"text": prompt})

    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096},
    }
    url = (f"https://generativelanguage.googleapis.com/v1beta/"
           f"models/gemma-4-31b-it:generateContent?key={GEMMA_KEY}")

    for attempt in range(1, 4):
        r = requests.post(url, json=body, timeout=90)
        if r.status_code == 500 and attempt < 3:
            time.sleep(attempt * 1.5)
            continue
        if not r.ok:
            raise RuntimeError(f"Gemma {r.status_code}: {r.text[:300]}")
        raw = (r.json()
               .get("candidates", [{}])[0]
               .get("content", {})
               .get("parts", [{}])[0]
               .get("text", ""))
        break
    else:
        raise RuntimeError("Gemma Agent 2 failed after 3 attempts")

    (A2_RAW_DIR / f"{p['id']}.txt").write_text(raw)
    parsed = _extract_json_array(raw)
    if parsed:
        for item in parsed:
            if isinstance(item, dict) and "plantable" in item:
                return item

    log(f"  Agent 2 JSON parse failed for {p['id']} — using formula fallback", "WARN")
    trees = min(25000, round(plantable_ha * 650))
    return {
        "site_id": p["id"], "final_rank": rank_hint, "plantable": True,
        "species": [{"name": "Native species", "why": "suitable for local climate"}],
        "planting_method": "ground planting",
        "estimated_trees": trees,
        "temp_reduction_c": round(min(2.5, plantable_ha * 0.12), 1),
        "carbon_10yr_tons": round(trees * 0.025, 1),
        "people_impacted": round(plantable_ha * 150),
        "cost_estimate_inr": trees * 450,
        "reasoning": "Agent 2 unavailable — formula estimate",
    }

def run_agent2_parallel(approved: list, verdict_map: dict, tile_bytes_map: dict) -> dict:
    """One Agent 2 call per approved site, all in parallel — matches app behavior."""
    log("═"*60)
    log(f"AGENT 2 — Gemma 4 planner, {len(approved)} parallel per-site calls")

    results: dict[str, dict] = {}

    def _call(p, rank_hint):
        try:
            critique = verdict_map.get(p["id"], {})
            plan = _agent2_single(p, critique, rank_hint, tile_bytes_map.get(p["id"]))
            return p["id"], plan
        except Exception as ex:
            log(f"  Agent 2 failed for {p['id']}: {ex}", "WARN")
            plantable_ha = min(p["areaHa"] * 0.70, 40)
            trees = min(25000, round(plantable_ha * 650))
            return p["id"], {
                "site_id": p["id"], "final_rank": rank_hint, "plantable": True,
                "species": [{"name": "Native species", "why": "suitable for local climate"}],
                "planting_method": "ground planting",
                "estimated_trees": trees,
                "temp_reduction_c": round(min(2.5, plantable_ha * 0.12), 1),
                "carbon_10yr_tons": round(trees * 0.025, 1),
                "people_impacted": round(plantable_ha * 150),
                "cost_estimate_inr": trees * 450,
                "reasoning": "Agent 2 call failed — formula fallback",
            }

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(7, len(approved))) as ex:
        futures = [ex.submit(_call, p, i+1) for i, p in enumerate(approved)]
        for f in concurrent.futures.as_completed(futures):
            pid, plan = f.result()
            results[pid] = plan
            log(f"  ✓ Agent 2 done: {pid} → plantable={plan['plantable']} "
                f"trees={plan['estimated_trees']}")

    return results

# ── Visualization ──────────────────────────────────────────────────────────────
STAGE_COLOR = {
    "selected":           "#16a34a",   # green
    "agent2_rejected":    "#7c3aed",   # purple
    "agent1_rejected":    "#dc2626",   # red
    "validator_rejected": "#f97316",   # orange
    "mcda_rejected":      "#d97706",   # amber
    "water_rejected":     "#2563eb",   # blue
    "restricted_rejected":"#0e7490",   # teal
    "size_cap_rejected":  "#6b7280",   # grey
}
STAGE_LABEL = {
    "selected":           "✓ SELECTED",
    "agent2_rejected":    "✗ AGENT 2",
    "agent1_rejected":    "✗ AGENT 1",
    "validator_rejected": "✗ VALIDATOR",
    "mcda_rejected":      "⚠ MCDA FILTER",
    "water_rejected":     "⚠ WATER FILTER",
    "restricted_rejected":"⚠ RESTRICTED ZONE",
    "size_cap_rejected":  "⚠ SIZE CAP (>100ha)",
}

def make_grid(all_info: list):
    if not HAS_VIZ:
        log("Skipping grid.png (matplotlib not installed)")
        return

    n    = len(all_info)
    cols = min(5, n)
    rows = math.ceil(n / cols)
    fig, axes = plt.subplots(rows, cols,
                              figsize=(cols*4.2, rows*5.2),
                              facecolor="#111", squeeze=False)
    ax_flat = [axes[r][c] for r in range(rows) for c in range(cols)]

    fig.suptitle(
        f"Urban Forest AI — Patch Debug\n{DISTRICT_NAME}, {CITY_NAME}\n"
        f"All stages: {len(all_info)} patches",
        fontsize=12, fontweight="bold", color="white", y=1.01)

    for i, info in enumerate(all_info):
        ax    = ax_flat[i]
        p     = info["patch"]
        stage = info["stage"]
        tile  = info.get("tile_path")

        if tile and Path(tile).exists():
            try:
                img = Image.open(tile)
                ax.imshow(np.array(img))
            except Exception:
                ax.set_facecolor("#222")
        else:
            ax.set_facecolor("#222")

        for sp in ax.spines.values():
            sp.set_edgecolor(STAGE_COLOR.get(stage, "#888"))
            sp.set_linewidth(5)

        ax.set_xticks([]); ax.set_yticks([])

        name  = (p.get("placeName") or p.get("siteType","?"))[:22]
        title = f"#{i+1} {p['id']}  {p['areaHa']:.1f}ha\n{name}"
        ax.set_title(title, fontsize=7, color="white", pad=2,
                     fontdict={"family":"monospace"})

        b = p.get("bands", {})
        lines = [
            STAGE_LABEL.get(stage, stage.upper()),
            f"bare  {b.get('bare',0):.2f}   built {b.get('built',0):.2f}",
            f"water {b.get('water',0):.2f}   trees {b.get('trees',0):.2f}",
            f"grass {b.get('grass',0):.2f}   shrub {b.get('shrub_and_scrub',0):.2f}",
        ]
        if p.get("mcdaScore") is not None:
            lines.append(f"MCDA {p['mcdaScore']}   canopy {p.get('canopyPct','?')}%")

        drop = info.get("drop_reason") or p.get("drop_reason")
        if drop:
            lines += textwrap.wrap(f"DROP: {drop}"[:90], 28)

        verdict = info.get("verdict","")
        if verdict:
            lines.append(f"Agent1: {verdict}")
        reason = info.get("reasoning","")
        if reason:
            lines += textwrap.wrap(reason[:90], 28)

        ax.text(0.02, 0.98, "\n".join(lines),
                transform=ax.transAxes,
                fontsize=5.5, color="white", va="top", ha="left",
                fontfamily="monospace",
                bbox=dict(boxstyle="round,pad=0.25", fc="black", alpha=0.78))

    for i in range(len(all_info), len(ax_flat)):
        ax_flat[i].set_visible(False)

    legend = [mpatches.Patch(color=v, label=k.replace("_", " "))
              for k, v in STAGE_COLOR.items()]
    fig.legend(handles=legend, loc="lower center", ncol=4,
               fontsize=8, labelcolor="white", facecolor="#222",
               bbox_to_anchor=(0.5, -0.03))

    out = OUT_DIR / "grid.png"
    plt.tight_layout()
    plt.savefig(out, dpi=120, bbox_inches="tight", facecolor="#111")
    plt.close()
    log(f"Grid saved → {out}")

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    log("="*70)
    log(f"Urban Forest AI — Debug pipeline for {DISTRICT_NAME}, {CITY_NAME}")
    log(f"BBOX   : {BBOX}")
    log(f"Config : bareThreshold={CONFIG['bareThreshold']}  "
        f"minPatchHa={CONFIG['minPatchHa']}  "
        f"targetCanopyPct={CONFIG['targetCanopyPct']}  "
        f"geeScale={CONFIG['geeScale']}")
    log("="*70)

    token = get_gee_token()

    # ── Pipeline stages ────────────────────────────────────────────────────────
    hotspots, reserve = phase1_hotspots(BBOX, token, CONFIG)
    patches  = phase2_patches([h["bbox"] for h in hotspots], token, CONFIG)

    # 100ha size cap (mirrors app) — applied before reserve check
    log("═"*60)
    size_cap_rejected = [p for p in patches if p["areaHa"] > 100]
    patches = [p for p in patches if p["areaHa"] <= 100]
    if size_cap_rejected:
        log(f"SIZE CAP (>100ha): dropped {len(size_cap_rejected)} — "
            f"{len(patches)} remain")
        for p in size_cap_rejected:
            log(f"  DROP {p['id']:12s}  area={p['areaHa']:.1f}ha")

    validated = phase3_validate(patches, token, CONFIG)

    # Restricted zone filter (mirrors fetchRestrictedPolygons + filter in app)
    log("═"*60)
    log("FILTER R — Restricted zone filter (Overpass)")
    restricted_polygons = fetch_restricted_polygons(BBOX)
    restricted_rejected = []
    if restricted_polygons:
        before = len(validated)
        kept, restricted_rejected = [], []
        for p in validated:
            lat, lon = p["centroid"]["lat"], p["centroid"]["lon"]
            in_restricted = any(point_in_polygon(lat, lon, ring)
                                for ring in restricted_polygons)
            if in_restricted:
                p["drop_reason"] = "centroid inside restricted zone (Overpass)"
                restricted_rejected.append(p)
                log(f"  DROP {p['id']:12s} — inside restricted zone  "
                    f"lat={lat:.5f} lon={lon:.5f}")
            else:
                kept.append(p)
        validated = kept
        log(f"Restricted filter: {before} → {len(validated)} "
            f"({len(restricted_rejected)} dropped)")
    else:
        log("No restricted polygons fetched — skipping filter")

    # Reserve fallback — if top-8 cells yielded < 5 patches, search the reserve cells
    if len(validated) < 5 and reserve:
        log("═"*60)
        log(f"RESERVE FALLBACK — only {len(validated)} patches from top-8; "
            f"searching {len(reserve)} reserve cells")
        reserve_raw = phase2_patches([h["bbox"] for h in reserve], token, CONFIG)
        reserve_raw = [p for p in reserve_raw if p["areaHa"] <= 100]
        existing_ids = {p["id"] for p in validated}
        reserve_validated = phase3_validate(
            [p for p in reserve_raw if p["id"] not in existing_ids], token, CONFIG
        )
        if restricted_polygons:
            reserve_validated = [
                p for p in reserve_validated
                if not any(point_in_polygon(p["centroid"]["lat"], p["centroid"]["lon"], poly)
                           for poly in restricted_polygons)
            ]
        validated = validated + reserve_validated
        log(f"Reserve expansion: +{len(reserve_validated)} patches → total {len(validated)}")

    # Water filter
    log("═"*60)
    log("FILTER A — Drop patches with water > 0.20 (waterfront / dock)")
    water_kept     = [p for p in validated if p["bands"]["water"] <= 0.20]
    water_rejected = [p for p in validated if p["bands"]["water"] >  0.20]
    for p in water_rejected:
        p["drop_reason"] = f"water={p['bands']['water']:.2f}>0.20"
        log(f"  DROP water={p['bands']['water']:.2f}  {p['id']}  "
            f"{p.get('placeName','')}")
    log(f"Water filter: {len(validated)} → {len(water_kept)} kept, "
        f"{len(water_rejected)} dropped")

    # MCDA pre-filter
    candidates, mcda_rejected = mcda_and_prefilter(water_kept, CONFIG)

    # ── Fetch tiles for ALL patches ─────────────────────────────────────────────
    log("═"*60)
    log("SATELLITE TILES — fetching for ALL patches at all stages")

    all_info: list[dict] = []
    tile_bytes_map: dict[str, bytes] = {}

    def _fetch_and_record(patches_list, stage):
        for p in patches_list:
            tp = save_tile(p, stage)
            info = {
                "patch": p, "stage": stage,
                "tile_path": str(tp) if tp else None,
                "drop_reason": p.get("drop_reason", ""),
            }
            if tp:
                tile_bytes_map[p["id"]] = tp.read_bytes()
            all_info.append(info)
            time.sleep(0.08)

    _fetch_and_record(size_cap_rejected,  "size_cap_rejected")
    _fetch_and_record(restricted_rejected, "restricted_rejected")
    _fetch_and_record(water_rejected,      "water_rejected")
    _fetch_and_record(mcda_rejected,       "mcda_rejected")

    # Candidates need their tile_bytes for Agent 1
    for p in candidates:
        tp = save_tile(p, "agent1_rejected")  # placeholder dir; will rename after Agent 1
        if tp:
            tile_bytes_map[p["id"]] = tp.read_bytes()
        time.sleep(0.08)

    log(f"Tiles fetched: {len(tile_bytes_map)} total")

    # ── Agent 1 (parallel per-site) ─────────────────────────────────────────────
    verdict_map = run_agent1_parallel(candidates, tile_bytes_map) if candidates else {}

    # Save aggregated Agent 1 verdicts
    all_verdicts = list(verdict_map.values())
    (OUT_DIR / "agent1_verdicts.json").write_text(json.dumps(all_verdicts, indent=2))
    log(f"Agent 1 verdicts saved → {OUT_DIR}/agent1_verdicts.json  "
        f"({len(all_verdicts)} entries)")

    # ── Spatial Validator ────────────────────────────────────────────────────────
    validation_map = spatial_validator(candidates, verdict_map)

    # ── Classify candidates → agent1_rejected / validator_rejected / approved ───
    approved: list[dict] = []
    for p in candidates:
        v  = verdict_map.get(p["id"], {})
        vd = validation_map.get(p["id"], {"passed": True})
        vr = v.get("verdict", "approve")

        if not vd["passed"]:
            if vr == "reject":
                stage      = "agent1_rejected"
                drop_reason = f"Agent 1 reject: {v.get('reasoning','')}"
            else:
                stage      = "validator_rejected"
                drop_reason = vd.get("reason", "validator failed")
        else:
            stage      = "pending_agent2"
            drop_reason = ""
            approved.append(p)

        # Move tile to correct stage dir
        src = TILE_DIR / "agent1_rejected" / f"{p['id']}.jpg"
        dst = TILE_DIR / stage / f"{p['id']}.jpg"
        if src.exists() and stage != "agent1_rejected":
            dst.parent.mkdir(exist_ok=True)
            src.rename(dst)

        if stage != "pending_agent2":
            all_info.append({
                "patch": p, "stage": stage, "tile_path": str(dst) if dst.exists() else None,
                "drop_reason": drop_reason,
                "verdict": vr, "reasoning": v.get("reasoning", ""),
            })
            log(f"  {p['id']:12s} MCDA={p['mcdaScore']:3d}  "
                f"verdict={vr:6s}  passed={vd['passed']}  {v.get('reasoning','')[:60]}")

    log(f"After Agent 1 + Validator: {len(approved)} approved for Agent 2")

    if not approved:
        log("No sites passed Agent 1 + Validator — pipeline stops here.", "WARN")
        _finish(all_info, candidates, verdict_map, validation_map, {},
                size_cap_rejected, restricted_rejected, water_rejected, mcda_rejected, [])
        return

    # ── Agent 2 (parallel per-site) ─────────────────────────────────────────────
    plan_map = run_agent2_parallel(approved, verdict_map, tile_bytes_map)
    (OUT_DIR / "agent2_plans.json").write_text(
        json.dumps(list(plan_map.values()), indent=2))
    log(f"Agent 2 plans saved → {OUT_DIR}/agent2_plans.json")

    # Classify Agent 2 results and move tiles
    selected: list[dict] = []
    for p in approved:
        plan  = plan_map.get(p["id"])
        plantable = plan.get("plantable", True) if plan else True
        src = TILE_DIR / "agent1_rejected" / f"{p['id']}.jpg"

        if plantable:
            stage = "selected"
            selected.append({**p, "plan": plan})
        else:
            stage = "agent2_rejected"

        dst = TILE_DIR / stage / f"{p['id']}.jpg"
        if src.exists():
            src.rename(dst)
        elif (TILE_DIR / "pending_agent2" / f"{p['id']}.jpg").exists():
            (TILE_DIR / "pending_agent2" / f"{p['id']}.jpg").rename(dst)

        all_info.append({
            "patch":      p,
            "stage":      stage,
            "tile_path":  str(dst) if dst.exists() else None,
            "drop_reason":"" if plantable else f"Agent 2: not plantable",
            "verdict":    verdict_map.get(p["id"], {}).get("verdict", ""),
            "reasoning":  plan.get("reasoning","") if plan else "",
            "plan":       plan,
        })

    _finish(all_info, candidates, verdict_map, validation_map, plan_map,
            size_cap_rejected, restricted_rejected, water_rejected, mcda_rejected, selected)

def _finish(all_info, candidates, verdict_map, validation_map, plan_map,
            size_cap_rejected, restricted_rejected, water_rejected, mcda_rejected, selected):
    log("═"*60)
    log("PIPELINE SUMMARY")
    log(f"  After size cap filter     : {sum(1 for i in all_info if i['stage']!='size_cap_rejected')+len(size_cap_rejected)}  "
        f"(dropped {len(size_cap_rejected)} >100ha)")
    log(f"  After restricted filter   : dropped {len(restricted_rejected)}")
    log(f"  After water filter        : dropped {len(water_rejected)}")
    log(f"  After MCDA pre-filter     : {len(candidates)} candidates  "
        f"(dropped {len(mcda_rejected)})")
    agent1_rejected = sum(1 for i in all_info if i["stage"] in ("agent1_rejected","validator_rejected"))
    log(f"  After Agent 1 + Validator : dropped {agent1_rejected}")
    log(f"  Final selected zones      : {len(selected)}")

    results_json = {
        "district": DISTRICT_NAME,
        "city":     CITY_NAME,
        "bbox":     BBOX,
        "config":   CONFIG,
        "summary":  {
            "size_cap_rejected":   len(size_cap_rejected),
            "restricted_rejected": len(restricted_rejected),
            "water_rejected":      len(water_rejected),
            "mcda_rejected":       len(mcda_rejected),
            "agent1_rejected":     sum(1 for i in all_info if i["stage"]=="agent1_rejected"),
            "validator_rejected":  sum(1 for i in all_info if i["stage"]=="validator_rejected"),
            "agent2_rejected":     sum(1 for i in all_info if i["stage"]=="agent2_rejected"),
            "final_selected":      len(selected),
        },
        "patches_by_stage": {
            "size_cap_rejected": [
                {"id": p["id"], "areaHa": p["areaHa"], "centroid": p["centroid"],
                 "drop_reason": ">100ha"}
                for p in size_cap_rejected
            ],
            "restricted_rejected": [
                {"id": p["id"], "areaHa": p["areaHa"], "centroid": p["centroid"],
                 "siteType": p.get("siteType"), "drop_reason": p.get("drop_reason")}
                for p in restricted_rejected
            ],
            "water_rejected": [
                {"id": p["id"], "areaHa": p["areaHa"], "bands": p["bands"],
                 "siteType": p["siteType"], "placeName": p.get("placeName"),
                 "centroid": p["centroid"], "drop_reason": p.get("drop_reason")}
                for p in water_rejected
            ],
            "mcda_rejected": [
                {"id": p["id"], "areaHa": p["areaHa"], "mcdaScore": p["mcdaScore"],
                 "bands": p["bands"], "siteType": p["siteType"],
                 "placeName": p.get("placeName"), "centroid": p["centroid"],
                 "drop_reason": p.get("drop_reason")}
                for p in mcda_rejected
            ],
            "candidates": [
                {"id": p["id"], "areaHa": p["areaHa"], "mcdaScore": p["mcdaScore"],
                 "bands": p["bands"], "siteType": p["siteType"],
                 "placeName": p.get("placeName"), "centroid": p["centroid"],
                 "agent1": verdict_map.get(p["id"]),
                 "validator": validation_map.get(p["id"]),
                 "agent2": plan_map.get(p["id"]),
                 "final_stage": next(
                     (i["stage"] for i in all_info if i["patch"]["id"] == p["id"]),
                     "unknown"
                 )}
                for p in candidates
            ],
            "selected": [
                {"id": p["id"], "areaHa": p["areaHa"], "mcdaScore": p["mcdaScore"],
                 "bands": p["bands"], "siteType": p["siteType"],
                 "placeName": p.get("placeName"), "centroid": p["centroid"],
                 "plan": plan_map.get(p["id"])}
                for p in selected
            ],
        },
    }
    results_path = OUT_DIR / "results.json"
    results_path.write_text(json.dumps(results_json, indent=2))
    log(f"Results JSON → {results_path}")

    make_grid(all_info)
    save_log()

    log("="*70)
    log(f"Output written to {OUT_DIR}/")
    log(f"  tiles/<stage>/      — satellite tiles for ALL patches by pipeline stage")
    log(f"  agent1_raw/         — raw Gemma Agent 1 replies per site")
    log(f"  agent2_raw/         — raw Gemma Agent 2 replies per site")
    log(f"  agent1_verdicts.json")
    log(f"  agent2_plans.json")
    log(f"  results.json        — all patches with failure reasons")
    log(f"  grid.png            — visual comparison, colour-coded by stage")
    log(f"  pipeline.log        — full trace")

if __name__ == "__main__":
    main()
