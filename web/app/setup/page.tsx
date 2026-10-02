import { redirect } from 'next/navigation'
import { db } from '@/lib/server/db'
import { LoginForm } from '@/components/auth'

export const dynamic = 'force-dynamic'

/** First-run wizard. Locked (redirects to /login) once the admin account exists. */
export default async function SetupPage() {
  const { count } = await db().from('users').select('id', { count: 'exact', head: true })
  if (count) redirect('/login')
  return <LoginForm mode="setup" />
}
