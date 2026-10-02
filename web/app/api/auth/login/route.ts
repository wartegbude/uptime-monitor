import bcrypt from 'bcryptjs'
import { db, must } from '@/lib/server/db'
import { body, clientIp, handle, json } from '@/lib/server/http'
import { loginInput } from '@/lib/server/schemas'
import { startSession } from '@/lib/server/session'

const MAX_FAILS = 5
const LOCK_MS = 15 * 60_000
let dummyHash: string | null = null

export const POST = handle(async (req: Request) => {
  const input = loginInput.parse(await body(req))
  const ip = clientIp(req)
  const att = (must(await db().from('login_attempts').select('*').eq('ip', ip).limit(1)) as { fails: number; locked_until: string | null }[])[0]
  if (att?.locked_until && Date.parse(att.locked_until) > Date.now()) {
    return json({ error: 'locked', retry_after_sec: Math.ceil((Date.parse(att.locked_until) - Date.now()) / 1000) }, 429)
  }

  const user = (must(await db().from('users').select('id,username,password_hash').eq('username', input.username).limit(1)) as { id: string; username: string; password_hash: string }[])[0]
  // compare against a dummy hash when the user does not exist so timing does not leak usernames
  const ok = await bcrypt.compare(input.password, user?.password_hash || (dummyHash ??= bcrypt.hashSync('not-a-user', 10)))
  if (!user || !ok) {
    const fails = (att && (!att.locked_until || Date.parse(att.locked_until) <= Date.now()) ? att.fails : 0) + 1
    const locked = fails >= MAX_FAILS
    must(await db().from('login_attempts').upsert({
      ip, fails: locked ? 0 : fails, locked_until: locked ? new Date(Date.now() + LOCK_MS).toISOString() : null, updated_at: new Date().toISOString(),
    }))
    if (locked) return json({ error: 'locked', retry_after_sec: LOCK_MS / 1000 }, 429)
    return json({ error: 'bad_credentials' }, 401)
  }

  must(await db().from('login_attempts').delete().eq('ip', ip))
  await startSession({ id: user.id, username: user.username }, !!input.remember)
  return json({ ok: true })
})
