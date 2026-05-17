"""
One-time script to fetch district GeoJSON for demo cities and save to public/districts/
Run once: python3 fetch_districts.py
"""
import json, time, urllib.request, os

UA = 'UrbanForestAI/1.0'
OUT = './public/districts'
os.makedirs(OUT, exist_ok=True)

def overpass(query):
    req = urllib.request.Request(
        'https://overpass-api.de/api/interpreter',
        data=f'data={urllib.parse.quote(query)}'.encode(),
        headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def stitch(members):
    ways = [
        [[p['lon'], p['lat']] for p in m['geometry']]
        for m in members
        if m['type'] == 'way' and m.get('role', '') in ('outer', '') and m.get('geometry')
    ]
    if not ways: return []
    result = list(ways[0])
    remaining = ways[1:]
    while remaining:
        tail = result[-1]
        matched = False
        for i, seg in enumerate(remaining):
            if abs(tail[0]-seg[0][0])<1e-6 and abs(tail[1]-seg[0][1])<1e-6:
                result += seg[1:]; remaining.pop(i); matched = True; break
            if abs(tail[0]-seg[-1][0])<1e-6 and abs(tail[1]-seg[-1][1])<1e-6:
                result += seg[::-1][1:]; remaining.pop(i); matched = True; break
        if not matched:
            for s in remaining: result += s
            break
    if result and (result[0] != result[-1]): result.append(result[0])
    return result

CITIES = [
    # (slug, osm_relation_id, admin_level, display_name)
    ('delhi',     1942586, 5,  'Delhi'),
    ('london',    175342,  8,  'London'),
    ('new_york',  175905,  6,  'New York'),
    ('tokyo',     1543125, 7,  'Tokyo'),
    ('paris',     7444,    9,  'Paris'),
    ('berlin',    62422,   8,  'Berlin'),
    ('mumbai',    1953718, 5,  'Mumbai'),
    ('bangalore', 7888990, 5,  'Bangalore'),
    ('nairobi',   192798,  8,  'Nairobi'),
    ('lagos',     3720712, 8,  'Lagos'),
    ('sydney',    13428083,9,  'Sydney'),
    ('singapore', 536780,  8,  'Singapore'),
]

import urllib.parse

for slug, rel_id, level, name in CITIES:
    print(f'Fetching {name} (relation {rel_id}, level {level})...')
    try:
        query = f"""[out:json][timeout:30];
relation({rel_id});
rel(r)["admin_level"="{level}"];
out geom;"""
        data = overpass(query)
        features = []
        for el in data.get('elements', []):
            if el['type'] != 'relation': continue
            n = el.get('tags', {}).get('name') or el.get('tags', {}).get('name:en', '')
            if not n: continue
            ring = stitch(el.get('members', []))
            if len(ring) < 4: continue
            lons = [p[0] for p in ring]; lats = [p[1] for p in ring]
            features.append({
                'type': 'Feature',
                'properties': {
                    'name': n,
                    'admin_level': el.get('tags', {}).get('admin_level', str(level)),
                    'osm_id': el['id']
                },
                'geometry': {'type': 'Polygon', 'coordinates': [ring]}
            })
        
        if not features:
            print(f'  WARNING: 0 features for {name}')
            continue
            
        geojson = {'type': 'FeatureCollection', 'features': features}
        path = f'{OUT}/{slug}.geojson'
        with open(path, 'w') as f:
            json.dump(geojson, f, separators=(',', ':'))
        print(f'  OK: {len(features)} districts → {path}')
        time.sleep(1)  # be nice to Overpass
    except Exception as e:
        print(f'  ERROR: {e}')

print('Done.')
