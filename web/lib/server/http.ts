import 'server-only'
import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { currentUser } from './session'

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status })

/** Wraps a route handler: maps HttpError / ZodError / unknown errors to JSON responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args)
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      if (e instanceof ZodError) return json({ error: 'invalid_input', issues: e.issues.map(i => ({ path: i.path.join('.'), message: i.message })) }, 400)
      console.error(e)
      return json({ error: 'server_error' }, 500)
    }
  }
}

export async function requireUser() {
  const u = await currentUser()
  if (!u) throw new HttpError(401, 'unauthorized')
  return u
}

export function clientIp(req: Request): string {
  const f = req.headers.get('x-forwarded-for')
  return (f ? f.split(',')[0] : req.headers.get('x-real-ip') || 'unknown').trim()
}

export async function body<T = unknown>(req: Request): Promise<T> {
  try { return (await req.json()) as T } catch { throw new HttpError(400, 'invalid_json') }
}
