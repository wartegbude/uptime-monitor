import 'server-only'
import { createHmac } from 'node:crypto'
import { db, must } from './db'
import { decrypt } from './crypto'
import { env } from './env'
import { getSettings, setSetting, type AppSettings } from './settings'
import { sendTelegram } from './telegram'
import { buildSummary, summaryPeriodMs } from './tick'
import { translate, type DictKey } from '../i18n'
import { DAY, HOUR, MIN, fmtDT, fmtDur, fmtMs, fmtPct, methodLabel } from '../format'
import { incEnd, incStart, locationState, targetUptime, unionLen } from '../uptime'
import type { Agent, Incident, Target } from '../types'

/** Secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token; derived so no extra env var is needed. */
export const webhookSecret = () => createHmac('sha256', env.encryptionKey).update('telegram-webhook').digest('hex').slice(0, 48)

const tgBase = () => (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')

export async function telegramApi(token: string, method: string, body?: unknown) {
  const r = await fetch(`${tgBase()}/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(8000),
  })
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown }
  if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`)
  return j.result
}

export const COMMANDS = ['status', 'targets', 'uptime', 'incidents', 'summary', 'test', 'mute', 'unmute', 'help'] as const

const h = (s: unknown) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
const STATE_ICON: Record<string, string> = { ok: '🟢', degraded: '🟡', down: '🔴', off: '⚫', pending: '⏳' }
const TARGET_ICON: Record<string, string> = { up: '✅', slow: '🐢', down: '🔴', unknown: '⏳' }

interface TgMessage { chat?: { id: number | string }; text?: string }

/** Handles one Telegram update. Only the configured chat gets answers; everything else is ignored silently. */
export async function handleUpdate(update: { message?: TgMessage; edited_message?: TgMessage }) {
  const msg = update.message
  const text = msg?.text?.trim()
  if (!msg?.chat || !text || !text.startsWith('/')) return
  const s = await getSettings()
  const token = decrypt(s.telegram.bot_token_enc)
  if (!token || !s.telegram.chat_id || String(msg.chat.id) !== String(s.telegram.chat_id)) return

  const [head, ...rest] = text.split(/\s+/)
  const cmd = head.slice(1).split('@')[0].toLowerCase()
  const arg = rest.join(' ').trim()
  const reply = await runCommand(cmd, arg, s, String(msg.chat.id))
  if (reply) await sendTelegram(token, String(msg.chat.id), reply)
}

async function load() {
  const [agents, targets] = await Promise.all([
    db().from('agents').select('*').neq('status', 'revoked').order('created_at'),
    db().from('targets').select('*').order('sort_order').order('created_at'),
  ])
  return { agents: must(agents) as Agent[], targets: must(targets) as Target[] }
}

async function incidentsSince(from: number) {
  return must(await db().from('incidents').select('*')
    .or(`ended_at.is.null,ended_at.gt.${new Date(from).toISOString()}`)
    .order('started_at', { ascending: false }).limit(1000)) as Incident[]
}

export async function runCommand(cmd: string, arg: string, s: AppSettings, chatId: string): Promise<string | null> {
  const lang = s.language, tz = s.timezone
  const t = (k: DictKey, v?: Record<string, string | number>) => translate(lang, k, v)
  const now = Date.now()
  const ago = (ts: number) => t('ago', { t: fmtDur(now - ts, lang) })
  const stamp = `${fmtDT(now, lang, tz)} ${tz === 'Asia/Jakarta' ? 'WIB' : ''}`.trim()

  switch (cmd) {
    case 'start':
    case 'help':
      return `<b>${t('appName')}</b>\n${t('bot_help')}\n` + COMMANDS.map(c => `/${c} — ${h(t(`cmd_${c}` as DictKey))}`).join('\n')

    case 'status': {
      const { agents, targets } = await load()
      if (!agents.length) return t('bot_noData')
      const lines = agents.map(a => {
        const st = locationState(a, targets)
        const all = targets.filter(x => x.agent_id === a.id && !x.paused)
        const mine = all.filter(x => !x.is_device)
        const gw = mine.find(x => x.is_gateway), ext = mine.filter(x => !x.is_gateway)
        const hb = a.last_heartbeat_at ? Date.parse(a.last_heartbeat_at) : null
        let sub: string
        if (st === 'pending') sub = t('bot_never')
        else if (st === 'off') sub = t('bot_offSince', { t: hb ? fmtDT(hb, lang, tz) : '–', d: hb ? fmtDur(now - hb, lang) : '–' })
        else {
          const lan = gw ? (gw.state === 'down' ? t('lanBad') : t('lanOk')) : null
          const isp = ext.length ? (ext.every(x => x.state === 'down') && gw?.state !== 'down' ? t('ispBad') : gw?.state === 'down' ? null : t('ispOk')) : null
          sub = [lan, isp, hb ? t('bot_hb', { t: ago(hb) }) : null].filter(Boolean).join(' · ')
          const down = mine.filter(x => x.state === 'down').map(x => x.name)
          if (down.length && st !== 'down') sub += `\n   🔴 ${h(down.join(', '))}`
          const devDown = all.filter(x => x.is_device && x.state === 'down').map(x => x.name)
          if (devDown.length) sub += `\n   🟠 ${t('device')}: ${h(devDown.join(', '))}`
        }
        return `${STATE_ICON[st]} <b>${h(a.name)}</b> — ${t(`loc_${st}` as DictKey)}\n   ${sub}`
      })
      const mute = muteLine(s, now, t, lang, tz)
      return `📡 <b>${t('bot_statusTitle')}</b> · ${stamp}\n\n${lines.join('\n\n')}${mute ? `\n\n🔕 ${mute}` : ''}`
    }

    case 'targets': {
      const { agents, targets } = await load()
      if (!targets.length) return t('bot_noData')
      const blocks = agents.map(a => {
        const mine = targets.filter(x => x.agent_id === a.id)
        if (!mine.length) return null
        const off = a.status !== 'online'
        const rows = mine.map(x => {
          const icon = x.paused ? '⏸' : off ? '⚫' : TARGET_ICON[x.state] || '⏳'
          const val = x.paused ? t('st_paused') : off ? t('st_off')
            : x.state === 'down' ? t('bot_downSince', { t: x.state_since ? fmtDT(Date.parse(x.state_since), lang, tz) : '–' })
            : fmtMs(x.last_response_ms)
          return `${icon} ${h(x.name)} · ${methodLabel(x.method)} <code>${h(x.address)}</code> · ${val}`
        })
        return `<b>${h(a.name)}</b>\n${rows.join('\n')}`
      }).filter(Boolean)
      return blocks.join('\n\n')
    }

    case 'uptime': {
      const spans: Record<string, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }
      const r = (arg || '24h').toLowerCase()
      if (!(r in spans)) return t('bot_badRange')
      const from = now - spans[r]
      const [{ agents, targets }, incs] = await Promise.all([load(), incidentsSince(from)])
      if (!targets.length) return t('bot_noData')
      const lines = agents.map(a => {
        const mine = targets.filter(x => x.agent_id === a.id && !x.is_device) // devices don't count toward location uptime
        const ids = new Set(mine.map(x => x.id))
        let down = 0, mon = 0
        for (const x of mine) { const u = targetUptime(x, incs, from, now, now); down += u.down; mon += u.monitored }
        const ai = incs.filter(i => i.agent_id === a.id && incEnd(i, now) > from && (i.kind === 'agent_offline' || (i.target_id != null && ids.has(i.target_id))))
        const downDur = unionLen(ai.filter(i => i.kind === 'target_down' || i.cause === 'internet')
          .map(i => [Math.max(from, incStart(i)), Math.min(now, incEnd(i, now))] as [number, number]).filter(v => v[1] > v[0]))
        const pct = mon ? fmtPct((1 - down / mon) * 100) : t('tgNone')
        return `<b>${h(a.name)}</b> — ${pct}\n   ${t('tgDur')} ${fmtDur(downDur, lang)} · ${ai.length} ${t('tgIncidents')}`
      })
      return `📈 <b>${t('bot_uptimeTitle', { r })}</b>\n\n${lines.join('\n\n')}`
    }

    case 'incidents': {
      const incs = must(await db().from('incidents').select('*').order('started_at', { ascending: false }).limit(5)) as Incident[]
      if (!incs.length) return t('noIncidents')
      const { agents, targets } = await load()
      const rows = incs.map(i => {
        const a = agents.find(x => x.id === i.agent_id)?.name || ''
        const who = i.kind === 'agent_offline' ? `${t('kind_agent_offline')} · ${a}` : `${targets.find(x => x.id === i.target_id)?.name || ''} · ${a}`
        const dur = i.ended_at ? fmtDur(Date.parse(i.ended_at) - incStart(i), lang) : `${t('ongoing')} ${fmtDur(now - incStart(i), lang)}`
        const cause = t((i.cause ? `cause_${i.cause}` : 'cause_pending') as DictKey)
        return `${i.ended_at ? '▫️' : '🔴'} <b>${h(who)}</b>\n   ${fmtDT(incStart(i), lang, tz)} · ${dur} · ${h(cause)}`
      })
      return `🧾 <b>${t('bot_incTitle')}</b>\n\n${rows.join('\n')}`
    }

    case 'summary':
      return buildSummary(s, now - summaryPeriodMs(s.summary), now)

    case 'test': {
      if (!arg) return t('bot_testUsage')
      const { agents, targets } = await load()
      const q = arg.toLowerCase()
      const live = targets.filter(x => agents.some(a => a.id === x.agent_id))
      const exact = live.filter(x => x.name.toLowerCase() === q)
      const matches = exact.length ? exact : live.filter(x => x.name.toLowerCase().includes(q) || x.address.toLowerCase().includes(q))
      const names = (xs: Target[]) => xs.map(x => `${x.name} (${agents.find(a => a.id === x.agent_id)?.name})`).join(', ')
      if (!matches.length) return t('bot_testNotFound', { q: h(arg), list: h(names(live)) || '–' })
      if (matches.length > 1) return t('bot_testAmbiguous', { q: h(arg), list: h(names(matches)) })
      const tg = matches[0]
      const a = agents.find(x => x.id === tg.agent_id)!
      if (a.status !== 'online') return t('bot_testAgentOff', { loc: h(a.name) })
      const spec = { agent_id: tg.agent_id, name: tg.name, method: tg.method, address: tg.address, interval_sec: tg.interval_sec, timeout_ms: tg.timeout_ms, fail_threshold: tg.fail_threshold, slow_threshold_ms: tg.slow_threshold_ms, options: tg.options, is_gateway: tg.is_gateway, paused: false }
      must(await db().from('test_requests').insert({ agent_id: a.id, spec, reply_chat: chatId }))
      return `⏳ ${t('bot_testQueued', { n: h(tg.name), loc: h(a.name) })}`
    }

    case 'mute': {
      const m = arg.toLowerCase().match(/^(\d{1,4})\s*([mhd])(?:\s+(all|semua))?$/)
      if (!m) return t('bot_muteUsage')
      const ms = Number(m[1]) * (m[2] === 'm' ? MIN : m[2] === 'h' ? HOUR : DAY)
      if (ms <= 0 || ms > 7 * DAY) return t('bot_muteUsage')
      const until = now + ms, all = !!m[3]
      await setSetting('mute', { until: new Date(until).toISOString(), all })
      return `🔕 ${all ? t('bot_mutedAll', { t: fmtDT(until, lang, tz) }) : t('bot_mutedNC', { t: fmtDT(until, lang, tz) })}`
    }

    case 'unmute':
      await setSetting('mute', { until: null, all: false })
      // alerts held by the mute go out on the next tick
      must(await db().from('notifications').update({ next_attempt_at: new Date().toISOString() }).eq('status', 'pending'))
      return `🔔 ${t('bot_unmuted')}`

    default:
      return t('bot_unknown')
  }
}

