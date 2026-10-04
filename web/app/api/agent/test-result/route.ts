import { z } from 'zod'
import { requireAgent } from '@/lib/server/agentAuth'
import { db, must } from '@/lib/server/db'
import { body, handle, json } from '@/lib/server/http'
import { resultInput } from '@/lib/server/schemas'
import { replyTestResult } from '@/lib/server/bot'

const input = z.object({ id: z.string().uuid(), result: resultInput.omit({ target_id: true, checked_at: true }).extend({ checked_at: z.string().max(40).optional() }) })

export const POST = handle(async (req: Request) => {
  const agent = await requireAgent(req)
  const p = input.parse(await body(req))
  const rows = must(await db().from('test_requests').update({ status: 'done', result: p.result, done_at: new Date().toISOString() })
    .eq('id', p.id).eq('agent_id', agent.id).select('spec,reply_chat')) as { spec: { name?: string; method?: string; address?: string }; reply_chat: string | null }[]
  // started from Telegram (/test): send the result back to that chat
  if (rows[0]?.reply_chat) await replyTestResult(rows[0].reply_chat, rows[0].spec, p.result).catch(e => console.error('test reply', e))
  return json({ ok: true })
})
