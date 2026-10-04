import 'server-only'
import { db, must } from './db'
import { sha256 } from './crypto'

const FIELDS = 'id,name,method,address,interval_sec,timeout_ms,options,paused,is_gateway'

/** The check list an agent runs, plus a hash so the agent knows when to re-fetch it. */
export async function agentConfig(agentId: string) {
  const targets = must(await db().from('targets').select(FIELDS).eq('agent_id', agentId).order('sort_order').order('created_at')) as Record<string, unknown>[]
  return { targets, hash: sha256(JSON.stringify(targets)).slice(0, 16) }
}
