import { requireAgent } from '@/lib/server/agentAuth'
import { agentConfig } from '@/lib/server/agentConfig'
import { handle, json } from '@/lib/server/http'

export const dynamic = 'force-dynamic'

/** Agent pulls its targets (PRD AG-04). Does not count as a heartbeat. */
export const GET = handle(async (req: Request) => {
  const agent = await requireAgent(req)
  const cfg = await agentConfig(agent.id)
  return json({ agent: { id: agent.id, name: agent.name }, heartbeat_sec: 30, config_hash: cfg.hash, targets: cfg.targets })
})
