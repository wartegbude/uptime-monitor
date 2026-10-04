import 'server-only'
import { db, must } from './db'
import { getSettings, setSetting, type AppSettings } from './settings'
import { dispatch, queue } from './telegram'
import { translate } from '../i18n'
import { fmtDT, fmtDur, fmtMs, fmtPct, HOUR, DAY } from '../format'
import { incEnd, incStart, targetUptime } from '../uptime'
import type { Agent, Incident, Target } from '../types'

/** Runs every minute (pg_cron → /api/cron/tick). */
export async function tick() {
  const offline = await detectOfflineAgents()
  const summary = await maybeQueueSummary()
  const sent = await dispatch()
  return { offline, summary, sent }
}

async function detectOfflineAgents() {
  const agents = must(await db().from('agents').select('*').eq('status', 'online')) as Agent[]
  const now = Date.now()
  const gone = agents.filter(a => !a.last_heartbeat_at || now - Date.parse(a.last_heartbeat_at) > a.heartbeat_timeout_sec * 1000)
  for (const a of gone) {
    // conditional update so two overlapping ticks cannot open two incidents
    const upd = must(await db().from('agents').update({ status: 'offline' }).eq('id', a.id).eq('status', 'online').select('id')) as { id: string }[]
    if (!upd.length) continue
    const started = a.last_heartbeat_at || new Date(now).toISOString()
    must(await db().from('incidents').insert({ kind: 'agent_offline', agent_id: a.id, started_at: started, cause: null, notified: true }))
    // per-target alerts for this location are suppressed while it is offline
    must(await db().from('notifications').update({ status: 'skipped', error: 'agent_offline' }).eq('agent_id', a.id).eq('status', 'pending').in('kind', ['down', 'slow']))
    await queue([{ kind: 'agent_offline', agent_id: a.id, target_id: null, payload: { agent_name: a.name, last_heartbeat_at: started } }])
  }
  return gone.length
}

function localParts(ts: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(ts)
  const g = (k: string) => p.find(x => x.type === k)?.value || ''
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'))
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: (+g('hour') % 24) * 60 + +g('minute'), weekday: wd }
}

export function summaryPeriodMs(s: AppSettings['summary']) {
  return s.frequency === '1h' ? HOUR : s.frequency === '6h' ? 6 * HOUR : s.frequency === 'custom' ? Math.max(1, s.every_hours) * HOUR : s.frequency === 'weekly' ? 7 * DAY : DAY
}

function summaryDue(s: AppSettings, now: number): boolean {
  const sum = s.summary
  if (!sum.enabled) return false
  const last = sum.last_sent_at ? Date.parse(sum.last_sent_at) : 0
  if (sum.frequency === 'daily' || sum.frequency === 'weekly') {
    const cur = localParts(now, s.timezone)
    const [h, m] = sum.at.split(':').map(Number)
    if (cur.minutes < h * 60 + m) return false
    if (sum.frequency === 'weekly' && cur.weekday !== sum.weekday) return false
    return !last || localParts(last, s.timezone).date !== cur.date
  }
  if (!last) return true
  return now - last >= summaryPeriodMs(sum) - 30_000
}

async function maybeQueueSummary() {
  const s = await getSettings()
  const now = Date.now()
  if (s.summary.enabled && !s.summary.last_sent_at) {
    // first run: start the schedule from now instead of sending a summary of an empty period
    await setSetting('summary', { ...s.summary, last_sent_at: new Date(now).toISOString() })
    return false
  }
  if (!summaryDue(s, now)) return false
  const from = s.summary.last_sent_at ? Math.max(Date.parse(s.summary.last_sent_at), now - summaryPeriodMs(s.summary)) : now - summaryPeriodMs(s.summary)
  const html = await buildSummary(s, from, now)
  await setSetting('summary', { ...s.summary, last_sent_at: new Date(now).toISOString() })
  await queue([{ kind: 'summary', agent_id: null, target_id: null, payload: { html } }])
  return true
}

export async function buildSummary(s: AppSettings, from: number, to: number): Promise<string> {
  const lang = s.language, tz = s.timezone
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(lang, k, v)
  const agents = (must(await db().from('agents').select('*').neq('status', 'revoked').order('name')) as Agent[])
  const targets = must(await db().from('targets').select('*').order('sort_order').order('created_at')) as Target[]
  const incs = must(await db().from('incidents').select('*').lt('started_at', new Date(to).toISOString())
    .or(`ended_at.is.null,ended_at.gt.${new Date(from).toISOString()}`).limit(2000)) as Incident[]
  // per-target response stats from raw results (accurate even before hourly rollups refresh)
  const stats = new Map<string, { avg: number | null; max: number | null }>()
  await Promise.all(targets.map(async x => {
    const r = await db().rpc('target_stats', { p_target: x.id, p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() })
    if (!r.error) stats.set(x.id, r.data as { avg: number | null; max: number | null })
  }))
  const esc = (x: string) => x.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))

  const blocks = agents.map(a => {
    const ts = targets.filter(x => x.agent_id === a.id)
    const core = ts.filter(x => !x.is_device) // external devices don't count toward location uptime
    const coreIds = new Set(core.map(x => x.id))
    let down = 0, mon = 0
    for (const x of core) { const r = targetUptime(x, incs, from, to, to); down += r.down; mon += r.monitored }
    const mine = incs.filter(i => i.agent_id === a.id && (i.kind === 'agent_offline' || (i.target_id != null && coreIds.has(i.target_id))))
    const longest = mine.reduce((m, i) => Math.max(m, Math.min(incEnd(i, to), to) - Math.max(incStart(i), from)), 0)
    const off = mine.filter(i => i.kind === 'agent_offline').reduce((sum, i) => sum + Math.max(0, Math.min(incEnd(i, to), to) - Math.max(incStart(i), from)), 0)
    const head = `<b>${esc(a.name)}</b> — ${mon ? fmtPct((1 - down / mon) * 100) : t('tgNone')} · ${t('tgDur')} ${fmtDur(down, lang)} · ${mine.length} ${t('tgIncidents')}` +
      (longest ? ` · ${t('tgLongest')} ${fmtDur(longest, lang)}` : '') + (off ? ` · ${t('tgAgentOff')} ${fmtDur(off, lang)}` : '')
    const lines = ts.map(x => {
      const st = stats.get(x.id)
      const avg = st?.avg ?? null, max = st?.max ?? null
      const dev = x.is_device ? ` (${t('device')}, ${t('uptime').toLowerCase()} ${fmtPct((targetUptime(x, incs, from, to, to).up ?? 0) * 100)})` : ''
      return `  • ${esc(x.name)}${dev}: ${t('avg').toLowerCase()} ${fmtMs(avg)}, ${t('max').toLowerCase()} ${fmtMs(max)}`
    })
    return [head, ...lines].join('\n')
  })
  return `📊 <b>${t('tgSum')}</b>\n${t('tgPeriod')}: ${fmtDT(from, lang, tz)} – ${fmtDT(to, lang, tz)}\n\n${blocks.join('\n\n') || t('tgNone')}`
}
