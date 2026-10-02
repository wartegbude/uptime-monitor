import { db, must } from '@/lib/server/db'
import { body, handle, HttpError, json, requireUser } from '@/lib/server/http'
import { targetInput } from '@/lib/server/schemas'

/** "Test now": queues a one-off check that the target's agent runs on its next heartbeat (PRD ST-04). */
export const POST = handle(async (req: Request) => {
  await requireUser()
  const spec = targetInput.parse(await body(req))
  const agent = (must(await db().from('agents').select('id,status').eq('id', spec.agent_id).limit(1)) as { id: string; status: string }[])[0]
  if (!agent) throw new HttpError(400, 'unknown_agent')
  const row = must(await db().from('test_requests').insert({ agent_id: agent.id, spec }).select('id').single()) as { id: string }
  return json({ id: row.id, agent_status: agent.status }, 201)
})
