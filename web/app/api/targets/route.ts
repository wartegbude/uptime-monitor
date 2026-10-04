import { db, must } from '@/lib/server/db'
import { body, handle, HttpError, json, requireUser } from '@/lib/server/http'
import { targetInput } from '@/lib/server/schemas'

export const dynamic = 'force-dynamic'

export const GET = handle(async () => {
  await requireUser()
  return json(must(await db().from('targets').select('*').order('sort_order').order('created_at')))
})

export const POST = handle(async (req: Request) => {
  await requireUser()
  const input = targetInput.parse(await body(req))
  const agent = (must(await db().from('agents').select('id,status').eq('id', input.agent_id).limit(1)) as { id: string }[])[0]
  if (!agent) throw new HttpError(400, 'unknown_agent')
  // new targets go to the end of their location's list
  const last = (must(await db().from('targets').select('sort_order').eq('agent_id', input.agent_id).order('sort_order', { ascending: false }).limit(1)) as { sort_order: number }[])[0]
  const row = must(await db().from('targets').insert({ ...input, sort_order: (last?.sort_order ?? 0) + 1 }).select('*').single())
  return json(row, 201)
})
