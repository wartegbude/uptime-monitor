import { after } from 'next/server'
import { pendingTests, requireAgent } from '@/lib/server/agentAuth'
import { agentConfig } from '@/lib/server/agentConfig'
import { touchAgent } from '@/lib/server/engine'
import { body, handle, json } from '@/lib/server/http'
import { heartbeatInput } from '@/lib/server/schemas'
import { dispatch } from '@/lib/server/telegram'

export const dynamic = 'force-dynamic'

/** Heartbeat (PRD AG-09). Response carries pending "Test now" requests and the config hash. */
export const POST = handle(async (req: Request) => {
  const agent = await requireAgent(req)
  const input = heartbeatInput.parse(await body(req))
  const wasOffline = agent.status === 'offline'
  await touchAgent(agent, input)
  const [tests, cfg] = await Promise.all([pendingTests(agent.id), agentConfig(agent.id)])
  if (wasOffline) after(() => dispatch().catch(e => console.error('dispatch', e)))
  return json({ ok: true, tests, config_hash: cfg.hash })
})
