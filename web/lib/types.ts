export type Method = 'http' | 'ping' | 'dns'
export type AgentStatus = 'pending' | 'online' | 'offline' | 'revoked'
export type TargetState = 'unknown' | 'up' | 'slow' | 'down'

export interface Agent {
  id: string
  name: string
  host: string | null
  token_tail: string
  status: AgentStatus
  last_heartbeat_at: string | null
  heartbeat_timeout_sec: number
  agent_version: string | null
  created_at: string
}

export interface TargetOptions {
  http_method?: 'GET' | 'HEAD'
  ok_codes?: string
  follow_redirect?: boolean
  record_type?: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT'
  dns_server?: string
  ping_count?: number
}

export interface Target {
  id: string
  agent_id: string
  name: string
  method: Method
  address: string
  interval_sec: number
  timeout_ms: number
  fail_threshold: number
  slow_threshold_ms: number
  options: TargetOptions
  is_gateway: boolean
  /** external device: monitored only, never affects location status or uptime */
  is_device: boolean
  /** manual order within a location (Settings → Targets) */
  sort_order: number
  paused: boolean
  created_at: string
  state: TargetState
  consec_fail: number
  first_fail_at: string | null
  consec_slow: number
  state_since: string | null
  last_checked_at: string | null
  last_response_ms: number | null
  last_error: string | null
  last_down_alert_at: string | null
  slow_alerted: boolean
}

export type IncidentCause = 'timeout' | 'dns' | 'status' | 'loss' | 'conn' | 'tls' | 'other' | 'isp' | 'lan' | 'internet' | 'server' | null

export interface Incident {
  id: string
  kind: 'target_down' | 'agent_offline'
  target_id: string | null
  agent_id: string
  started_at: string
  ended_at: string | null
  cause: IncidentCause
  detail: string | null
  notified: boolean
}

/** One bucket of the response-time series. t = bucket start (epoch ms). */
export interface SeriesPoint { target_id: string; t: number; total: number; ok: number; avg: number | null; max: number | null }

export interface LogRow {
  id: number
  checked_at: string
  success: boolean
  response_ms: number | null
  status_code: number | null
  packet_loss: number | null
  error: string | null
  delayed: boolean
  target_id: string
  target_name: string
  method: Method
  address: string
  agent_name: string
  status: 'up' | 'slow' | 'down'
}

export interface DashboardData {
  now: number
  from: number
  to: number
  step: number
  agents: Agent[]
  targets: Target[]
  incidents: Incident[]
  series: SeriesPoint[]
}
