/**
 * Zone debug CLI — calls the debug-zones API and writes a JSON report.
 *
 * Usage:
 *   npx ts-node scripts/debugZones.ts "Westminster" "London" \
 *     -0.175 51.488 0.002 51.532
 *
 * The dev server (npm run dev) must be running on localhost:3000.
 * Output is written to debug-output/zones-<district>-<timestamp>.json
 */
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'

async function main() {
  const args = process.argv.slice(2)
  if (args.length < 6) {
    console.error('Usage: npx ts-node scripts/debugZones.ts "<District>" "<City>" <west> <south> <east> <north>')
    process.exit(1)
  }

  const [district, city, w, s, e, n] = args
  const bbox = [parseFloat(w), parseFloat(s), parseFloat(e), parseFloat(n)]

  if (bbox.some(isNaN)) {
    console.error('bbox values must be numbers — got:', args.slice(2).join(', '))
    process.exit(1)
  }

  console.log(`[debugZones] District: ${district}, City: ${city}`)
  console.log(`[debugZones] bbox: [${bbox.join(', ')}]`)
  console.log('[debugZones] Calling API... (this runs the full pipeline, expect ~60s)')

  const res = await fetch('http://localhost:3000/api/debug-zones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ districtName: district, cityName: city, bbox }),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`[debugZones] API error ${res.status}: ${text}`)
    process.exit(1)
  }

  const report = await res.json() as {
    summary: {
      totalCandidates: number; passedMCDA: number; passedAgent1: number
      passedSpatialValidator: number; passedAgent2: number; finalZones: number
      droppedUnnecessarily: number
    }
    suspiciousDrops: Array<{ zoneId: string; mcdaScore: number; stage: string; dropReason?: string; coordinates: [number, number] }>
    suspiciousPasses: Array<{ zoneId: string; mcdaScore: number; agent1Critique?: string }>
  }

  const { summary } = report

  console.log('\n── Summary ──────────────────────────────────────────────────────────────')
  console.log(`  Total candidates (post-validate) : ${summary.totalCandidates}`)
  console.log(`  Passed MCDA pre-filter           : ${summary.passedMCDA}`)
  console.log(`  Passed Agent 1                   : ${summary.passedAgent1}`)
  console.log(`  Passed Spatial Validator          : ${summary.passedSpatialValidator}`)
  console.log(`  Passed Agent 2 / Final zones      : ${summary.passedAgent2} / ${summary.finalZones}`)
  console.log(`  Suspicious drops (MCDA≥65, drop) : ${summary.droppedUnnecessarily}`)

  if (report.suspiciousDrops.length > 0) {
    console.log('\n── Suspicious Drops ─────────────────────────────────────────────────────')
    for (const z of report.suspiciousDrops) {
      console.log(`  ${z.zoneId} | MCDA: ${z.mcdaScore} | stage: ${z.stage}`)
      console.log(`  Reason : ${z.dropReason ?? 'n/a'}`)
      console.log(`  Coords : ${z.coordinates[0].toFixed(5)}, ${z.coordinates[1].toFixed(5)}`)
    }
  }

  if (report.suspiciousPasses.length > 0) {
    console.log('\n── Suspicious Passes ────────────────────────────────────────────────────')
    for (const z of report.suspiciousPasses) {
      console.log(`  ${z.zoneId} | MCDA: ${z.mcdaScore}`)
      if (z.agent1Critique) console.log(`  Agent1: "${z.agent1Critique}"`)
    }
  }

  // Write JSON output
  const outputDir = path.join(process.cwd(), 'debug-output')
  await mkdir(outputDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `zones-${district.replace(/\s+/g, '_')}-${ts}.json`
  const outPath = path.join(outputDir, filename)
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n[debugZones] Report written to: ${outPath}`)
}

main().catch(err => {
  console.error('[debugZones] Fatal error:', err)
  process.exit(1)
})
