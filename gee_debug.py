"""
GEE REST API function-name debugger.

Tests every operation used in earthengine.ts by:
  1. Getting a bearer token directly (no ee library)
  2. POSTing raw expression JSON to value:compute
  3. Reporting pass / fail with exact error messages

Also prints the ee-Python-library's serialized form for each operation
so you can copy the correct function names into the TypeScript code.

Run:
  python3 gee_debug.py
"""

import os, sys, json, time
from datetime import datetime, timedelta

# ── Load .env.local ──────────────────────────────────────────────────────────
env = {}
try:
    with open(".env.local") as f:
        for line in f:
            line = line.strip()
            if line and "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().strip('"')
except FileNotFoundError:
    sys.exit(".env.local not found — run from delhi-forest-ai directory")

SA      = env.get("GEE_SERVICE_ACCOUNT", "")
KEY_RAW = env.get("GEE_PRIVATE_KEY", "")
PROJECT = env.get("GEE_PROJECT_ID", "")
if not SA or not KEY_RAW or not PROJECT:
    sys.exit("Missing GEE_SERVICE_ACCOUNT / GEE_PRIVATE_KEY / GEE_PROJECT_ID")
PRIVATE_KEY = KEY_RAW.replace("\\n", "\n")

print(f"Service account : {SA}")
print(f"Project         : {PROJECT}\n")

# ── Install check ─────────────────────────────────────────────────────────────
try:
    import jwt as pyjwt          # pip install pyjwt cryptography
    import requests              # pip install requests
except ImportError:
    sys.exit("Run: pip install pyjwt cryptography requests")

try:
    import ee
    from google.oauth2 import service_account as sa_module
    HAS_EE = True
except ImportError:
    HAS_EE = False
    print("NOTE: earthengine-api not installed — skipping Python ee serialization checks")
    print("      Run: pip install earthengine-api google-auth\n")

# ── Get bearer token (pure JWT, no ee library) ────────────────────────────────
def get_token() -> str:
    now = int(time.time())
    claim = {
        "iss": SA,
        "scope": "https://www.googleapis.com/auth/earthengine",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }
    signed = pyjwt.encode(claim, PRIVATE_KEY, algorithm="RS256")
    r = requests.post(
        "https://oauth2.googleapis.com/token",
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": signed},
        timeout=15,
    )
    data = r.json()
    if "access_token" not in data:
        sys.exit(f"Token error: {data}")
    return data["access_token"]

print("Getting GEE token …")
TOKEN = get_token()
print("✓ Token obtained\n")

URL   = f"https://earthengine.googleapis.com/v1/projects/{PROJECT}/value:compute"
BBOX  = [77.165, 28.612, 77.264, 28.786]  # Central Delhi
[minLon, minLat, maxLon, maxLat] = BBOX

end_d   = datetime.utcnow()
start_d = end_d - timedelta(days=365)
END_S   = end_d.strftime("%Y-%m-%d")
START_S = start_d.strftime("%Y-%m-%d")

GEOM_NODE = {
    "functionInvocationValue": {
        "functionName": "GeometryConstructors.Polygon",
        "arguments": {
            "coordinates": {"constantValue": [[[minLon, minLat], [maxLon, minLat],
                                               [maxLon, maxLat], [minLon, maxLat],
                                               [minLon, minLat]]]},
            "evenOdd": {"constantValue": True},
        },
    }
}

