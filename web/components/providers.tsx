'use client'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ThemeProvider } from 'next-themes'
import { translate, type DictKey, type Lang } from '@/lib/i18n'

type I18n = { lang: Lang; setLang: (l: Lang) => void; t: (k: DictKey, v?: Record<string, string | number>) => string }
const I18nCtx = createContext<I18n | null>(null)

type Toast = { id: number; msg: string; kind: 'ok' | 'err' }
const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'err') => void>(() => {})

export function Providers({ lang: initial, children }: { lang: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial)
  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    document.cookie = `um_lang=${l}; path=/; max-age=31536000; samesite=lax`
    document.documentElement.lang = l
  }, [])
  const t = useCallback((k: DictKey, v?: Record<string, string | number>) => translate(lang, k, v), [lang])

  const [toasts, setToasts] = useState<Toast[]>([])
  const nid = useRef(0)
  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = ++nid.current
    setToasts(x => [...x, { id, msg, kind }])
    setTimeout(() => setToasts(x => x.filter(y => y.id !== id)), 3500)
  }, [])

  return (
    <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
      <I18nCtx.Provider value={{ lang, setLang, t }}>
        <ToastCtx.Provider value={toast}>
          {children}
          <div className="toasts" aria-live="polite">
            {toasts.map(x => <div key={x.id} className="toast" role={x.kind === 'err' ? 'alert' : undefined}>{x.msg}</div>)}
          </div>
        </ToastCtx.Provider>
      </I18nCtx.Provider>
    </ThemeProvider>
  )
}

export function useI18n() {
  const c = useContext(I18nCtx)
  if (!c) throw new Error('useI18n outside Providers')
  return c
}
export const useToast = () => useContext(ToastCtx)

/** Re-renders every `ms` so relative times ("12s ago") stay fresh. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(i) }, [ms])
  return now
}
