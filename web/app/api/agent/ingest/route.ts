import { after } from 'next/server'
import { pendingTests, requireAgent } from '@/lib/server/agentAuth'
import { agentConfig } from '@/lib/server/agentConfig'
import { ingest, touchAgent } from '@/lib/server/engine'
import { body, handle, json } from '@/lib/server/http'
import { ingestInput } from '@/lib/server/schemas'
import { dispatch } from '@/lib/server/telegram'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * Batch of check results from an agent (live or from its offline buffer).
 * Results are stored before the heartbeat is touched, so a reconnecting agent's buffered
 * failures are visible when the offline incident's cause is decided.
 */
export const POST = handle(async (req: Request) => {
  const agent = await requireAgent(req)
  const input = ingestInput.parse(await body(req))
  const r = await ingest(agent, input.results)
  await touchAgent(agent, input)
  const [tests, cfg] = await Promise.all([pendingTests(agent.id), agentConfig(agent.id)])
  after(() => dispatch().catch(e => console.error('dispatch', e)))
  return json({ ok: true, stored: r.stored, tests, config_hash: cfg.hash })
})
