import { db, must } from '@/lib/server/db'
import { randomToken, sha256 } from '@/lib/server/crypto'
import { handle, HttpError, json, requireUser } from '@/lib/server/http'
import { installInfo } from '@/lib/server/install'
import { uuidOrNull } from '@/lib/server/range'

/** Issues a new token (the old one stops working immediately). */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser()
  const { id } = await ctx.params
  if (!uuidOrNull(id)) throw new HttpError(404, 'not_found')
  const cur = (must(await db().from('agents').select('id,status').eq('id', id).limit(1)) as { status: string }[])[0]
  if (!cur) throw new HttpError(404, 'not_found')
  const token = 'ag_' + randomToken(32)
  must(await db().from('agents').update({
    token_hash: sha256(token), token_tail: token.slice(-4),
    ...(cur.status === 'revoked' ? { status: 'pending' } : {}),
  }).eq('id', id))
  return json(installInfo(req, token))
})
