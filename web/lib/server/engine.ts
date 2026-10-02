import 'server-only'
import { randomUUID } from 'node:crypto'
import { db, must } from './db'
import { getSettings } from './settings'
import { queue, type NotificationRow } from './telegram'
import { methodLabel } from '../format'
import type { Agent, Incident, Target } from '../types'

export interface ResultIn {
  target_id: string
  checked_at: string
  success: boolean
  response_ms?: number | null
  status_code?: number | null
  packet_loss?: number | null
  error?: string | null
  error_kind?: string | null
  detail?: string | null
  delayed?: boolean
}

type NewNotif = Omit<NotificationRow, 'id' | 'status' | 'retries' | 'created_at'>
const RUNTIME_FIELDS = ['state', 'consec_fail', 'first_fail_at', 'consec_slow', 'state_since', 'last_checked_at', 'last_response_ms', 'last_error', 'last_down_alert_at', 'slow_alerted'] as const
const ERROR_KINDS = new Set(['timeout', 'dns', 'status', 'loss', 'conn', 'tls', 'other'])

/**
 * Stores check results from one agent and runs the status state machine:
 * N consecutive failures → DOWN (incident + alert), first success → recovery,
 * N consecutive slow responses → SLOW alert. Results from the offline buffer (delayed)
 * are recorded as incidents but do not send live down alerts.
 */
export async function ingest(agent: Agent, results: ResultIn[]) {
  const now = Date.now()
  const targets = must(await db().from('targets').select('*').eq('agent_id', agent.id)) as Target[]
  const byId = new Map(targets.map(t => [t.id, t]))
  const valid = results
    .filter(r => byId.has(r.target_id) && typeof r.success === 'boolean' && !Number.isNaN(Date.parse(r.checked_at)))
    .map(r => ({ ...r, checked_at: new Date(Math.min(Date.parse(r.checked_at), now + 60_000)).toISOString() }))
  if (!valid.length) return { stored: 0 }

  for (let i = 0; i < valid.length; i += 500) {
    must(await db().from('check_results').insert(valid.slice(i, i + 500).map(r => ({
      target_id: r.target_id, checked_at: r.checked_at, success: r.success,
      response_ms: r.response_ms ?? null, status_code: r.status_code ?? null, packet_loss: r.packet_loss ?? null,
      error: r.error ? String(r.error).slice(0, 500) : null, detail: r.detail ? String(r.detail).slice(0, 500) : null, delayed: !!r.delayed,
    }))))
  }

  const settings = await getSettings()
  const cooldownMs = Math.max(0, settings.cooldown_min) * 60_000
  const openList = must(await db().from('incidents').select('*').eq('agent_id', agent.id).eq('kind', 'target_down').is('ended_at', null)) as Incident[]
  const open = new Map(openList.filter(i => i.target_id).map(i => [i.target_id!, i]))
  const touchedInc = new Map<string, Incident>()
  const notifs: NewNotif[] = []
  const changed = new Set<string>()
  const agentWasOffline = agent.status === 'offline'

  const base = (t: Target) => ({ agent_id: agent.id, target_id: t.id })
  const info = (t: Target) => ({ target_name: t.name, agent_name: agent.name, method_label: methodLabel(t.method), address: t.address })

  function locationCause(t: Target): string | null {
    if (t.is_gateway) return null
    const mine = targets.filter(x => x.agent_id === t.agent_id && !x.paused)
    const gw = mine.find(x => x.is_gateway)
    if (!gw) return null
    if (gw.state === 'down') return 'lan'
    const ext = mine.filter(x => !x.is_gateway)
    return ext.length > 1 && ext.every(x => x.state === 'down') ? 'isp' : null
  }

  function notifyDown(t: Target, inc: Incident, at: number) {
    const cooled = t.last_down_alert_at && at - Date.parse(t.last_down_alert_at) < cooldownMs
    if (cooled) return
    inc.notified = true
    t.last_down_alert_at = new Date(at).toISOString()
    notifs.push({ kind: 'down', ...base(t), payload: { ...info(t), cause: inc.cause, error: inc.detail, started_at: inc.started_at } })
  }

  valid.sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at))
  for (const r of valid) {
    const t = byId.get(r.target_id)!
    if (t.paused) continue
    const at = Date.parse(r.checked_at)
    if (t.last_checked_at && at < Date.parse(t.last_checked_at)) continue // out of order
    changed.add(t.id)
    t.last_checked_at = r.checked_at
    t.last_response_ms = r.success ? (r.response_ms ?? null) : null
    t.last_error = r.success ? null : (r.error || 'failed')

    if (!r.success) {
      t.consec_slow = 0
      t.consec_fail += 1
      if (t.consec_fail === 1 || !t.first_fail_at) t.first_fail_at = r.checked_at
      const kind = r.error_kind && ERROR_KINDS.has(r.error_kind) ? r.error_kind : 'other'
      if (t.state !== 'down' && t.consec_fail >= t.fail_threshold) {
        t.state = 'down'
        t.state_since = t.first_fail_at
        const inc: Incident = {
          id: randomUUID(), kind: 'target_down', target_id: t.id, agent_id: agent.id,
          started_at: t.first_fail_at!, ended_at: null, cause: (locationCause(t) || kind) as Incident['cause'],
          detail: r.error ? String(r.error).slice(0, 300) : null, notified: false,
        }
        open.set(t.id, inc); touchedInc.set(inc.id, inc)
        // other targets at this location that are already down get the location-level cause too
        if (inc.cause === 'isp' || inc.cause === 'lan') {
          for (const o of open.values()) if (o.agent_id === agent.id && o.ended_at == null && o.cause !== inc.cause && o.target_id !== t.id && !byId.get(o.target_id!)?.is_gateway) { o.cause = inc.cause; touchedInc.set(o.id, o) }
        }
        if (!r.delayed) notifyDown(t, inc, at)
      } else if (t.state === 'down' && !r.delayed) {
        // still down after the connection came back: a live alert is now due
        const inc = open.get(t.id)
        if (inc && !inc.notified) { notifyDown(t, inc, at); touchedInc.set(inc.id, inc) }
      }
      continue
    }

    // success
    if (t.state === 'down') {
      const inc = open.get(t.id)
      if (inc) {
        inc.ended_at = r.checked_at
        touchedInc.set(inc.id, inc); open.delete(t.id)
        const payload = { ...info(t), started_at: inc.started_at, ended_at: inc.ended_at }
        if (inc.notified) notifs.push({ kind: 'recovery', ...base(t), payload: { ...payload, late: false } })
        else if (!agentWasOffline && at - Date.parse(inc.started_at) >= 60_000) notifs.push({ kind: 'recovery', ...base(t), payload: { ...payload, late: true } })
      }
      t.state = 'up'; t.state_since = r.checked_at
    }
    t.consec_fail = 0; t.first_fail_at = null
    const slow = r.response_ms != null && r.response_ms > t.slow_threshold_ms
    if (slow) {
      t.consec_slow += 1
      if (t.consec_slow >= t.fail_threshold) {
        if (t.state !== 'slow') { t.state = 'slow'; t.state_since = r.checked_at }
        if (!t.slow_alerted && !r.delayed) {
          t.slow_alerted = true
          notifs.push({ kind: 'slow', ...base(t), payload: { ...info(t), response_ms: r.response_ms, threshold_ms: t.slow_threshold_ms } })
        }
      } else if (t.state === 'unknown') { t.state = 'up'; t.state_since = r.checked_at }
    } else {
      t.consec_slow = 0; t.slow_alerted = false
      if (t.state !== 'up') { t.state = 'up'; t.state_since = r.checked_at }
    }
  }

  for (const id of changed) {
    const t = byId.get(id)!
    const patch: Record<string, unknown> = {}
    for (const f of RUNTIME_FIELDS) patch[f] = t[f]
    must(await db().from('targets').update(patch).eq('id', id))
  }
  if (touchedInc.size) must(await db().from('incidents').upsert([...touchedInc.values()]))
  await queue(notifs)
  return { stored: valid.length, notifications: notifs.length }
}

