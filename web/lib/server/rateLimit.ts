import 'server-only'
import { db } from './db'

let warned = false

/**
 * Counts one hit for key (fixed window, stored in Postgres via rate_hit, migration 0006).
 * Returns false once the key is over limit. Fails open: a database problem never locks agents out.
 */
export async function rateHit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const r = await db().rpc('rate_hit', { p_key: key, p_limit: limit, p_window_sec: windowSec })
  if (r.error) {
    if (!warned) {
      warned = true
      console.error(r.error.code === 'PGRST202'
        ? 'rate_hit missing: run supabase/migrations/0006_agent_rate_limit.sql'
        : `rate_hit: ${r.error.message}`)
    }
    return true
  }
  return r.data !== false
}