# ── REST call helper ──────────────────────────────────────────────────────────
def compute(label, expression, expect_key=None):
    body = {"expression": expression}
    r = requests.post(URL,
                      headers={"Authorization": f"Bearer {TOKEN}",
                                "Content-Type": "application/json"},
                      json=body, timeout=60)
    if r.ok:
        result = r.json().get("result", {})
        # Accept: numeric result OR FeatureCollection with features
        has_value = (
            (expect_key and isinstance(result, dict) and expect_key in result) or
            (expect_key is None and result not in (None, {})) or
            (isinstance(result, dict) and "features" in result)
        )
        status = "✓ PASS" if has_value else "? PASS (empty result)"
        print(f"  {status}  {label}")
        if not has_value:
            print(f"         result = {json.dumps(result)[:200]}")
        return True, result
    else:
        err = r.json().get("error", {})
        print(f"  ✗ FAIL  {label}")
        print(f"         {err.get('message', r.text[:200])}")
        return False, None

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — Candidate DW ImageCollection builders
# Test which function name correctly builds a mean DW image from a date range
# ═══════════════════════════════════════════════════════════════════════════════
print("=" * 70)
print("SECTION 1 — DW ImageCollection → mean Image builders")
print("=" * 70)

def dw_mean_via_collection_filter() -> dict:
    """Collection.filter + Filter.dateRangeContains + reduce.mean  (current code)"""
    return {
        "functionName": "reduce.mean",
        "arguments": {
            "collection": {
                "functionInvocationValue": {
                    "functionName": "Collection.filter",
                    "arguments": {
                        "collection": {
                            "functionInvocationValue": {
                                "functionName": "ImageCollection.load",
                                "arguments": {"id": {"constantValue": "GOOGLE/DYNAMICWORLD/V1"}},
                            }
                        },
                        "filter": {
                            "functionInvocationValue": {
                                "functionName": "Filter.dateRangeContains",
                                "arguments": {
                                    "leftValue": {
                                        "functionInvocationValue": {
                                            "functionName": "DateRange",
                                            "arguments": {
                                                "start": {"constantValue": START_S},
                                                "end":   {"constantValue": END_S},
                                            },
                                        }
                                    },
                                    "rightField": {"constantValue": "system:time_start"},
                                },
                            }
                        },
                    },
                }
            }
        },
    }

def make_reduce_region_expr(dw_builder_fn) -> dict:
    dw_node = dw_builder_fn()
    return {
        "result": "0",
        "values": {
            "0": {
                "functionInvocationValue": {
                    "functionName": "Image.reduceRegion",
                    "arguments": {
                        "image": {
                            "functionInvocationValue": {
                                "functionName": "Image.select",
                                "arguments": {
                                    "input": {"functionInvocationValue": dw_node},
                                    "bandSelectors": {"constantValue": ["trees", "bare", "built"]},
                                },
                            }
                        },
                        "reducer": {"functionInvocationValue": {"functionName": "Reducer.mean", "arguments": {}}},
                        "geometry": GEOM_NODE,
                        "scale": {"constantValue": 100},
                        "maxPixels": {"constantValue": 1e8},
                        "bestEffort": {"constantValue": True},
                    },
                }
            }
        },
    }

compute("Collection.filter + Filter.dateRangeContains + reduce.mean",
        make_reduce_region_expr(dw_mean_via_collection_filter), "trees")

# ── Also test ImageCollection.filterDate (known-broken, just to confirm) ──────
def dw_mean_via_filterDate() -> dict:
    """ImageCollection.filterDate (KNOWN BROKEN — testing to confirm error msg)"""
    return {
        "functionName": "reduce.mean",
        "arguments": {
            "collection": {
                "functionInvocationValue": {
                    "functionName": "ImageCollection.filterDate",
                    "arguments": {
                        "collection": {
                            "functionInvocationValue": {
                                "functionName": "ImageCollection.load",
                                "arguments": {"id": {"constantValue": "GOOGLE/DYNAMICWORLD/V1"}},
                            }
                        },
                        "start": {"constantValue": START_S},
                        "end":   {"constantValue": END_S},
                    },
                }
            }
        },
    }

compute("ImageCollection.filterDate (expect FAIL)",
        make_reduce_region_expr(dw_mean_via_filterDate))

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — Image.gt / Image.selfMask
# ═══════════════════════════════════════════════════════════════════════════════
print()
print("=" * 70)
print("SECTION 2 — Image.gt + Image.selfMask (used in reduceToVectors)")
print("=" * 70)

