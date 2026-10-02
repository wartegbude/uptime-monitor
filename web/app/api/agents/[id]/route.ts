import { db, must } from '@/lib/server/db'
import { randomToken, sha256 } from '@/lib/server/crypto'
import { body, handle, HttpError, json, requireUser } from '@/lib/server/http'
import { uuidOrNull } from '@/lib/server/range'
import { agentPatch } from '@/lib/server/schemas'

type Ctx = { params: Promise<{ id: string }> }
const COLS = 'id,name,host,token_tail,status,last_heartbeat_at,heartbeat_timeout_sec,agent_version,created_at'

async function exists(id: string) {
  if (!uuidOrNull(id)) throw new HttpError(404, 'not_found')
  const rows = must(await db().from('agents').select('id').eq('id', id).limit(1)) as unknown[]
  if (!rows.length) throw new HttpError(404, 'not_found')
}

/** Rename, change heartbeat limit, or revoke (token replaced by an unusable hash). */
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  await requireUser()
  const { id } = await ctx.params
  await exists(id)
  const input = agentPatch.parse(await body(req))
  const patch: Record<string, unknown> = {}
  if (input.name) patch.name = input.name
  if (input.heartbeat_timeout_sec) patch.heartbeat_timeout_sec = input.heartbeat_timeout_sec
  if (input.revoke) {
    patch.status = 'revoked'
    patch.token_hash = sha256('revoked:' + randomToken(40))
    must(await db().from('incidents').update({ ended_at: new Date().toISOString() }).eq('agent_id', id).is('ended_at', null))
  }
  return json(must(await db().from('agents').update(patch).eq('id', id).select(COLS).single()))
})

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  await requireUser()
  const { id } = await ctx.params
  await exists(id)
  must(await db().from('agents').delete().eq('id', id))
  return json({ ok: true })
})
