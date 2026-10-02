import 'server-only'
import { db, must } from './db'
import { sha256 } from './crypto'
import { HttpError } from './http'
import type { Agent } from '../types'

/** Authenticates an agent by its bearer token (stored as sha256). Revoked agents are rejected. */
export async function requireAgent(req: Request): Promise<Agent> {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token.startsWith('ag_') || token.length < 20) throw new HttpError(401, 'invalid_token')
  const rows = must(await db().from('agents').select('*').eq('token_hash', sha256(token)).limit(1)) as Agent[]
  const a = rows[0]
  if (!a || a.status === 'revoked') throw new HttpError(401, 'invalid_token')
  return a
}

export async function pendingTests(agentId: string) {
  const rows = must(await db().from('test_requests').select('id,spec').eq('agent_id', agentId).eq('status', 'pending')
    .gte('created_at', new Date(Date.now() - 120_000).toISOString()).limit(5)) as { id: string; spec: unknown }[]
  if (rows.length) must(await db().from('test_requests').update({ status: 'sent' }).in('id', rows.map(r => r.id)))
  return rows
}