/**
 * Marks the agent online. If it was offline, closes the agent_offline incident and decides the cause:
 * failed checks from the buffer (or offline events reported by the agent) during the gap → internet;
 * no results at all → server/agent was down.
 */
export async function touchAgent(agent: Agent, meta: { host?: string; version?: string; offline_events?: { start: string; end: string }[] }) {
  const nowIso = new Date().toISOString()
  must(await db().from('agents').update({
    status: 'online', last_heartbeat_at: nowIso,
    ...(meta.host ? { host: String(meta.host).slice(0, 100) } : {}),
    ...(meta.version ? { agent_version: String(meta.version).slice(0, 40) } : {}),
  }).eq('id', agent.id))

  const openOff = must(await db().from('incidents').select('*').eq('agent_id', agent.id).eq('kind', 'agent_offline').is('ended_at', null)) as Incident[]
  if (!openOff.length) return
  const targetIds = (must(await db().from('targets').select('id').eq('agent_id', agent.id)) as { id: string }[]).map(x => x.id)
  const notifs: NewNotif[] = []
  for (const inc of openOff) {
    let internet = false
    if (targetIds.length) {
      const { count } = await db().from('check_results').select('id', { count: 'exact', head: true })
        .in('target_id', targetIds).eq('delayed', true).eq('success', false)
        .gte('checked_at', inc.started_at).lte('checked_at', nowIso)
      internet = (count || 0) > 0
    }
    if (!internet && meta.offline_events?.length) {
      const s = Date.parse(inc.started_at)
      internet = meta.offline_events.some(e => Date.parse(e.end) >= s)
    }
    const cause = internet ? 'internet' : 'server'
    must(await db().from('incidents').update({ ended_at: nowIso, cause }).eq('id', inc.id))
    if (inc.notified) notifs.push({ kind: 'agent_online', agent_id: agent.id, target_id: null, payload: { agent_name: agent.name, started_at: inc.started_at, ended_at: nowIso, cause } })
  }
  await queue(notifs)
}
