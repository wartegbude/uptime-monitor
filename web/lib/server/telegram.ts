import 'server-only'
import { db, must } from './db'
import { decrypt } from './crypto'
import { getSettings, type AppSettings } from './settings'
import { translate, type DictKey, type Lang } from '../i18n'
import { fmtDTs, fmtDur, fmtMs, fmtTime } from '../format'

const h = (s: unknown) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))

export async function sendTelegram(token: string, chatId: string, html: string): Promise<{ ok: true } | { ok: false; error: string; retryAfter?: number }> {
  try {
    const base = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')
    const r = await fetch(`${base}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    })
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; parameters?: { retry_after?: number } }
    if (r.ok && j.ok) return { ok: true }
    return { ok: false, error: j.description || `HTTP ${r.status}`, retryAfter: j.parameters?.retry_after }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export interface NotificationRow {
  id: number
  kind: 'down' | 'recovery' | 'slow' | 'agent_offline' | 'agent_online' | 'summary' | 'test'
  agent_id: string | null
  target_id: string | null
  payload: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  status: string
  retries: number
  created_at: string
}

/** Minutes since midnight in the given time zone. */
function localMinutes(ts: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(ts)
  const hh = +(p.find(x => x.type === 'hour')?.value || 0) % 24, mm = +(p.find(x => x.type === 'minute')?.value || 0)
  return hh * 60 + mm
}
const hm = (s: string) => { const [a, b] = s.split(':').map(Number); return (a || 0) * 60 + (b || 0) }

/** If now is inside quiet hours, returns ms until they end; otherwise 0. */
export function quietRemaining(s: AppSettings, now = Date.now()): number {
  if (!s.quiet_hours.enabled) return 0
  const cur = localMinutes(now, s.timezone), from = hm(s.quiet_hours.from), to = hm(s.quiet_hours.to)
  const inside = from <= to ? cur >= from && cur < to : cur >= from || cur < to
  if (!inside) return 0
  const left = (to - cur + 1440) % 1440
  return left * 60_000
}

function causeText(lang: Lang, cause: string | null | undefined) {
  return translate(lang, (`cause_${cause || 'other'}`) as DictKey)
}

/** Builds the Telegram text for one notification, or for a group of down/recovery notifications at one location. */
export function buildMessage(group: NotificationRow[], s: AppSettings): string {
  const lang = s.language, tz = s.timezone
  const t = (k: DictKey, v?: Record<string, string | number>) => translate(lang, k, v)
  const n = group[0], p = n.payload
  const dt = (iso: string) => fmtDTs(Date.parse(iso), lang, tz)
  const dev = !!p.is_device
  const devTag = dev ? ` · ${t('tgDevice')}` : ''
  switch (n.kind) {
    case 'down': {
      const loc = p.agent_name
      if (group.length === 1) {
        return `${dev ? '🟠' : '🔴'} <b>${t('tgDown')}${devTag}</b> · ${h(p.target_name)} (${h(loc)})\n` +
          `${t('tgMethod')}: ${h(p.method_label)} · <code>${h(p.address)}</code>\n` +
          `${t('tgCause')}: ${h(causeText(lang, p.cause))}${p.error ? ` — ${h(p.error)}` : ''}\n` +
          `${t('tgSince')}: ${dt(p.started_at)}`
      }
      const cause = group.find(g => g.payload.cause === 'isp' || g.payload.cause === 'lan')?.payload.cause
      const since = group.map(g => g.payload.started_at).sort()[0]
      return `${dev ? '🟠' : '🔴'} <b>${t('tgDown')}${devTag}</b> · ${h(loc)}: ${t('affected', { n: group.length })}\n` +
        group.map(g => `• ${h(g.payload.target_name)} <code>${h(g.payload.address)}</code>`).join('\n') + '\n' +
        (cause ? `${t('tgCause')}: ${h(causeText(lang, cause))}\n` : '') +
        `${t('tgSince')}: ${dt(since)}`
    }
    case 'recovery': {
      const loc = p.agent_name
      const late = group.some(g => g.payload.late)
      const lines = group.map(g => {
        const d = fmtDur(Date.parse(g.payload.ended_at) - Date.parse(g.payload.started_at), lang)
        return group.length === 1
          ? `${t('tgDur')}: ${d}\n${dt(g.payload.started_at)} → ${fmtTime(Date.parse(g.payload.ended_at), lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' }, tz)}`
          : `• ${h(g.payload.target_name)} — ${d}`
      }).join('\n')
      const head = group.length === 1 ? `${h(p.target_name)} (${h(loc)})` : `${h(loc)}: ${t('affected', { n: group.length })}`
      return `🟢 <b>${t('tgRec')}${devTag}</b> · ${head}\n${lines}${late ? `\n<i>${t('tgLate')}</i>` : ''}`
    }
    case 'slow':
      return `🟡 <b>${t('tgSlow')}${devTag}</b> · ${h(p.target_name)} (${h(p.agent_name)})\n${fmtMs(p.response_ms)} (${t('tgThreshold')} ${p.threshold_ms} ms)`
    case 'agent_offline':
      return `⚫ <b>${t('tgOff')}</b> · ${h(p.agent_name)}\n${t('tgLastHb')}: ${dt(p.last_heartbeat_at)}`
    case 'agent_online': {
      const d = fmtDur(Date.parse(p.ended_at) - Date.parse(p.started_at), lang)
      return `🟢 <b>${t('tgOn')}</b> · ${h(p.agent_name)}\n${t('tgOffDur')}: ${d}\n${t('tgCause')}: ${h(causeText(lang, p.cause))}`
    }
    case 'summary':
    case 'test':
      return p.html as string
  }
}

