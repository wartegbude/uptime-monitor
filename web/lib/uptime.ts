/**
 * Uptime math shared by the dashboard, the detail page and the Telegram summary.
 *
 * Definitions (PRD "Definisi status"):
 * - Downtime of a target = target_down incidents for it ∪ agent_offline incidents caused by the internet
 *   (the agent's buffer proved checks were failing). Gateway targets are not counted down for those.
 * - No data = agent_offline incidents with another/unknown cause (server off, or still offline).
 * - Uptime % = up time ÷ monitored time, where monitored time excludes "no data" and time before the target existed.
 */
import type { Agent, Incident, Target, TargetState } from './types'

type Iv = [number, number]

export const incStart = (i: Incident) => Date.parse(i.started_at)
export const incEnd = (i: Incident, now: number) => (i.ended_at ? Date.parse(i.ended_at) : now)

function clip(iv: Iv, a: number, b: number): Iv | null {
  const s = Math.max(iv[0], a), e = Math.min(iv[1], b)
  return e > s ? [s, e] : null
}

export function unionLen(ivs: Iv[]): number {
  const s = ivs.slice().sort((x, y) => x[0] - y[0])
  let tot = 0, cs = -1, ce = -1
  for (const [a, b] of s) {
    if (cs < 0) { cs = a; ce = b } else if (a <= ce) { ce = Math.max(ce, b) } else { tot += ce - cs; cs = a; ce = b }
  }
  if (cs >= 0) tot += ce - cs
  return tot
}

export function downIntervals(t: Pick<Target, 'id' | 'agent_id' | 'is_gateway'>, incs: Incident[], a: number, b: number, now: number): Iv[] {
  const out: Iv[] = []
  for (const i of incs) {
    const hit = (i.kind === 'target_down' && i.target_id === t.id) ||
      (i.kind === 'agent_offline' && i.agent_id === t.agent_id && i.cause === 'internet' && !t.is_gateway)
    if (!hit) continue
    const c = clip([incStart(i), incEnd(i, now)], a, b)
    if (c) out.push(c)
  }
  return out
}

export function noDataIntervals(t: Pick<Target, 'agent_id'>, incs: Incident[], a: number, b: number, now: number): Iv[] {
  const out: Iv[] = []
  for (const i of incs) {
    if (i.kind !== 'agent_offline' || i.agent_id !== t.agent_id || i.cause === 'internet') continue
    const c = clip([incStart(i), incEnd(i, now)], a, b)
    if (c) out.push(c)
  }
  return out
}

export interface UptimeResult { down: number; monitored: number; up: number | null }

export function targetUptime(t: Pick<Target, 'id' | 'agent_id' | 'is_gateway' | 'created_at'>, incs: Incident[], a: number, b: number, now: number): UptimeResult {
  const start = Math.max(a, Date.parse(t.created_at))
  const end = Math.min(b, now)
  if (end <= start) return { down: 0, monitored: 0, up: null }
  const nod = unionLen(noDataIntervals(t, incs, start, end, now))
  const down = unionLen(downIntervals(t, incs, start, end, now))
  const monitored = Math.max(0, end - start - nod)
  return { down, monitored, up: monitored > 0 ? Math.max(0, 1 - down / monitored) : null }
}

/** Blocks for the uptime bar. cls: '' up, 'p' partly down, 'd' mostly down, 'n' no data. */
export function uptimeBlocks(t: Pick<Target, 'id' | 'agent_id' | 'is_gateway' | 'created_at'>, incs: Incident[], a: number, b: number, now: number, n: number) {
  const w = (b - a) / n
  const out: { s: number; e: number; cls: '' | 'p' | 'd' | 'n'; down: number }[] = []
  for (let k = 0; k < n; k++) {
    const s = a + k * w, e = s + w
    const r = targetUptime(t, incs, s, e, now)
    let cls: '' | 'p' | 'd' | 'n' = ''
    if (r.monitored < (e - s) * 0.05) cls = 'n'
    else if (r.down > 0) cls = r.down > r.monitored * 0.5 ? 'd' : 'p'
    out.push({ s, e, cls, down: r.down })
  }
  return out
}

export type LiveState = TargetState | 'off' | 'paused' | 'nodata'

export function liveState(t: Target, agent: Agent | undefined): LiveState {
  if (t.paused) return 'paused'
  if (!agent || agent.status === 'offline' || agent.status === 'revoked') return 'off'
  if (agent.status === 'pending' || t.state === 'unknown') return 'nodata'
  return t.state
}

export type LocState = 'ok' | 'degraded' | 'down' | 'off' | 'pending'

export function locationState(agent: Agent, targets: Target[]): LocState {
  if (agent.status === 'pending') return 'pending'
  if (agent.status !== 'online') return 'off'
  const ts = targets.filter(t => t.agent_id === agent.id && !t.paused)
  const ext = ts.filter(t => !t.is_gateway)
  if (ext.length && ext.every(t => t.state === 'down')) return 'down'
  if (ts.some(t => t.state === 'down' || t.state === 'slow')) return 'degraded'
  return 'ok'
}