dw_node = dw_mean_via_collection_filter()

bare_band = {
    "functionInvocationValue": {
        "functionName": "Image.select",
        "arguments": {
            "input": {"functionInvocationValue": dw_node},
            "bandSelectors": {"constantValue": ["bare"]},
        },
    }
}

bare_gt = {
    "functionInvocationValue": {
        "functionName": "Image.gt",
        "arguments": {
            "input": bare_band,
            "value": {"constantValue": 0.18},
        },
    }
}

self_masked = {
    "functionInvocationValue": {
        "functionName": "Image.selfMask",
        "arguments": {"input": bare_gt},
    }
}

# Test selfMask result via reduceRegion (should give ~1 for bare pixels)
compute("Image.gt + Image.selfMask via reduceRegion",
        {
            "result": "0",
            "values": {
                "0": {
                    "functionInvocationValue": {
                        "functionName": "Image.reduceRegion",
                        "arguments": {
                            "image": self_masked,
                            "reducer": {"functionInvocationValue": {"functionName": "Reducer.mean", "arguments": {}}},
                            "geometry": GEOM_NODE,
                            "scale": {"constantValue": 100},
                            "maxPixels": {"constantValue": 1e8},
                            "bestEffort": {"constantValue": True},
                        },
                    }
                }
            },
        }, "bare")

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — Image.reduceToVectors (the core of fetchOpenGroundPatches)
# ═══════════════════════════════════════════════════════════════════════════════
print()
print("=" * 70)
print("SECTION 3 — Image.reduceToVectors with correct geometry node")
print("=" * 70)

rtv_expr = {
    "result": "0",
    "values": {
        "0": {
            "functionInvocationValue": {
                "functionName": "Image.reduceToVectors",
                "arguments": {
                    "image": self_masked,
                    "scale": {"constantValue": 40},
                    "geometry": GEOM_NODE,
                    "maxPixels": {"constantValue": 5e6},
                    "bestEffort": {"constantValue": True},
                    "geometryType": {"constantValue": "polygon"},
                    "eightConnected": {"constantValue": False},
                    "labelProperty": {"constantValue": None},
                },
            }
        }
    },
}

ok, result = compute("Image.reduceToVectors (bare > 0.18, Central Delhi bbox)", rtv_expr)
if ok and isinstance(result, dict) and "features" in result:
    features = result["features"]
    print(f"         → {len(features)} raw polygon features returned")
    areas = []
    for f in features[:5]:
        coords = f.get("geometry", {}).get("coordinates", [[]])
        ring = coords[0] if coords else []
        if len(ring) >= 3:
            import math
            area = 0
            for i in range(len(ring) - 1):
                area += ring[i][0] * ring[i+1][1] - ring[i+1][0] * ring[i][1]
            deg2 = abs(area) / 2
            avg_lat = sum(p[1] for p in ring) / len(ring)
            ha = deg2 * 110570 * 111320 * math.cos(math.radians(avg_lat)) / 10000
            areas.append(ha)
    if areas:
        print(f"         → first {len(areas)} patch areas (ha): {[round(a,2) for a in areas]}")

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — Per-polygon reduceRegion (used in validatePatches)
# ═══════════════════════════════════════════════════════════════════════════════
print()
print("=" * 70)
print("SECTION 4 — Per-polygon Image.reduceRegion (validatePatches)")
print("=" * 70)

# Use a small polygon inside Central Delhi for speed
small_geom = {
    "functionInvocationValue": {
        "functionName": "GeometryConstructors.Polygon",
        "arguments": {
            "coordinates": {"constantValue": [[[77.20, 28.62], [77.22, 28.62],
                                               [77.22, 28.64], [77.20, 28.64],
                                               [77.20, 28.62]]]},
            "evenOdd": {"constantValue": True},
        },
    }
}

