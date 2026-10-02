import { redirect } from 'next/navigation'
import { db } from '@/lib/server/db'
import { currentUser } from '@/lib/server/session'
import { LoginForm } from '@/components/auth'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  if (await currentUser()) redirect('/')
  const { count } = await db().from('users').select('id', { count: 'exact', head: true })
  if (!count) redirect('/setup')
  return <LoginForm mode="login" />
}
