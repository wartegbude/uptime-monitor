import { db, must } from '@/lib/server/db'
import { handle, HttpError, json, requireUser } from '@/lib/server/http'
import { parseRange, uuidOrNull } from '@/lib/server/range'

export const dynamic = 'force-dynamic'

/** Min / avg / max / p95 for the target detail page (PRD DB-08). */
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser()
  const { id } = await ctx.params
  if (!uuidOrNull(id)) throw new HttpError(404, 'not_found')
  const { from, to } = parseRange(new URL(req.url))
  return json(must(await db().rpc('target_stats', { p_target: id, p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() })))
})
