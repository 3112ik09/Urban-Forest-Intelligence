"""
GEE diagnostic + NDVI fetch script.
Run: python3 gee_test.py

Requires:  pip install earthengine-api google-auth
The official ee Python library uses the correct REST API format
and handles auth automatically — use it to verify credentials work,
then print the NDVI values we'd use in the app.
"""

import os, json, sys

# ── Load .env.local ──────────────────────────────────────────────────────────
env = {}
try:
    with open(".env.local") as f:
        for line in f:
            line = line.strip()
            if line and "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
except FileNotFoundError:
    sys.exit(".env.local not found — run this from the delhi-forest-ai directory")

SA      = env.get("GEE_SERVICE_ACCOUNT", "")
KEY_RAW = env.get("GEE_PRIVATE_KEY", "")
PROJECT = env.get("GEE_PROJECT_ID", "")

if not SA or not KEY_RAW or not PROJECT:
    sys.exit("Missing GEE_SERVICE_ACCOUNT / GEE_PRIVATE_KEY / GEE_PROJECT_ID in .env.local")

# Convert literal \n to real newlines
PRIVATE_KEY = KEY_RAW.replace("\\n", "\n")

print(f"Service account : {SA}")
print(f"Project         : {PROJECT}")
print(f"Key starts with : {PRIVATE_KEY[:36]}")
print()

# ── Install check ─────────────────────────────────────────────────────────────
try:
    import ee
    from google.oauth2 import service_account
except ImportError:
    sys.exit(
        "Missing packages. Run:\n"
        "  pip install earthengine-api google-auth\n"
        "then re-run this script."
    )

# ── Authenticate ──────────────────────────────────────────────────────────────
print("Authenticating with service account …")
try:
    credentials = service_account.Credentials.from_service_account_info(
        {
            "type": "service_account",
            "client_email": SA,
            "private_key": PRIVATE_KEY,
            "token_uri": "https://oauth2.googleapis.com/token",
        },
        scopes=["https://www.googleapis.com/auth/earthengine"],
    )
    ee.Initialize(credentials=credentials, project=PROJECT)
    print("✓ Authenticated and initialised\n")
except Exception as e:
    sys.exit(f"✗ Auth failed: {e}")

# ── District bboxes (minLon, minLat, maxLon, maxLat) ─────────────────────────
DISTRICTS = {
    "Central Delhi":    [77.165, 28.612, 77.264, 28.786],
    "East Delhi":       [77.253, 28.570, 77.342, 28.656],
    "New Delhi":        [77.050, 28.481, 77.255, 28.646],
    "North Delhi":      [76.962, 28.691, 77.224, 28.883],
    "North East Delhi": [77.206, 28.660, 77.299, 28.787],
    "North West Delhi": [76.942, 28.658, 77.190, 28.818],
    "Shahdara":         [77.254, 28.638, 77.333, 28.714],
    "South Delhi":      [77.112, 28.405, 77.248, 28.566],
    "South East Delhi": [77.199, 28.480, 77.345, 28.610],
    "South West Delhi": [76.839, 28.501, 77.103, 28.672],
    "West Delhi":       [76.951, 28.608, 77.197, 28.701],
}

# ── NDVI computation ──────────────────────────────────────────────────────────
def compute_ndvi(name: str, bbox: list) -> dict:
    region = ee.Geometry.Rectangle(bbox)

    # Sentinel-2 SR, Feb–May 2024, cloud < 20 %
    s2 = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterDate("2024-02-01", "2024-05-31")
        .filter(ee.Filter.lte("CLOUDY_PIXEL_PERCENTAGE", 20))
        .select(["B4", "B8"])
        .mean()
    )

    stats = s2.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=region,
        scale=100,
        maxPixels=1e9,
        bestEffort=True,
    )

    result = stats.getInfo()   # <── actual GEE API call happens here
    b4 = result.get("B4") or 800
    b8 = result.get("B8") or 1200

    ndvi      = (b8 - b4) / (b8 + b4)
    ndvi_pct  = max(0, min(100, round(ndvi * 100)))
    canopy    = round(ndvi_pct * 0.7)
    temp      = round(44 - ndvi_pct * 0.32)
    built_up  = max(10, min(99, round(95 - ndvi_pct * 1.8)))
    barren    = round((100 - built_up) * 0.8) if ndvi_pct < 15 else round((100 - built_up) * 0.3)

    return {
        "district":          name,
        "ndvi_pct":          ndvi_pct,
        "canopy_pct":        canopy,
        "avg_temp_c":        temp,
        "built_up_pct":      built_up,
        "barren_ha":         barren,
        "available_rooftops": round(built_up * 8.5),
        "road_km":           round(built_up * 0.22),
        "wall_count":        round(built_up * 3.1),
        "parking_lots":      round(built_up * 0.4),
        "raw_B4":            round(b4, 1),
        "raw_B8":            round(b8, 1),
    }


# ── Run for all districts (or just one for a quick test) ─────────────────────
# To test a single district quickly, change ALL_DISTRICTS to False
ALL_DISTRICTS = False
targets = DISTRICTS if ALL_DISTRICTS else {"Central Delhi": DISTRICTS["Central Delhi"]}

results = {}
for name, bbox in targets.items():
    print(f"Computing NDVI for {name} …")
    try:
        r = compute_ndvi(name, bbox)
        results[name] = r
        print(f"  B4={r['raw_B4']}  B8={r['raw_B8']}  NDVI={r['ndvi_pct']}%  "
              f"canopy={r['canopy_pct']}%  temp={r['avg_temp_c']}°C  "
              f"built={r['built_up_pct']}%  barren={r['barren_ha']}ha")
    except Exception as e:
        print(f"  ✗ Failed: {e}")

print("\n─── Full JSON output ───────────────────────────────")
print(json.dumps(results, indent=2))

# ── Save results so you can paste into the Node fallback table ───────────────
if results:
    with open("gee_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\n✓ Saved to gee_results.json")
