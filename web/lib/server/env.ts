import 'server-only'

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing environment variable ${name}`)
  return v
}

export const env = {
  get supabaseUrl() { return need('SUPABASE_URL') },
  get supabaseKey() { return need('SUPABASE_SERVICE_ROLE_KEY') },
  get sessionSecret() {
    const s = need('SESSION_SECRET')
    if (s.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters')
    return s
  },
  get encryptionKey() { return need('ENCRYPTION_KEY') },
  get cronSecret() { return need('CRON_SECRET') },
  get appUrl() { return (process.env.APP_URL || '').replace(/\/$/, '') },
  get agentReleaseBase() {
    return (process.env.AGENT_RELEASE_BASE || 'https://github.com/YOUR_GITHUB_USER/uptime-monitor/releases/latest/download').replace(/\/$/, '')
  },
}
