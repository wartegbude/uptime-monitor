import bcrypt from 'bcryptjs'
import { db, must } from '@/lib/server/db'
import { body, handle, HttpError, json } from '@/lib/server/http'
import { setupInput } from '@/lib/server/schemas'
import { startSession } from '@/lib/server/session'

/** Creates the single admin account. Locked once any user exists (PRD LG-01). */
export const POST = handle(async (req: Request) => {
  const input = setupInput.parse(await body(req))
  const { count } = await db().from('users').select('id', { count: 'exact', head: true })
  if ((count || 0) > 0) throw new HttpError(403, 'setup_locked')
  const hash = await bcrypt.hash(input.password, 12)
  const rows = must(await db().from('users').insert({ username: input.username, password_hash: hash }).select('id,username')) as { id: string; username: string }[]
  await startSession(rows[0], false)
  return json({ ok: true })
})
