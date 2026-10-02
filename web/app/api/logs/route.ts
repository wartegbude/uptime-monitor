import { db, must } from '@/lib/server/db'
import { handle, json, requireUser } from '@/lib/server/http'
import { logParams } from '@/lib/server/range'

export const dynamic = 'force-dynamic'

export const GET = handle(async (req: Request) => {
  await requireUser()
  const url = new URL(req.url)
  const size = Math.min(100, Math.max(5, Number(url.searchParams.get('size')) || 15))
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const res = must(await db().rpc('get_logs', { ...logParams(url), p_limit: size, p_offset: (page - 1) * size }))
  return json(res)
})