function muteLine(s: AppSettings, now: number, t: (k: DictKey, v?: Record<string, string | number>) => string, lang: AppSettings['language'], tz: string) {
  if (!s.mute.until || Date.parse(s.mute.until) <= now) return null
  return t('bot_mutedNow', { t: fmtDT(Date.parse(s.mute.until), lang, tz), all: s.mute.all ? t('bot_allSuffix') : '' })
}

/** Sends a "Test now" result back to the chat that asked via /test. */
export async function replyTestResult(chatId: string, spec: { name?: string; method?: string; address?: string }, r: { success: boolean; response_ms?: number | null; status_code?: number | null; error?: string | null; detail?: string | null }) {
  const s = await getSettings()
  const token = decrypt(s.telegram.bot_token_enc)
  if (!token) return
  const t = (k: DictKey, v?: Record<string, string | number>) => translate(s.language, k, v)
  const head = `${r.success ? '✅' : '🔴'} <b>${t('bot_testResult')}</b> · ${h(spec.name)} · ${methodLabel(spec.method || '')} <code>${h(spec.address)}</code>`
  const body = r.success
    ? `${t('testOk', { ms: fmtMs(r.response_ms) })}${r.status_code ? ` · HTTP ${r.status_code}` : ''}${r.detail ? `\n${h(r.detail)}` : ''}`
    : t('testFail', { e: h(r.error || '') })
  await sendTelegram(token, chatId, `${head}\n${body}`)
}
