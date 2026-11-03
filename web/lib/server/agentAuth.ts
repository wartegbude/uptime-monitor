import 'server-only'
import { db, must } from './db'
import { sha256 } from './crypto'
import { clientIp, HttpError } from './http'
import { rateHit } from './rateLimit'
import type { Agent } from '../types'

// Per agent: normal use is ~10 requests/min; draining a large offline buffer is faster
// (agent ≥1.1 sends at most 4/s, older agents up to 10/s), so the cap stays above that.
const AGENT_LIMIT = 600
// Per IP, requests with a wrong or revoked token.
const BAD_TOKEN_LIMIT = 30
const WINDOW_SEC = 60

async function rejectToken(req: Request): Promise<never> {
  if (!(await rateHit(`badtoken:${clientIp(req)}`, BAD_TOKEN_LIMIT, WINDOW_SEC))) {
    throw new HttpError(429, 'rate_limited', WINDOW_SEC)
  }
  throw new HttpError(401, 'invalid_token')
}

/** Authenticates an agent by its bearer token (stored as sha256). Revoked agents are rejected. Rate limited. */
export async function requireAgent(req: Request): Promise<Agent> {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token.startsWith('ag_') || token.length < 20) return rejectToken(req)
  const rows = must(await db().from('agents').select('*').eq('token_hash', sha256(token)).limit(1)) as Agent[]
  const a = rows[0]
  if (!a || a.status === 'revoked') return rejectToken(req)
  if (!(await rateHit(`agent:${a.id}`, AGENT_LIMIT, WINDOW_SEC))) throw new HttpError(429, 'rate_limited', 10)
  return a
}

export async function pendingTests(agentId: string) {
  const rows = must(await db().from('test_requests').select('id,spec').eq('agent_id', agentId).eq('status', 'pending')
    .gte('created_at', new Date(Date.now() - 120_000).toISOString()).limit(5)) as { id: string; spec: unknown }[]
  if (rows.length) must(await db().from('test_requests').update({ status: 'sent' }).in('id', rows.map(r => r.id)))
  return rows
}
