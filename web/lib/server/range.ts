import 'server-only'
import { HttpError } from './http'
import { DAY, HOUR, MIN } from '../format'

/** Parses ?range=1h|24h|7d|30d or ?from&to (epoch ms) into a bounded window and a chart step. */
export function parseRange(url: URL, retentionDays = 365) {
  const now = Date.now()
  const r = url.searchParams.get('range') || '24h'
  let from: number, to = now
  const spans: Record<string, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }
  if (r in spans) from = now - spans[r]
  else {
    from = Number(url.searchParams.get('from'))
    to = Math.min(Number(url.searchParams.get('to')) || now, now)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new HttpError(400, 'invalid_range')
  }
  from = Math.max(from, now - Math.max(retentionDays, 31) * DAY)
  if (to - from < 5 * MIN) from = to - 5 * MIN
  return { from, to, now, step: stepFor(to - from) }
}

/** Chart bucket size: ~60–300 points per target. ≥1h uses hourly rollups in SQL. */
export function stepFor(span: number) {
  if (span <= 2 * HOUR) return MIN
  if (span <= 2 * DAY) return 10 * MIN
  if (span <= 8 * DAY) return HOUR
  return 4 * HOUR
}

export const uuidOrNull = (v: string | null) =>
  v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null

/** Query params → get_logs RPC arguments (shared by /api/logs and /api/export). */
export function logParams(url: URL) {
  const { from, to } = parseRange(url)
  const sort = ['time', 'target', 'status', 'ms'].includes(url.searchParams.get('sort') || '') ? url.searchParams.get('sort')! : 'time'
  const status = ['up', 'slow', 'down'].includes(url.searchParams.get('status') || '') ? url.searchParams.get('status')! : 'all'
  return {
    p_agent: uuidOrNull(url.searchParams.get('loc')),
    p_target: uuidOrNull(url.searchParams.get('target')),
    p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(),
    p_status: status, p_q: (url.searchParams.get('q') || '').slice(0, 100),
    p_sort: sort, p_desc: url.searchParams.get('dir') !== 'asc',
  }
}
