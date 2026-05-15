/**
 * Standalone Node.js test for GEE REST API — bypasses Next.js entirely.
 * Run: node gee_node_test.mjs
 */
import { readFileSync } from 'fs'
import { createSign } from 'crypto'

// ── Load .env.local ──────────────────────────────────────────────────────────
const env = {}
const lines = readFileSync('.env.local', 'utf8').split('\n')
for (const line of lines) {
  const trimmed = line.trim()
  if (trimmed && trimmed.includes('=') && !trimmed.startsWith('#')) {
    const [k, ...rest] = trimmed.split('=')
    env[k.trim()] = rest.join('=').trim().replace(/^"|"$/g, '')
  }
}

const SA         = env.GEE_SERVICE_ACCOUNT
const KEY_RAW    = env.GEE_PRIVATE_KEY
const PROJECT    = env.GEE_PROJECT_ID
const PRIVATE_KEY = KEY_RAW.replace(/\\n/g, '\n')

if (!SA || !KEY_RAW || !PROJECT) {
  console.error('Missing GEE env vars')
  process.exit(1)
}

console.log('Service account:', SA)
console.log('Project:', PROJECT)
console.log()

// ── JWT helper ───────────────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function makeJWT() {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: SA,
    scope: 'https://www.googleapis.com/auth/earthengine',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })))
  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  const sig = base64url(sign.sign(PRIVATE_KEY))
  return `${header}.${payload}.${sig}`
}

async function getToken() {
  const jwt = makeJWT()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`)
  return data.access_token
}

// ── Expression helpers — identical to lib/earthengine.ts ─────────────────────
const c = v => ({ constantValue: v })
const fn = (name, args) => ({ functionInvocationValue: { functionName: name, arguments: args } })

const end = new Date()
const start = new Date(end)
start.setFullYear(start.getFullYear() - 1)
const fmt = d => d.toISOString().slice(0, 10)

function buildDWMeanNode() {
  return fn('reduce.mean', {
    collection: fn('Collection.filter', {
      collection: fn('ImageCollection.load', { id: c('GOOGLE/DYNAMICWORLD/V1') }),
      filter: fn('Filter.dateRangeContains', {
        leftValue: fn('DateRange', { start: c(fmt(start)), end: c(fmt(end)) }),
        rightField: c('system:time_start'),
      }),
    }),
  })
}

function buildDWAllBandsNode() {
  return fn('Image.select', {
    input: buildDWMeanNode(),
    bandSelectors: c(['trees', 'grass', 'bare', 'built', 'water', 'shrub_and_scrub']),
  })
}

function buildPolygonNode(coordinates) {
  return fn('GeometryConstructors.Polygon', { coordinates: c(coordinates), evenOdd: c(true) })
}

// ── Test 1: same as fetchDWBandsForRing ──────────────────────────────────────
async function testReduceRegion(token) {
  const ring = [[77.165, 28.612], [77.264, 28.612], [77.264, 28.786], [77.165, 28.786], [77.165, 28.612]]

  const expression = fn('Image.reduceRegion', {
    image:      buildDWAllBandsNode(),
    reducer:    fn('Reducer.mean', {}),
    geometry:   buildPolygonNode([ring]),
    scale:      c(100),
    maxPixels:  c(1e8),
    bestEffort: c(true),
  })

  // geeCompute wrapper
  const wrapped = { result: '0', values: { '0': expression } }
  const body = JSON.stringify({ expression: wrapped })

  console.log('TEST 1 — Image.reduceRegion (same as fetchDWBandsForRing)')
  console.log('Body (first 600 chars):', body.slice(0, 600))
  console.log()

  const url = `https://earthengine.googleapis.com/v1/projects/${PROJECT}/value:compute`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  })
  const text = await res.text()
  if (res.ok) {
    const result = JSON.parse(text)?.result ?? {}
    console.log('✓ PASS — result keys:', Object.keys(result).join(', '))
    console.log('  bands:', JSON.stringify(
      Object.fromEntries(Object.entries(result).map(([k, v]) => [k, +v.toFixed(3)]))
    ))
  } else {
    console.log('✗ FAIL', res.status, text.slice(0, 400))
  }
}

// ── Test 2: WITHOUT result/values wrapper (the comment says "no wrapper") ────
async function testReduceRegionNoWrapper(token) {
  const ring = [[77.165, 28.612], [77.264, 28.612], [77.264, 28.786], [77.165, 28.786], [77.165, 28.612]]

  const expression = fn('Image.reduceRegion', {
    image:      buildDWAllBandsNode(),
    reducer:    fn('Reducer.mean', {}),
    geometry:   buildPolygonNode([ring]),
    scale:      c(100),
    maxPixels:  c(1e8),
    bestEffort: c(true),
  })

  // Send WITHOUT result/values wrapper (expression IS the fn node)
  const body = JSON.stringify({ expression })

  console.log()
  console.log('TEST 2 — Image.reduceRegion WITHOUT result/values wrapper')
  console.log('Body (first 300 chars):', body.slice(0, 300))
  console.log()

  const url = `https://earthengine.googleapis.com/v1/projects/${PROJECT}/value:compute`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  })
  const text = await res.text()
  if (res.ok) {
    const result = JSON.parse(text)?.result ?? {}
    console.log('✓ PASS — result keys:', Object.keys(result).join(', '))
  } else {
    const err = JSON.parse(text)?.error?.message ?? text.slice(0, 300)
    console.log('✗ FAIL', res.status, err)
  }
}

// ── Run tests ─────────────────────────────────────────────────────────────────
console.log('Getting token...')
const token = await getToken()
console.log('✓ Token OK\n')

await testReduceRegion(token)
await testReduceRegionNoWrapper(token)
