'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { useI18n } from './providers'
import { Icon } from './ui'

export function useMounted() {
  const [m, setM] = useState(false)
  useEffect(() => setM(true), [])
  return m
}

export function ThemeLangButtons() {
  const { t, lang, setLang } = useI18n()
  const { theme, resolvedTheme, setTheme } = useTheme()
  const mounted = useMounted()
  const icon = !mounted ? 'monitor' : theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'
  return (
    <>
      <button className="btn ghost icon lang-btn" onClick={() => setLang(lang === 'en' ? 'id' : 'en')} title={t('language')} aria-label={t('language')}>{lang.toUpperCase()}</button>
      <button className="btn ghost icon" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')} title={t('theme')} aria-label={t('theme')}><Icon name={icon} /></button>
    </>
  )
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
  window.location.href = '/login'
}

export function Shell({ username, children }: { username: string; children: ReactNode }) {
  const { t, lang } = useI18n()
  // keep Telegram messages in the language the user last used in the UI
  useEffect(() => {
    fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: lang }) }).catch(() => {})
  }, [lang])
  const path = usePathname()
  const sp = useSearchParams()
  const inSettings = path.startsWith('/settings')
  const tab = sp.get('tab') || 'targets'
  const title = inSettings ? t('settings') : t('dashboard')
  const cur = (on: boolean) => (on ? { 'aria-current': 'page' as const } : {})

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="logo"><Icon name="wifi" /></span>{t('appName')}</div>
        <Link className="nav-btn" href="/" {...cur(!inSettings)}><Icon name="dash" /><span>{t('dashboard')}</span></Link>
        <Link className="nav-btn" href="/settings" {...cur(inSettings)}><Icon name="settings" /><span>{t('settings')}</span></Link>
        <div className="side-foot">
          <div className="muted" style={{ fontSize: 12 }}>{username}</div>
          <button className="nav-btn" onClick={logout}><Icon name="logout" /><span>{t('logout')}</span></button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar"><div className="topbar-in">
          <div className="brand"><span className="logo"><Icon name="wifi" /></span></div>
          <h1 className="desk-title" style={{ fontSize: 18 }}>{title}</h1>
          <div className="top-actions">
            <ThemeLangButtons />
            <button className="btn ghost icon" onClick={logout} title={t('logout')} aria-label={t('logout')}><Icon name="logout" /></button>
          </div>
        </div></header>
        <main className="content fade-in">{children}</main>
      </div>
      <nav className="bottomnav">
        <Link href="/" {...cur(!inSettings)}><Icon name="dash" /><span>{t('dashboard')}</span></Link>
        <Link href="/settings?tab=targets" {...cur(inSettings && tab === 'targets')}><Icon name="target" /><span>{t('targets')}</span></Link>
        <Link href="/settings?tab=agents" {...cur(inSettings && tab !== 'targets')}><Icon name="settings" /><span>{t('settings')}</span></Link>
      </nav>
    </div>
  )
}
