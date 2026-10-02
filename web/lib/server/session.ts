import 'server-only'
import { cookies } from 'next/headers'
import { getIronSession, type SessionOptions } from 'iron-session'
import { env } from './env'

export interface SessionData {
  userId?: string
  username?: string
  exp?: number // epoch ms
}

const DAY = 86400

function options(maxAgeSec = 30 * DAY): SessionOptions {
  return {
    password: env.sessionSecret,
    cookieName: 'um_session',
    ttl: maxAgeSec,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeSec,
    },
  }
}

export async function getSession(maxAgeSec?: number) {
  return getIronSession<SessionData>(await cookies(), options(maxAgeSec))
}

/** Returns the logged-in user or null. Checks the absolute expiry stored in the session. */
export async function currentUser(): Promise<{ id: string; username: string } | null> {
  const s = await getSession()
  if (!s.userId || !s.exp || s.exp < Date.now()) return null
  return { id: s.userId, username: s.username || '' }
}

export async function startSession(user: { id: string; username: string }, remember: boolean) {
  const age = remember ? 30 * DAY : DAY
  const s = await getSession(age)
  s.userId = user.id
  s.username = user.username
  s.exp = Date.now() + age * 1000
  await s.save()
}

export async function endSession() {
  const s = await getSession()
  s.destroy()
}
