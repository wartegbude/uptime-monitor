import { handle, json } from '@/lib/server/http'
import { endSession } from '@/lib/server/session'

export const POST = handle(async () => {
  await endSession()
  return json({ ok: true })
})
