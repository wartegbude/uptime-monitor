import 'server-only'
import { db, must } from './db'
import type { Lang } from '../i18n'

export interface AppSettings {
  retention_days: number
  timezone: string
  language: Lang
  telegram: { bot_token_enc: string | null; chat_id: string | null }
  alerts: { down: boolean; recovery: boolean; slow: boolean; agent_offline: boolean }
  summary: { enabled: boolean; frequency: '1h' | '6h' | 'daily' | 'weekly' | 'custom'; every_hours: number; at: string; weekday: number; last_sent_at: string | null }
  quiet_hours: { enabled: boolean; from: string; to: string }
  cooldown_min: number
}

const DEFAULTS: AppSettings = {
  retention_days: 30,
  timezone: 'Asia/Jakarta',
  language: 'en',
  telegram: { bot_token_enc: null, chat_id: null },
  alerts: { down: true, recovery: true, slow: true, agent_offline: true },
  summary: { enabled: true, frequency: 'daily', every_hours: 12, at: '08:00', weekday: 1, last_sent_at: null },
  quiet_hours: { enabled: false, from: '22:00', to: '06:00' },
  cooldown_min: 5,
}

export async function getSettings(): Promise<AppSettings> {
  const rows = must(await db().from('settings').select('key,value')) as { key: string; value: unknown }[]
  const s: Record<string, unknown> = { ...DEFAULTS }
  for (const r of rows) {
    if (!(r.key in DEFAULTS)) continue
    const d = (DEFAULTS as unknown as Record<string, unknown>)[r.key]
    s[r.key] = d && typeof d === 'object' ? { ...(d as object), ...(r.value as object) } : r.value
  }
  return s as unknown as AppSettings
}

export async function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
  must(await db().from('settings').upsert({ key, value }))
}