rr_expr = {
    "result": "0",
    "values": {
        "0": {
            "functionInvocationValue": {
                "functionName": "Image.reduceRegion",
                "arguments": {
                    "image": {
                        "functionInvocationValue": {
                            "functionName": "Image.select",
                            "arguments": {
                                "input": {"functionInvocationValue": dw_mean_via_collection_filter()},
                                "bandSelectors": {"constantValue": [
                                    "trees", "grass", "bare", "built", "water", "shrub_and_scrub"
                                ]},
                            },
                        }
                    },
                    "reducer": {"functionInvocationValue": {"functionName": "Reducer.mean", "arguments": {}}},
                    "geometry": small_geom,
                    "scale": {"constantValue": 20},
                    "maxPixels": {"constantValue": 1e8},
                    "bestEffort": {"constantValue": True},
                },
            }
        }
    },
}

ok2, res2 = compute("Image.reduceRegion all-bands small polygon (20m scale)", rr_expr, "bare")
if ok2 and res2:
    print(f"         → bands: { {k: round(v,3) for k,v in res2.items()} }")

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — ee Python serializer (if available)
# Shows the exact JSON the Python library sends for common operations
# ═══════════════════════════════════════════════════════════════════════════════
if HAS_EE:
    print()
    print("=" * 70)
    print("SECTION 5 — Python ee library: full reduceToVectors serialization")
    print("=" * 70)
    try:
        creds = sa_module.Credentials.from_service_account_info(
            {"type": "service_account", "client_email": SA, "private_key": PRIVATE_KEY,
             "token_uri": "https://oauth2.googleapis.com/token"},
            scopes=["https://www.googleapis.com/auth/earthengine"],
        )
        ee.Initialize(credentials=creds, project=PROJECT)

        start_ee = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
        end_ee   = datetime.utcnow().strftime("%Y-%m-%d")
        region   = ee.Geometry.Rectangle(BBOX)

        bare_img = (ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
                      .filterDate(start_ee, end_ee)
                      .select("bare")
                      .mean()
                      .gt(0.18)
                      .selfMask())

        rtv_py = bare_img.reduceToVectors(
            scale=40, geometry=region, maxPixels=5e6,
            bestEffort=True, geometryType="polygon",
            eightConnected=False, labelProperty=None,
        )
        rtv_s = ee.serializer.encode(rtv_py, for_cloud_api=True)
        print("\nFULL reduceToVectors expression (no truncation):")
        print(json.dumps(rtv_s, indent=2))

    except Exception as e:
        print(f"  ee Python serialization failed: {e}")

print()
print("=" * 70)
print("SECTION 6 — Testing fixed Image.gt (image1/image2) + Image.selfMask (image)")
print("=" * 70)

# Test: Image.gt with image1/image2 argument names + Image.selfMask with image
dw_node2 = dw_mean_via_collection_filter()

bare_band2 = {
    "functionInvocationValue": {
        "functionName": "Image.select",
        "arguments": {
            "input": {"functionInvocationValue": dw_node2},
            "bandSelectors": {"constantValue": ["bare"]},
        },
    }
}

# image1 / image2 variant (what Python library uses)
bare_gt_fixed = {
    "functionInvocationValue": {
        "functionName": "Image.gt",
        "arguments": {
            "image1": bare_band2,
            "image2": {"constantValue": 0.18},
        },
    }
}

self_masked_fixed = {
    "functionInvocationValue": {
        "functionName": "Image.selfMask",
        "arguments": {"image": bare_gt_fixed},   # "image" not "input"
    }
}

