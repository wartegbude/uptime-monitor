import { safeEqual } from '@/lib/server/crypto'
import { env } from '@/lib/server/env'
import { handle, HttpError, json } from '@/lib/server/http'
import { tick } from '@/lib/server/tick'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Alert scheduler, called every minute by Supabase pg_cron (or any external cron).
 * Detects offline agents, queues the periodic summary and sends pending Telegram messages.
 */
async function run(req: Request) {
  const auth = req.headers.get('authorization') || ''
  if (!safeEqual(auth, `Bearer ${env.cronSecret}`)) throw new HttpError(401, 'unauthorized')
  return json(await tick())
}

export const POST = handle(run)
export const GET = handle(run) // Vercel Cron uses GET with the same Bearer CRON_SECRET header
