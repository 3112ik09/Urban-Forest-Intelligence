import type { NextApiRequest, NextApiResponse } from 'next'
import { debugZoneSelection, type ZoneDebugReport, type ZoneTrace } from '@/lib/debugZones'

function printReport(r: ZoneDebugReport) {
  const s = r.summary
  console.log(`\n[DEBUG] ── Zone Selection Report ── ${r.district}, ${r.city}`)
  console.log(`[DEBUG] Candidates: ${s.totalCandidates} → MCDA pass: ${s.passedMCDA} → Agent1 pass: ${s.passedAgent1} → Validator pass: ${s.passedSpatialValidator} → Agent2 final: ${s.finalZones}`)

  if (r.suspiciousDrops.length > 0) {
    console.log('\n[DEBUG] SUSPICIOUS DROPS (high MCDA, got dropped):')
    for (const z of r.suspiciousDrops) {
      const b = z.bandValues
      console.log(`[DEBUG]   ${z.zoneId} | MCDA: ${(z.mcdaScore / 100).toFixed(2)} | dropped at: ${z.stage}`)
      if (z.dropReason) console.log(`[DEBUG]   Reason: "${z.dropReason}"`)
      console.log(`[DEBUG]   Bands: ndvi=${b.ndvi} ndbi=${b.ndbi} open=${b.open_pct}% area=${b.area_ha}ha`)
    }
  }

  if (r.suspiciousPasses.length > 0) {
    console.log('\n[DEBUG] SUSPICIOUS PASSES (low MCDA, made it through):')
    for (const z of r.suspiciousPasses) {
      console.log(`[DEBUG]   ${z.zoneId} | MCDA: ${(z.mcdaScore / 100).toFixed(2)} | reached: final`)
      if (z.agent1Critique) console.log(`[DEBUG]   Agent1: "${z.agent1Critique}"`)
    }
  }

  const dropped: ZoneTrace[] = r.zones.filter(z => z.verdict === 'dropped')
  if (dropped.length > 0) {
    console.log('\n[DEBUG] ALL DROPPED ZONES:')
    for (const z of dropped) {
      console.log(`[DEBUG]   ${z.zoneId} | MCDA: ${(z.mcdaScore / 100).toFixed(2)} | stage: ${z.stage}`)
      if (z.validatorFlags?.length) {
        console.log(`[DEBUG]   Flags: ${JSON.stringify(z.validatorFlags)}`)
      } else if (z.dropReason) {
        console.log(`[DEBUG]   Reason: "${z.dropReason}"`)
      }
    }
  }

  if (dropped.length === 0 && r.suspiciousDrops.length === 0) {
    console.log('[DEBUG] All candidates passed every stage — no suspicious drops.')
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { districtName, cityName, bbox } = req.body as {
    districtName: string
    cityName: string
    bbox: [number, number, number, number]
  }

  if (!districtName || !cityName || !Array.isArray(bbox) || bbox.length !== 4) {
    return res.status(400).json({ error: 'districtName, cityName, and bbox (4-element array) required' })
  }

  try {
    const report = await debugZoneSelection(districtName, cityName, bbox as [number, number, number, number])
    printReport(report)
    return res.status(200).json(report)
  } catch (err) {
    console.error('[debug-zones] failed:', err)
    return res.status(500).json({ error: String(err) })
  }
}
