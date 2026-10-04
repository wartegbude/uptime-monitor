import { db, must } from '@/lib/server/db'
import { handle, json, requireUser } from '@/lib/server/http'
import { parseRange, uuidOrNull } from '@/lib/server/range'
import type { Agent, DashboardData, Incident, SeriesPoint, Target } from '@/lib/types'
import { byDisplayOrder } from '@/lib/uptime'

export const dynamic = 'force-dynamic'

/** Everything the dashboard needs for one location filter + time range. Uptime math happens client-side (lib/uptime). */
export const GET = handle(async (req: Request) => {
  await requireUser()
  const url = new URL(req.url)
  const { from, to, now, step } = parseRange(url)
  const loc = uuidOrNull(url.searchParams.get('loc'))
  const targetId = uuidOrNull(url.searchParams.get('target'))

  const agents = must(await db().from('agents').select('id,name,host,token_tail,status,last_heartbeat_at,heartbeat_timeout_sec,agent_version,created_at').order('created_at')) as Agent[]
  let tq = db().from('targets').select('*').order('sort_order').order('created_at')
  if (loc) tq = tq.eq('agent_id', loc)
  if (targetId) tq = tq.eq('id', targetId)
  const targets = byDisplayOrder(must(await tq) as Target[], agents)

  let iq = db().from('incidents').select('*')
    .lt('started_at', new Date(to).toISOString())
    .or(`ended_at.is.null,ended_at.gt.${new Date(from).toISOString()}`)
    .order('started_at', { ascending: false }).limit(1000)
  if (loc) iq = iq.eq('agent_id', loc)
  const incidents = must(await iq) as Incident[]

  const series = targets.length
    ? (must(await db().rpc('get_series', {
        p_target_ids: targets.map(t => t.id),
        p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(), p_step_sec: Math.round(step / 1000),
      })) as SeriesPoint[])
    : []

  const data: DashboardData = { now, from, to, step, agents, targets, incidents, series: series.map(p => ({ ...p, t: Math.round(Number(p.t)) })) }
  return json(data)
})