const KIND_TOGGLE: Record<string, keyof AppSettings['alerts'] | null> = {
  down: 'down', recovery: 'recovery', slow: 'slow', agent_offline: 'agent_offline', agent_online: 'agent_offline', summary: null, test: null,
}
const NON_CRITICAL = new Set(['slow', 'summary'])

/** Sends pending notifications. Groups down/recovery per location. Retries with backoff. */
export async function dispatch(): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = Date.now()
  const pending = must(await db().from('notifications').select('*').eq('status', 'pending')
    .lte('next_attempt_at', new Date(now).toISOString()).order('id').limit(100)) as NotificationRow[]
  const res = { sent: 0, failed: 0, skipped: 0 }
  if (!pending.length) return res

  const s = await getSettings()
  const token = decrypt(s.telegram.bot_token_enc), chat = s.telegram.chat_id
  const mark = async (ids: number[], patch: Record<string, unknown>) => { if (ids.length) must(await db().from('notifications').update(patch).in('id', ids)) }

  if (!token || !chat) {
    await mark(pending.map(p => p.id), { status: 'skipped', error: 'telegram_not_configured' })
    res.skipped = pending.length
    return res
  }

  const quiet = quietRemaining(s, now)
  const muteLeft = s.mute.until ? Math.max(0, Date.parse(s.mute.until) - now) : 0
  const hold = Math.max(quiet, muteLeft)
  const groups = new Map<string, NotificationRow[]>()
  const skip: number[] = [], postpone: number[] = [], muted: number[] = []
  for (const n of pending) {
    const tog = KIND_TOGGLE[n.kind]
    if (tog && !s.alerts[tog]) { skip.push(n.id); continue }
    if (n.payload?.is_device && s.alerts.device === false) { skip.push(n.id); continue }
    if (hold && NON_CRITICAL.has(n.kind)) { postpone.push(n.id); continue }
    if (muteLeft && s.mute.all && n.kind !== 'test') { muted.push(n.id); continue } // /mute ... all: drop alerts during maintenance
    const key = n.kind === 'down' || n.kind === 'recovery' ? `${n.kind}:${n.agent_id}:${n.payload?.is_device ? 'dev' : 'net'}` : `one:${n.id}`
    groups.set(key, [...(groups.get(key) || []), n])
  }
  await mark(skip, { status: 'skipped', error: 'alert_type_disabled' })
  await mark(postpone, { next_attempt_at: new Date(now + hold).toISOString() })
  await mark(muted, { status: 'skipped', error: 'muted' })
  res.skipped += skip.length + muted.length

  for (const g of groups.values()) {
    const r = await sendTelegram(token, chat, buildMessage(g, s))
    const ids = g.map(x => x.id)
    if (r.ok) { await mark(ids, { status: 'sent', sent_at: new Date().toISOString(), error: null }); res.sent += ids.length; continue }
    const retries = Math.max(...g.map(x => x.retries)) + 1
    if (retries >= 6) { await mark(ids, { status: 'failed', retries, error: r.error }); res.failed += ids.length; continue }
    const wait = r.retryAfter ? r.retryAfter * 1000 : Math.min(30, 2 ** retries) * 60_000 / 2
    await mark(ids, { retries, error: r.error, next_attempt_at: new Date(Date.now() + wait).toISOString() })
  }
  return res
}

export async function queue(rows: Omit<NotificationRow, 'id' | 'status' | 'retries' | 'created_at'>[]) {
  if (rows.length) must(await db().from('notifications').insert(rows))
}
