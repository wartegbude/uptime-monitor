import { db, must } from '@/lib/server/db'
import { randomToken, sha256 } from '@/lib/server/crypto'
import { body, handle, json, requireUser } from '@/lib/server/http'
import { agentInput } from '@/lib/server/schemas'
import { installInfo } from '@/lib/server/install'

export const dynamic = 'force-dynamic'

const COLS = 'id,name,host,token_tail,status,last_heartbeat_at,heartbeat_timeout_sec,agent_version,created_at'

export const GET = handle(async () => {
  await requireUser()
  return json(must(await db().from('agents').select(COLS).order('created_at')))
})

/** Creates a location and returns its token once (only the hash is stored). */
export const POST = handle(async (req: Request) => {
  await requireUser()
  const input = agentInput.parse(await body(req))
  const token = 'ag_' + randomToken(32)
  const row = must(await db().from('agents').insert({ name: input.name, token_hash: sha256(token), token_tail: token.slice(-4) }).select(COLS).single())
  return json({ agent: row, ...installInfo(req, token) }, 201)
})
