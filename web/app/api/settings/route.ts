import { encrypt, decrypt, mask } from '@/lib/server/crypto'
import { body, handle, json, requireUser } from '@/lib/server/http'
import { settingsPatch } from '@/lib/server/schemas'
import { getSettings, setSetting, type AppSettings } from '@/lib/server/settings'

export const dynamic = 'force-dynamic'

function publicView(s: AppSettings) {
  const { telegram, ...rest } = s
  return { ...rest, telegram: { bot_token_masked: mask(decrypt(telegram.bot_token_enc)), chat_id: telegram.chat_id } }
}

export const GET = handle(async () => {
  await requireUser()
  return json(publicView(await getSettings()))
})

export const PATCH = handle(async (req: Request) => {
  await requireUser()
  const p = settingsPatch.parse(await body(req))
  const s = await getSettings()
  if (p.retention_days !== undefined) await setSetting('retention_days', p.retention_days)
  if (p.timezone) await setSetting('timezone', p.timezone)
  if (p.language) await setSetting('language', p.language)
  if (p.cooldown_min !== undefined) await setSetting('cooldown_min', p.cooldown_min)
  if (p.alerts) await setSetting('alerts', { ...s.alerts, ...p.alerts })
  if (p.summary) await setSetting('summary', { ...s.summary, ...p.summary })
  if (p.quiet_hours) await setSetting('quiet_hours', { ...s.quiet_hours, ...p.quiet_hours })
  if (p.telegram) {
    const tg = { ...s.telegram }
    if (p.telegram.bot_token !== undefined) tg.bot_token_enc = p.telegram.bot_token ? encrypt(p.telegram.bot_token) : null
    if (p.telegram.chat_id !== undefined) tg.chat_id = p.telegram.chat_id || null
    await setSetting('telegram', tg)
  }
  return json(publicView(await getSettings()))
})
