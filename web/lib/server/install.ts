import 'server-only'
import { env } from './env'

/** One-time install commands shown after creating an agent or a new token. */
export function installInfo(req: Request, token: string) {
  const base = env.appUrl || new URL(req.url).origin
  const image = process.env.AGENT_IMAGE || 'ghcr.io/YOUR_GITHUB_USER/uptime-agent:latest'
  return {
    token,
    install: `curl -fsSL ${base}/install.sh | sudo bash -s -- --token ${token}`,
    docker: `docker run -d --name uptime-agent --restart unless-stopped --network host --cap-add NET_RAW -v uptime-agent:/var/lib/uptime-agent -e UPTIME_API_URL=${base} -e UPTIME_TOKEN=${token} ${image}`,
  }
}
