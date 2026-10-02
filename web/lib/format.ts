import type { Lang } from './i18n'

export const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR
export const DEFAULT_TZ = 'Asia/Jakarta'

const locale = (lang: Lang) => (lang === 'id' ? 'id-ID' : 'en-GB')

export function fmtTime(ts: number, lang: Lang, opt?: Intl.DateTimeFormatOptions, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat(locale(lang), { timeZone: tz, hour12: false, ...(opt || { hour: '2-digit', minute: '2-digit' }) }).format(ts)
}
export const fmtDT = (ts: number, lang: Lang, tz = DEFAULT_TZ) =>
  fmtTime(ts, lang, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }, tz)
export const fmtDTs = (ts: number, lang: Lang, tz = DEFAULT_TZ) =>
  fmtTime(ts, lang, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }, tz)

export function fmtDur(ms: number, lang: Lang): string {
  const u = lang === 'id' ? { s: ' dtk', m: ' mnt', h: ' jam', d: ' hr' } : { s: 's', m: 'm', h: 'h', d: 'd' }
  ms = Math.max(0, ms)
  const s = Math.round(ms / 1000)
  if (s < 60) return s + u.s
  const m = Math.floor(s / 60)
  if (m < 60) return m + u.m
  const h = Math.floor(m / 60), mm = m % 60
  if (h < 24) return h + u.h + (mm ? ' ' + mm + u.m : '')
  const d = Math.floor(h / 24), hh = h % 24
  return d + u.d + (hh ? ' ' + hh + u.h : '')
}

export const fmtMs = (v: number | null | undefined) =>
  v == null || Number.isNaN(v) ? '–' : (v < 10 ? v.toFixed(1) : Math.round(v).toString()) + ' ms'

export const fmtPct = (v: number | null | undefined) =>
  v == null || Number.isNaN(v) ? '–' : (v >= 99.995 ? '100' : v.toFixed(2)) + '%'

export const ts = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null)

export const methodLabel = (m: string) => (m === 'http' ? 'HTTP' : m === 'ping' ? 'ICMP' : 'DNS')
