import { safeEqual } from '@/lib/server/crypto'
import { handleUpdate, webhookSecret } from '@/lib/server/bot'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/** Telegram → bot commands. Verified with the secret token set by setWebhook. Always answers 200 so Telegram does not retry. */
export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token') || ''
  if (!safeEqual(secret, webhookSecret())) return new Response('forbidden', { status: 403 })
  try {
    const update = await req.json()
    await handleUpdate(update)
  } catch (e) {
    console.error('telegram webhook', e)
  }
  return new Response('ok')
}
