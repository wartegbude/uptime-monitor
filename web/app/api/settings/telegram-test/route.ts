import { decrypt } from '@/lib/server/crypto'
import { handle, json, requireUser } from '@/lib/server/http'
import { getSettings } from '@/lib/server/settings'
import { sendTelegram } from '@/lib/server/telegram'
import { translate } from '@/lib/i18n'

/** Sends a test message right away (not through the queue) so errors show in the UI. */
export const POST = handle(async () => {
  await requireUser()
  const s = await getSettings()
  const token = decrypt(s.telegram.bot_token_enc)
  if (!token || !s.telegram.chat_id) return json({ ok: false, error: 'Bot token and chat ID are required' }, 400)
  const r = await sendTelegram(token, s.telegram.chat_id, `✅ <b>${translate(s.language, 'tgTest')}</b> · ${translate(s.language, 'appName')}\n${translate(s.language, 'tgTestBody')}`)
  return json(r, r.ok ? 200 : 502)
})
