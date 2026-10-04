import { decrypt } from '@/lib/server/crypto'
import { env } from '@/lib/server/env'
import { handle, json, requireUser } from '@/lib/server/http'
import { getSettings, setSetting } from '@/lib/server/settings'
import { COMMANDS, telegramApi, webhookSecret } from '@/lib/server/bot'
import { translate, type DictKey } from '@/lib/i18n'

export const dynamic = 'force-dynamic'

async function tokenOrNull() {
  const s = await getSettings()
  return { s, token: decrypt(s.telegram.bot_token_enc) }
}

/** Current webhook state, so the Settings page can show Active / Not active. */
export const GET = handle(async (req: Request) => {
  await requireUser()
  const { s, token } = await tokenOrNull()
  if (!token) return json({ active: false, url: null })
  const want = `${env.appUrl || new URL(req.url).origin}/api/telegram/webhook`
  try {
    const info = (await telegramApi(token, 'getWebhookInfo')) as { url?: string; last_error_message?: string; pending_update_count?: number }
    return json({ active: info.url === want, url: info.url || null, last_error: info.last_error_message || null, mute: s.mute })
  } catch (e) {
    return json({ active: false, url: null, error: (e as Error).message, mute: s.mute })
  }
})

/** Registers the webhook (secret token, messages only) and the command menu in the bot's language. */
export const POST = handle(async (req: Request) => {
  await requireUser()
  const { s, token } = await tokenOrNull()
  if (!token || !s.telegram.chat_id) return json({ ok: false, error: 'telegram_not_configured' }, 400)
  const url = `${env.appUrl || new URL(req.url).origin}/api/telegram/webhook`
  try {
    await telegramApi(token, 'setWebhook', { url, secret_token: webhookSecret(), allowed_updates: ['message'], drop_pending_updates: true })
    await telegramApi(token, 'setMyCommands', {
      commands: COMMANDS.map(c => ({ command: c, description: translate(s.language, `cmd_${c}` as DictKey).slice(0, 256) })),
    })
    return json({ ok: true, url })
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 502)
  }
})

export const DELETE = handle(async () => {
  await requireUser()
  const { token } = await tokenOrNull()
  if (token) await telegramApi(token, 'deleteWebhook', { drop_pending_updates: true }).catch(() => {})
  return json({ ok: true })
})

/** PATCH { unmute: true } — clears /mute from the dashboard. */
export const PATCH = handle(async () => {
  await requireUser()
  await setSetting('mute', { until: null, all: false })
  return json({ ok: true })
})
