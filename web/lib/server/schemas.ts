import 'server-only'
import { z } from 'zod'

const hostRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
const ipv4Re = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const ipv6Re = /^[0-9a-f:]+$/i

export const targetOptions = z.object({
  http_method: z.enum(['GET', 'HEAD']).optional(),
  ok_codes: z.string().regex(/^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/).optional(),
  follow_redirect: z.boolean().optional(),
  record_type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT']).optional(),
  dns_server: z.string().max(100).refine(v => v === '' || ipv4Re.test(v) || ipv6Re.test(v) || hostRe.test(v.replace(/:\d+$/, '')), 'invalid_dns_server').optional(),
  ping_count: z.number().int().min(1).max(10).optional(),
}).strict()

export const targetInput = z.object({
  agent_id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  method: z.enum(['http', 'ping', 'dns']),
  address: z.string().trim().min(1).max(500),
  interval_sec: z.number().int().min(10).max(3600),
  timeout_ms: z.number().int().min(100).max(60000),
  fail_threshold: z.number().int().min(1).max(20),
  slow_threshold_ms: z.number().int().min(1).max(600000),
  options: targetOptions.default({}),
  is_gateway: z.boolean().default(false),
  is_device: z.boolean().default(false),
  paused: z.boolean().default(false),
}).superRefine((v, ctx) => {
  const ok = v.method === 'http'
    ? (() => { try { const u = new URL(v.address); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false } })()
    : ipv4Re.test(v.address) || (v.address.includes(':') && ipv6Re.test(v.address)) || hostRe.test(v.address)
  if (!ok) ctx.addIssue({ code: 'custom', path: ['address'], message: 'invalid_address' })
  if (v.is_gateway && v.method !== 'ping') ctx.addIssue({ code: 'custom', path: ['is_gateway'], message: 'gateway_must_be_ping' })
  if (v.is_gateway && v.is_device) ctx.addIssue({ code: 'custom', path: ['is_device'], message: 'gateway_or_device' })
})
export type TargetInput = z.infer<typeof targetInput>

export const agentInput = z.object({ name: z.string().trim().min(1).max(60) })
export const agentPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  heartbeat_timeout_sec: z.number().int().min(30).max(3600).optional(),
  revoke: z.literal(true).optional(),
})

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const settingsPatch = z.object({
  retention_days: z.number().int().min(1).max(365).optional(),
  timezone: z.string().min(1).max(60).refine(tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true } catch { return false } }).optional(),
  language: z.enum(['en', 'id']).optional(),
  telegram: z.object({ bot_token: z.string().trim().max(200).optional(), chat_id: z.string().trim().max(40).regex(/^-?\d+$|^@\w+$|^$/).optional() }).optional(),
  alerts: z.object({ down: z.boolean(), recovery: z.boolean(), slow: z.boolean(), agent_offline: z.boolean(), device: z.boolean() }).partial().optional(),
  summary: z.object({
    enabled: z.boolean(), frequency: z.enum(['1h', '6h', 'daily', 'weekly', 'custom']), every_hours: z.number().int().min(1).max(168),
    at: hhmm, weekday: z.number().int().min(0).max(6),
  }).partial().optional(),
  quiet_hours: z.object({ enabled: z.boolean(), from: hhmm, to: hhmm }).partial().optional(),
  cooldown_min: z.number().int().min(0).max(240).optional(),
})

export const loginInput = z.object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(200), remember: z.boolean().optional() })
export const setupInput = z.object({ username: z.string().trim().min(3).max(60), password: z.string().min(8).max(200) })
export const accountInput = z.object({
  username: z.string().trim().min(3).max(60),
  current_password: z.string().min(1).max(200),
  new_password: z.string().max(200).optional().refine(v => !v || v.length >= 8, 'too_short'),
})

export const resultInput = z.object({
  target_id: z.string().uuid(),
  checked_at: z.string().max(40),
  success: z.boolean(),
  response_ms: z.number().nonnegative().max(1e7).nullable().optional(),
  status_code: z.number().int().nullable().optional(),
  packet_loss: z.number().min(0).max(100).nullable().optional(),
  error: z.string().max(1000).nullable().optional(),
  error_kind: z.string().max(20).nullable().optional(),
  detail: z.string().max(1000).nullable().optional(),
  delayed: z.boolean().optional(),
})
export const ingestInput = z.object({
  results: z.array(resultInput).max(2000).default([]),
  offline_events: z.array(z.object({ start: z.string().max(40), end: z.string().max(40) })).max(100).optional(),
  host: z.string().max(100).optional(),
  version: z.string().max(40).optional(),
})
export const heartbeatInput = ingestInput.pick({ offline_events: true, host: true, version: true })
