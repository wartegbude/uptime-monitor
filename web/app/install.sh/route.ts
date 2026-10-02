import { env } from '@/lib/server/env'
import { INSTALL_SCRIPT } from '@/lib/server/installScript'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const base = env.appUrl || new URL(req.url).origin
  const body = INSTALL_SCRIPT.split('__API_URL__').join(base).split('__RELEASE_BASE__').join(env.agentReleaseBase)
  return new Response(body, { headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' } })
}
