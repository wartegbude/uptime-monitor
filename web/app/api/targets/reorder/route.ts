import { z } from 'zod'
import { db, must } from '@/lib/server/db'
import { body, handle, HttpError, json, requireUser } from '@/lib/server/http'

const input = z.object({ agent_id: z.string().uuid(), ids: z.array(z.string().uuid()).min(1).max(500) })

/** Saves the manual order of one location's targets. `ids` must be exactly that location's targets. */
export const POST = handle(async (req: Request) => {
  await requireUser()
  const { agent_id, ids } = input.parse(await body(req))
  const current = (must(await db().from('targets').select('id').eq('agent_id', agent_id)) as { id: string }[]).map(x => x.id)
  const same = ids.length === current.length && new Set(ids).size === ids.length && ids.every(id => current.includes(id))
  if (!same) throw new HttpError(409, 'targets_changed') // list is stale (target added/deleted elsewhere)
  must(await db().rpc('reorder_targets', { p_ids: ids }))
  return json({ ok: true })
})
