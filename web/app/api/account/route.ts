import bcrypt from 'bcryptjs'
import { db, must } from '@/lib/server/db'
import { body, handle, json, requireUser } from '@/lib/server/http'
import { accountInput } from '@/lib/server/schemas'
import { startSession } from '@/lib/server/session'

export const GET = handle(async () => {
  const me = await requireUser()
  return json({ username: me.username })
})

/** Change username and/or password. The current password is always required (PRD ST-12). */
export const POST = handle(async (req: Request) => {
  const me = await requireUser()
  const input = accountInput.parse(await body(req))
  const user = (must(await db().from('users').select('id,password_hash').eq('id', me.id).limit(1)) as { id: string; password_hash: string }[])[0]
  if (!user || !(await bcrypt.compare(input.current_password, user.password_hash))) return json({ error: 'wrong_password' }, 400)
  const patch: Record<string, unknown> = { username: input.username }
  if (input.new_password) patch.password_hash = await bcrypt.hash(input.new_password, 12)
  const { error } = await db().from('users').update(patch).eq('id', me.id)
  if (error) return json({ error: error.code === '23505' ? 'username_taken' : 'server_error' }, 400)
  await startSession({ id: me.id, username: input.username }, false)
  return json({ ok: true })
})
