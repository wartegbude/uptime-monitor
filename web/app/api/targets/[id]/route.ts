import { db, must } from '@/lib/server/db'
import { body, handle, HttpError, json, requireUser } from '@/lib/server/http'
import { uuidOrNull } from '@/lib/server/range'
import { targetInput } from '@/lib/server/schemas'
import type { Target } from '@/lib/types'

type Ctx = { params: Promise<{ id: string }> }

async function load(id: string) {
  if (!uuidOrNull(id)) throw new HttpError(404, 'not_found')
  const t = (must(await db().from('targets').select('*').eq('id', id).limit(1)) as Target[])[0]
  if (!t) throw new HttpError(404, 'not_found')
  return t
}

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  await requireUser()
  const { id } = await ctx.params
  const cur = await load(id)
  const raw = await body<Record<string, unknown>>(req)
  const merged = targetInput.parse({ ...cur, ...raw })
  const patch: Record<string, unknown> = { ...merged }
  // a changed check definition starts a fresh state machine
  if (merged.method !== cur.method || merged.address !== cur.address || merged.agent_id !== cur.agent_id) {
    Object.assign(patch, { state: 'unknown', consec_fail: 0, first_fail_at: null, consec_slow: 0, slow_alerted: false })
    must(await db().from('incidents').update({ ended_at: new Date().toISOString() }).eq('target_id', id).is('ended_at', null))
  }
  if (merged.paused && !cur.paused) {
    must(await db().from('incidents').update({ ended_at: new Date().toISOString() }).eq('target_id', id).is('ended_at', null))
    Object.assign(patch, { state: 'unknown', consec_fail: 0, first_fail_at: null, consec_slow: 0, slow_alerted: false })
  }
  return json(must(await db().from('targets').update(patch).eq('id', id).select('*').single()))
})

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser()
  const { id } = await ctx.params
  await load(id)
  must(await db().from('targets').delete().eq('id', id))
  return json({ ok: true })
})
