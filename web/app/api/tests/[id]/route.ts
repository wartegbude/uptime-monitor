import { db, must } from '@/lib/server/db'
import { handle, HttpError, json, requireUser } from '@/lib/server/http'
import { uuidOrNull } from '@/lib/server/range'

export const dynamic = 'force-dynamic'

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser()
  const { id } = await ctx.params
  if (!uuidOrNull(id)) throw new HttpError(404, 'not_found')
  const row = (must(await db().from('test_requests').select('id,status,result,created_at').eq('id', id).limit(1)) as unknown[])[0]
  if (!row) throw new HttpError(404, 'not_found')
  return json(row)
})
