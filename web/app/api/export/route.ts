import { db, must } from '@/lib/server/db'
import { handle, requireUser } from '@/lib/server/http'
import { logParams, parseRange, uuidOrNull } from '@/lib/server/range'
import type { Incident, LogRow } from '@/lib/types'

export const dynamic = 'force-dynamic'

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csv = (rows: unknown[][]) => rows.map(r => r.map(cell).join(',')).join('\n') + '\n'

/** CSV export of the check log or incidents (PRD DB-11). */
export const GET = handle(async (req: Request) => {
  await requireUser()
  const url = new URL(req.url)
  const type = url.searchParams.get('type') === 'incidents' ? 'incidents' : 'logs'
  let text: string
  if (type === 'logs') {
    const res = must(await db().rpc('get_logs', { ...logParams(url), p_limit: 50000, p_offset: 0 })) as { rows: LogRow[] }
    text = csv([
      ['checked_at', 'location', 'target', 'method', 'address', 'status', 'response_ms', 'status_code', 'packet_loss', 'error', 'delayed'],
      ...res.rows.map(r => [r.checked_at, r.agent_name, r.target_name, r.method, r.address, r.status, r.response_ms, r.status_code, r.packet_loss, r.error, r.delayed]),
    ])
  } else {
    const { from, to } = parseRange(url)
    let q = db().from('incidents').select('*, agents(name), targets(name)').lt('started_at', new Date(to).toISOString())
      .or(`ended_at.is.null,ended_at.gt.${new Date(from).toISOString()}`).order('started_at', { ascending: false }).limit(5000)
    const loc = uuidOrNull(url.searchParams.get('loc'))
    if (loc) q = q.eq('agent_id', loc)
    const rows = must(await q) as (Incident & { agents: { name: string } | null; targets: { name: string } | null })[]
    text = csv([
      ['started_at', 'ended_at', 'duration_sec', 'kind', 'location', 'target', 'cause', 'detail'],
      ...rows.map(i => [i.started_at, i.ended_at, i.ended_at ? Math.round((Date.parse(i.ended_at) - Date.parse(i.started_at)) / 1000) : '', i.kind, i.agents?.name, i.targets?.name, i.cause, i.detail]),
    ])
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')
  return new Response(text, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="uptime-${type}-${stamp}.csv"` },
  })
})
