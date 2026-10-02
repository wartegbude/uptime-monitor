import { db, must } from '@/lib/server/db'
import { body, handle, HttpError, json, requireUser } from '@/lib/server/http'
import { targetInput } from '@/lib/server/schemas'

export const dynamic = 'force-dynamic'

export const GET = handle(async () => {
  await requireUser()
  return json(must(await db().from('targets').select('*').order('created_at')))
})

export const POST = handle(async (req: Request) => {
  await requireUser()
  const input = targetInput.parse(await body(req))
  const agent = (must(await db().from('agents').select('id,status').eq('id', input.agent_id).limit(1)) as { id: string }[])[0]
  if (!agent) throw new HttpError(400, 'unknown_agent')
  const row = must(await db().from('targets').insert(input).select('*').single())
  return json(row, 201)
})