ok3, _ = compute(
    "Image.gt(image1/image2) + Image.selfMask(image) via reduceRegion",
    {
        "result": "0",
        "values": {
            "0": {
                "functionInvocationValue": {
                    "functionName": "Image.reduceRegion",
                    "arguments": {
                        "image": self_masked_fixed,
                        "reducer": {"functionInvocationValue": {"functionName": "Reducer.mean", "arguments": {}}},
                        "geometry": GEOM_NODE,
                        "scale": {"constantValue": 100},
                        "maxPixels": {"constantValue": 1e8},
                        "bestEffort": {"constantValue": True},
                    },
                }
            }
        },
    }, "bare")

# If image2 as constantValue works, also test reduceToVectors
if ok3:
    ok4, res4 = compute(
        "FIXED Image.reduceToVectors (image1/image2/selfMask with 'image')",
        {
            "result": "0",
            "values": {
                "0": {
                    "functionInvocationValue": {
                        "functionName": "Image.reduceToVectors",
                        "arguments": {
                            "image": self_masked_fixed,
                            "scale": {"constantValue": 40},
                            "geometry": GEOM_NODE,
                            "maxPixels": {"constantValue": 5e6},
                            "bestEffort": {"constantValue": True},
                            "geometryType": {"constantValue": "polygon"},
                            "eightConnected": {"constantValue": False},
                            "labelProperty": {"constantValue": None},
                        },
                    }
                }
            },
        })
    if ok4 and isinstance(res4, dict) and "features" in res4:
        feats = res4["features"]
        print(f"         → {len(feats)} polygon features returned from fixed expression")

print()
print("=" * 70)
print("SECTION 7 — FULLY CORRECTED: image1 + Image.constant + selfMask(image)")
print("=" * 70)

dw_node3 = dw_mean_via_collection_filter()

def image_constant(value):
    return {
        "functionInvocationValue": {
            "functionName": "Image.constant",
            "arguments": {"value": {"constantValue": value}},
        }
    }

bare_band3 = {
    "functionInvocationValue": {
        "functionName": "Image.select",
        "arguments": {
            "input": {"functionInvocationValue": dw_node3},
            "bandSelectors": {"constantValue": ["bare"]},
        },
    }
}

bare_gt_correct = {
    "functionInvocationValue": {
        "functionName": "Image.gt",
        "arguments": {
            "image1": bare_band3,
            "image2": image_constant(0.18),
        },
    }
}

self_masked_correct = {
    "functionInvocationValue": {
        "functionName": "Image.selfMask",
        "arguments": {"image": bare_gt_correct},
    }
}

ok5, _ = compute(
    "CORRECT Image.gt(image1+Image.constant) + selfMask(image) → reduceRegion",
    {
        "result": "0",
        "values": {
            "0": {
                "functionInvocationValue": {
                    "functionName": "Image.reduceRegion",
                    "arguments": {
                        "image": self_masked_correct,
                        "reducer": {"functionInvocationValue": {"functionName": "Reducer.mean", "arguments": {}}},
                        "geometry": GEOM_NODE,
                        "scale": {"constantValue": 100},
                        "maxPixels": {"constantValue": 1e8},
                        "bestEffort": {"constantValue": True},
                    },
                }
            }
        },
    }, "bare")

if ok5:
    ok6, res6 = compute(
        "CORRECT Image.reduceToVectors (bare > 0.18)",
        {
            "result": "0",
            "values": {
                "0": {
                    "functionInvocationValue": {
                        "functionName": "Image.reduceToVectors",
                        "arguments": {
                            "image": self_masked_correct,
                            "scale": {"constantValue": 40},
                            "geometry": GEOM_NODE,
                            "maxPixels": {"constantValue": 5e6},
                            "bestEffort": {"constantValue": True},
                            "geometryType": {"constantValue": "polygon"},
                            "eightConnected": {"constantValue": False},
                            "labelProperty": {"constantValue": None},
                        },
                    }
                }
            },
        })
    if ok6 and isinstance(res6, dict) and "features" in res6:
        feats = res6["features"]
        print(f"         → {len(feats)} polygon features — PIPELINE WORKING!")

print()
print("=" * 70)
print("DONE")
print("=" * 70)
