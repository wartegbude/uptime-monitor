'use client'
import { useState } from 'react'
import { useTheme } from 'next-themes'
import { useI18n } from './providers'
import { api, Icon } from './ui'
import { useMounted } from './Shell'

export function LoginForm({ mode }: { mode: 'login' | 'setup' }) {
  const { t, lang, setLang } = useI18n()
  const { theme, setTheme } = useTheme()
  const mounted = useMounted()
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [remember, setRemember] = useState(false)
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(''); setBusy(true)
    try {
      if (mode === 'setup') {
        if (u.trim().length < 3) { setErr(t('req')); return }
        if (p.length < 8) { setErr(t('pwShort')); return }
        await api('/api/auth/setup', { method: 'POST', json: { username: u, password: p } })
      } else {
        await api('/api/auth/login', { method: 'POST', json: { username: u, password: p, remember } })
      }
      window.location.href = '/'
    } catch (x) {
      const d = (x as { data?: { error?: string; retry_after_sec?: number } }).data
      setErr(d?.error === 'locked' ? t('locked', { m: Math.ceil((d.retry_after_sec || 900) / 60) }) : d?.error === 'bad_credentials' ? t('badLogin') : (x as Error).message)
    } finally { setBusy(false) }
  }

  const nextTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
  return (
    <div className="login-wrap"><div className="login fade-in">
      <div className="brand"><span className="logo"><Icon name="wifi" /></span>{t('appName')}</div>
      <form className="card" onSubmit={submit} noValidate>
        <div>
          <h1>{mode === 'setup' ? t('setupTitle') : t('signInTitle')}</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>{mode === 'setup' ? t('setupSub') : t('signInSub')}</p>
        </div>
        {err && <div className="alert" role="alert"><Icon name="alert" /><span>{err}</span></div>}
        <div className="field"><label htmlFor="lu">{t('username')}</label>
          <input className="input" id="lu" autoComplete="username" value={u} onChange={e => setU(e.target.value)} required autoFocus /></div>
        <div className="field"><label htmlFor="lp">{t('password')}</label>
          <div className="pw">
            <input className="input" id="lp" type={show ? 'text' : 'password'} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} value={p} onChange={e => setP(e.target.value)} required />
            <button type="button" onClick={() => setShow(!show)} aria-label={show ? t('hidePw') : t('showPw')}><Icon name={show ? 'eyeoff' : 'eye'} /></button>
          </div>
          {mode === 'setup' && <span className="hint">{t('pwShort')}</span>}
        </div>
        {mode === 'login' && <label className="check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />{t('rememberMe')}</label>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? t('signingIn') : mode === 'setup' ? t('createAccount') : t('signIn')}</button>
      </form>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 4 }}>
        <button className="btn ghost sm lang-btn" onClick={() => setLang(lang === 'en' ? 'id' : 'en')}>{lang === 'en' ? 'EN → ID' : 'ID → EN'}</button>
        <button className="btn ghost sm" onClick={() => setTheme(nextTheme)}>
          <Icon name={!mounted ? 'monitor' : theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} />{t(`th_${mounted ? theme || 'system' : 'system'}` as never)}
        </button>
      </div>
    </div></div>
  )
}
