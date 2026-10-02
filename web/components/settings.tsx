'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { useI18n, useNow, useToast } from './providers'
import { useMounted } from './Shell'
import { api, copyText, Icon, methodIcon, Pill, Seg, Switch, type IconName } from './ui'
import { fmtDur, fmtMs, methodLabel, ts } from '@/lib/format'
import { liveState } from '@/lib/uptime'
import type { Agent, Method, Target, TargetOptions } from '@/lib/types'
import type { DictKey, Lang } from '@/lib/i18n'

const TABS: [string, IconName][] = [['targets', 'target'], ['agents', 'server'], ['data', 'db'], ['telegram', 'send'], ['account', 'user'], ['appearance', 'palette']]

export function Settings() {
  const { t } = useI18n()
  const sp = useSearchParams()
  const router = useRouter()
  const path = usePathname()
  const tab = TABS.some(x => x[0] === sp.get('tab')) ? sp.get('tab')! : 'targets'
  return (
    <div className="set-layout">
      <nav className="set-tabs" role="tablist">
        {TABS.map(([k, i]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => router.replace(`${path}?tab=${k}`, { scroll: false })}>
            <Icon name={i} />{t(`tab_${k}` as DictKey)}
          </button>
        ))}
      </nav>
      <div className="set-panel fade-in" key={tab}>
        {tab === 'targets' && <TargetsTab />}
        {tab === 'agents' && <AgentsTab />}
        {tab === 'data' && <DataTab />}
        {tab === 'telegram' && <TelegramTab />}
        {tab === 'account' && <AccountTab />}
        {tab === 'appearance' && <AppearanceTab />}
      </div>
    </div>
  )
}

function useLoad<T>(url: string) {
  const [data, setData] = useState<T | null>(null)
  const reload = useCallback(() => api<T>(url).then(setData).catch(() => {}), [url])
  useEffect(() => { reload() }, [reload])
  return { data, setData, reload }
}

/* ---------------------------------------------------------------- targets */
function TargetsTab() {
  const { t, lang } = useI18n()
  const toast = useToast()
  const { data: targets, reload } = useLoad<Target[]>('/api/targets')
  const { data: agents } = useLoad<Agent[]>('/api/agents')
  const [form, setForm] = useState<Target | 'new' | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  if (!targets || !agents) return <div className="card skel skel-card" />
  const live = agents.filter(a => a.status !== 'revoked')

  async function patch(tg: Target, p: Partial<Target>) {
    try { await api(`/api/targets/${tg.id}`, { method: 'PATCH', json: p }); toast(t('saved')); reload() }
    catch (e) { toast(t('saveFailed', { e: (e as Error).message }), 'err') }
  }
  async function del(tg: Target) {
    try { await api(`/api/targets/${tg.id}`, { method: 'DELETE' }); toast(t('targetDeleted')); setConfirm(null); reload() }
    catch (e) { toast(t('saveFailed', { e: (e as Error).message }), 'err') }
  }

  return (
    <section className="card">
      <div className="card-h" style={{ paddingBottom: 12 }}><h2>{t('tab_targets')}</h2><span className="sub">{targets.length}</span>
        <div className="act"><button className="btn primary sm" disabled={!live.length} onClick={() => setForm('new')}><Icon name="plus" />{t('addTarget')}</button></div></div>
      {!live.length && <div className="empty"><Icon name="server" /><span>{t('emptyAgents')}</span></div>}
      <div className="list">
        {live.map(ag => {
          const mine = targets.filter(x => x.agent_id === ag.id)
          return (
            <div key={ag.id}>
              <div className="group-h"><Icon name="server" />{ag.name} {ag.host && <span className="mono" style={{ fontWeight: 400 }}>{ag.host}</span>}</div>
              {!mine.length && <div className="li muted">{t('emptyTargets')}</div>}
              {mine.map(tg => (
                <div className="li" key={tg.id}>
                  <div className="main-c">
                    <div className="t"><Icon name={methodIcon(tg)} />{tg.name} <Pill s={liveState(tg, ag)} /></div>
                    <div className="meta">
                      <span><span className="chip">{methodLabel(tg.method)}</span> <span className="mono">{tg.address}</span></span>
                      <span>{t('every', { s: fmtDur(tg.interval_sec * 1000, lang) })}</span>
                      <span>{tg.fail_threshold}× → DOWN</span><span>&gt; {tg.slow_threshold_ms} ms</span>
                      {tg.is_gateway && <span className="chip">{t('gateway')}</span>}
                    </div>
                  </div>
                  <div className="acts">
                    {confirm === tg.id ? (
                      <div className="inline-confirm"><span>{t('confirmDelete', { n: tg.name })}</span>
                        <button className="btn sm danger" onClick={() => del(tg)}>{t('yesDelete')}</button>
                        <button className="btn sm" onClick={() => setConfirm(null)}>{t('cancel')}</button></div>
                    ) : <>
                      <button className="btn sm" onClick={() => setForm(tg)}><Icon name="edit" />{t('edit')}</button>
                      <button className="btn sm" onClick={() => patch(tg, { paused: !tg.paused })}><Icon name={tg.paused ? 'play' : 'pause'} />{tg.paused ? t('resume') : t('pause')}</button>
                      <button className="btn sm icon danger" onClick={() => setConfirm(tg.id)} aria-label={t('delete')} title={t('delete')}><Icon name="trash" /></button>
                    </>}
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {form && <TargetForm initial={form === 'new' ? null : form} agents={live} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload() }} />}
    </section>
  )
}

type FormState = {
  agent_id: string; name: string; method: Method; address: string; interval_sec: number; timeout_ms: number
  fail_threshold: number; slow_threshold_ms: number; is_gateway: boolean; options: TargetOptions
}
const SLOW_DEFAULT: Record<Method, number> = { http: 1000, ping: 100, dns: 200 }
const TIMEOUT_DEFAULT: Record<Method, number> = { http: 5000, ping: 2000, dns: 2000 }

function cleanOptions(f: FormState): TargetOptions {
  if (f.method === 'http') return { http_method: f.options.http_method || 'GET', ok_codes: f.options.ok_codes || '200-399', follow_redirect: f.options.follow_redirect ?? true }
  if (f.method === 'dns') return { record_type: f.options.record_type || 'A', dns_server: f.options.dns_server || '' }
  return { ping_count: f.options.ping_count || 3 }
}

function TargetForm({ initial, agents, onClose, onSaved }: { initial: Target | null; agents: Agent[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [f, setF] = useState<FormState>(() => initial
    ? { agent_id: initial.agent_id, name: initial.name, method: initial.method, address: initial.address, interval_sec: initial.interval_sec, timeout_ms: initial.timeout_ms, fail_threshold: initial.fail_threshold, slow_threshold_ms: initial.slow_threshold_ms, is_gateway: initial.is_gateway, options: initial.options || {} }
    : { agent_id: agents[0]?.id || '', name: '', method: 'ping', address: '8.8.8.8', interval_sec: 30, timeout_ms: 2000, fail_threshold: 2, slow_threshold_ms: 100, is_gateway: false, options: {} })
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<{ state: 'run' | 'done' | 'timeout'; result?: { success: boolean; response_ms?: number | null; error?: string | null; status_code?: number | null; detail?: string | null } } | null>(null)
  const cancelled = useRef(false)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => { cancelled.current = true; document.removeEventListener('keydown', k) }
  }, [onClose])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF(x => ({ ...x, [k]: v }))
  const setOpt = (k: keyof TargetOptions, v: unknown) => setF(x => ({ ...x, options: { ...x.options, [k]: v } }))
  const payload = () => ({ ...f, options: cleanOptions(f), is_gateway: f.method === 'ping' && f.is_gateway })

  function validate() {
    const e: Record<string, string> = {}
    if (!f.name.trim()) e.name = t('req')
    if (!f.address.trim()) e.address = t('req')
    if (!(f.interval_sec >= 10 && f.interval_sec <= 3600)) e.interval_sec = t('badInterval')
    setErrs(e)
    return !Object.keys(e).length
  }
  function serverErrs(x: unknown) {
    const issues = ((x as { data?: { issues?: { path: string }[] } }).data?.issues) || []
    const e: Record<string, string> = {}
    for (const i of issues) e[i.path.split('.')[0]] = i.path === 'address' ? t('badAddr') : t('req')
    setErrs(e)
    if (!issues.length) toast(t('saveFailed', { e: (x as Error).message }), 'err')
  }

  async function save(ev: React.FormEvent) {
    ev.preventDefault()
    if (!validate()) return
    setBusy(true)
    try {
      if (initial) await api(`/api/targets/${initial.id}`, { method: 'PATCH', json: payload() })
      else await api('/api/targets', { method: 'POST', json: payload() })
      toast(initial ? t('saved') : t('targetAdded'))
      onSaved()
    } catch (x) { serverErrs(x) } finally { setBusy(false) }
  }

  async function runTest() {
    if (!validate()) return
    setTest({ state: 'run' })
    try {
      const { id } = await api<{ id: string }>('/api/tests', { method: 'POST', json: payload() })
      const start = Date.now()
      while (!cancelled.current && Date.now() - start < 75_000) {
        await new Promise(r => setTimeout(r, 2000))
        const r = await api<{ status: string; result: NonNullable<typeof test>['result'] }>(`/api/tests/${id}`)
        if (r.status === 'done') { setTest({ state: 'done', result: r.result }); return }
      }
      setTest({ state: 'timeout' })
    } catch (x) { setTest(null); serverErrs(x) }
  }

  const num = (k: 'interval_sec' | 'timeout_ms' | 'fail_threshold' | 'slow_threshold_ms', label: string, hint?: string, min?: number, max?: number) => (
    <div className="field"><label htmlFor={`f_${k}`}>{label}</label>
      <input className={`input ${errs[k] ? 'err' : ''}`} id={`f_${k}`} type="number" min={min} max={max} value={f[k]} onChange={e => set(k, Number(e.target.value))} />
      {errs[k] ? <span className="err-text">{errs[k]}</span> : hint ? <span className="hint">{hint}</span> : null}</div>
  )

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <form className="sheet" onSubmit={save} noValidate>
        <div className="sheet-h"><h2>{initial ? t('editTarget') : t('addTarget')}</h2><button type="button" className="btn ghost icon" onClick={onClose} aria-label={t('cancel')}><Icon name="x" /></button></div>
        <div className="form-grid">
          <div className="field"><label htmlFor="f_name">{t('name')}</label>
            <input className={`input ${errs.name ? 'err' : ''}`} id="f_name" value={f.name} onChange={e => set('name', e.target.value)} placeholder="Google DNS" autoFocus />
            {errs.name && <span className="err-text">{errs.name}</span>}</div>
          <div className="field"><label htmlFor="f_agent">{t('location')}</label>
            <select className="input" id="f_agent" value={f.agent_id} onChange={e => set('agent_id', e.target.value)}>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div className="field full"><label>{t('method')}</label>
            <Seg value={f.method} options={[{ v: 'http' as Method, label: 'HTTP/HTTPS' }, { v: 'ping' as Method, label: 'Ping (ICMP)' }, { v: 'dns' as Method, label: 'DNS' }]}
              onChange={m => setF(x => ({ ...x, method: m, slow_threshold_ms: SLOW_DEFAULT[m], timeout_ms: TIMEOUT_DEFAULT[m], is_gateway: m === 'ping' && x.is_gateway, address: m === 'http' ? 'https://' : m === 'dns' ? 'google.com' : '8.8.8.8' }))} /></div>
          <div className="field full"><label htmlFor="f_addr">{t('address')}</label>
            <input className={`input mono ${errs.address ? 'err' : ''}`} id="f_addr" value={f.address} onChange={e => set('address', e.target.value.trim())} placeholder={t(`addr_${f.method}` as DictKey)} />
            {errs.address && <span className="err-text">{errs.address}</span>}</div>
          {num('interval_sec', t('interval'), t('intervalHint'), 10, 3600)}
          {num('timeout_ms', t('timeout'), undefined, 100, 60000)}
          {num('fail_threshold', t('failThreshold'), undefined, 1, 20)}
          {num('slow_threshold_ms', t('slowThreshold'), undefined, 1)}
          {f.method === 'http' && <>
            <div className="field full"><span className="eyebrow">{t('httpOpts')}</span></div>
            <div className="field"><label htmlFor="f_hm">{t('httpMethod')}</label>
              <select className="input" id="f_hm" value={f.options.http_method || 'GET'} onChange={e => setOpt('http_method', e.target.value)}><option>GET</option><option>HEAD</option></select></div>
            <div className="field"><label htmlFor="f_codes">{t('okCodes')}</label>
              <input className="input mono" id="f_codes" value={f.options.ok_codes ?? '200-399'} onChange={e => setOpt('ok_codes', e.target.value)} />{errs.options && <span className="err-text">200-399, 401</span>}</div>
            <label className="check full"><input type="checkbox" checked={f.options.follow_redirect ?? true} onChange={e => setOpt('follow_redirect', e.target.checked)} />{t('followRedirect')}</label>
          </>}
          {f.method === 'dns' && <>
            <div className="field full"><span className="eyebrow">{t('dnsOpts')}</span></div>
            <div className="field"><label htmlFor="f_rt">{t('recordType')}</label>
              <select className="input" id="f_rt" value={f.options.record_type || 'A'} onChange={e => setOpt('record_type', e.target.value)}>{['A', 'AAAA', 'CNAME', 'MX', 'TXT'].map(x => <option key={x}>{x}</option>)}</select></div>
            <div className="field"><label htmlFor="f_ds">{t('dnsServer')}</label>
              <input className="input mono" id="f_ds" value={f.options.dns_server ?? ''} placeholder="8.8.8.8" onChange={e => setOpt('dns_server', e.target.value.trim())} /><span className="hint">{t('dnsServerHint')}</span></div>
          </>}
          {f.method === 'ping' && (
            <label className="check full" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={f.is_gateway} onChange={e => set('is_gateway', e.target.checked)} style={{ marginTop: 3 }} />
              <span>{t('gatewayFlag')}<br /><span className="muted" style={{ fontSize: 12 }}>{t('gatewayHint')}</span></span>
            </label>
          )}
        </div>
        {test && (
          <div className="test-res">
            {test.state === 'run' && <><Icon name="refresh" className="spin" />{t('testing')}</>}
            {test.state === 'timeout' && <><Icon name="alert" />{t('testTimeout')}</>}
            {test.state === 'done' && test.result && (test.result.success
              ? <><Pill s="up" /><span className="mono">{t('testOk', { ms: fmtMs(test.result.response_ms) })}</span>{test.result.status_code ? <span className="chip">{test.result.status_code}</span> : null}{test.result.detail && <span className="muted mono">{test.result.detail}</span>}</>
              : <><Pill s="down" />{t('testFail', { e: test.result.error || '' })}</>)}
          </div>
        )}
        <div className="sheet-f">
          <button type="button" className="btn" onClick={runTest} disabled={test?.state === 'run'}><Icon name="bolt" />{t('testNow')}</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" type="submit" disabled={busy}>{busy ? t('saving') : t('save')}</button>
        </div>
      </form>
    </div>
  )
}

/* ---------------------------------------------------------------- agents */
type Install = { token: string; install: string; docker: string }

function CodeBox({ text }: { text: string }) {
  const { t } = useI18n()
  const toast = useToast()
  return (
    <div className="codebox"><code>{text}</code>
      <button type="button" className="btn sm" onClick={async () => toast((await copyText(text)) ? t('copied') : t('copyFail'), 'ok')}><Icon name="copy" />{t('copy')}</button></div>
  )
}

function AgentsTab() {
  const { t, lang } = useI18n()
  const toast = useToast()
  const now = useNow(10000)
  const { data: agents, reload } = useLoad<Agent[]>('/api/agents')
  const [fresh, setFresh] = useState<{ name: string; info: Install } | null>(null)
  const [confirm, setConfirm] = useState<{ id: string; kind: 'revoke' | 'delete' } | null>(null)
  const [name, setName] = useState('')
  const [nameErr, setNameErr] = useState(false)

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setNameErr(true); return }
    try {
      const r = await api<{ agent: Agent } & Install>('/api/agents', { method: 'POST', json: { name } })
      setFresh({ name: r.agent.name, info: r }); setName(''); reload(); window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (x) { toast(t('saveFailed', { e: (x as Error).message }), 'err') }
  }
  async function act(a: Agent, kind: 'regen' | 'revoke' | 'delete' | 'timeout', value?: number) {
    try {
      if (kind === 'regen') { const r = await api<Install>(`/api/agents/${a.id}/token`, { method: 'POST' }); setFresh({ name: a.name, info: r }); window.scrollTo({ top: 0, behavior: 'smooth' }) }
      if (kind === 'revoke') { await api(`/api/agents/${a.id}`, { method: 'PATCH', json: { revoke: true } }); toast(t('agentRevoked')) }
      if (kind === 'delete') { await api(`/api/agents/${a.id}`, { method: 'DELETE' }); toast(t('saved')) }
      if (kind === 'timeout') { await api(`/api/agents/${a.id}`, { method: 'PATCH', json: { heartbeat_timeout_sec: value } }); toast(t('saved')) }
      setConfirm(null); reload()
    } catch (x) { toast(t('saveFailed', { e: (x as Error).message }), 'err') }
  }

  if (!agents) return <div className="card skel skel-card" />
  const statusPill = (a: Agent) => a.status === 'online' ? <span className="pill up"><Icon name="check" />{t('online')}</span>
    : a.status === 'revoked' ? <span className="pill paused"><Icon name="lock" />{t('revoked')}</span>
    : a.status === 'pending' ? <span className="pill off"><Icon name="hourglass" />{t('pending')}</span>
    : <span className="pill off"><Icon name="off" />{t('offline')}</span>

  return (
    <>
      {fresh && (
        <section className="card"><div className="card-h"><h2>{t('newTokenReady')} {fresh.name}</h2></div>
          <div className="card-b agent-new">
            <div className="banner" style={{ background: 'var(--slow-weak)', borderColor: 'transparent' }}><Icon name="key" /><span>{t('tokenOnce')}</span></div>
            <span>{t('installCmd')}</span><CodeBox text={fresh.info.install} />
            <span>{t('dockerCmd')}</span><CodeBox text={fresh.info.docker} />
            <div><button className="btn sm" onClick={() => setFresh(null)}>{t('done')}</button></div>
          </div></section>
      )}
      <section className="card">
        <div className="card-h" style={{ paddingBottom: 4 }}><h2>{t('tab_agents')}</h2><span className="sub">{t('agentsSub')}</span></div>
        <div className="list">
          {!agents.length && <div className="empty">{t('noLocations')}</div>}
          {agents.map(a => (
            <div className="li" key={a.id}>
              <div className="main-c">
                <div className="t"><Icon name="server" />{a.name} {a.host && <span className="mono muted" style={{ fontWeight: 400 }}>{a.host}</span>} {statusPill(a)}</div>
                <div className="meta">
                  <span>{t('lastHb', { t: a.last_heartbeat_at ? t('ago', { t: fmtDur(now - ts(a.last_heartbeat_at)!, lang) }) : t('never') })}</span>
                  <span>{t('token')}: <span className="mono">ag_••••••••{a.token_tail}</span></span>
                  {a.agent_version && <span className="mono">v{a.agent_version}</span>}
                </div>
              </div>
              <div className="field" style={{ width: 160 }}><label htmlFor={`hb_${a.id}`} style={{ fontSize: 12 }}>{t('hbTimeout')}</label>
                <input className="input" id={`hb_${a.id}`} type="number" min={1} max={60} defaultValue={Math.round(a.heartbeat_timeout_sec / 60)}
                  onBlur={e => { const m = Math.max(1, Math.min(60, Number(e.target.value) || 2)); if (m * 60 !== a.heartbeat_timeout_sec) act(a, 'timeout', m * 60) }} /></div>
              <div className="acts">
                {confirm?.id === a.id ? (
                  <div className="inline-confirm"><span>{confirm.kind === 'revoke' ? t('confirmRevoke') : t('confirmDeleteAgent', { n: a.name })}</span>
                    <button className="btn sm danger" onClick={() => act(a, confirm.kind)}>{confirm.kind === 'revoke' ? t('yesRevoke') : t('yesDelete')}</button>
                    <button className="btn sm" onClick={() => setConfirm(null)}>{t('cancel')}</button></div>
                ) : <>
                  <button className="btn sm" onClick={() => act(a, 'regen')}><Icon name="refresh" />{t('regenToken')}</button>
                  <button className="btn sm danger" disabled={a.status === 'revoked'} onClick={() => setConfirm({ id: a.id, kind: 'revoke' })}>{t('revoke')}</button>
                  <button className="btn sm icon danger" onClick={() => setConfirm({ id: a.id, kind: 'delete' })} aria-label={t('deleteAgent')} title={t('deleteAgent')}><Icon name="trash" /></button>
                </>}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="card"><div className="card-h"><h2>{t('addAgent')}</h2></div>
        <form className="card-b" onSubmit={add} style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }} noValidate>
          <div className="field" style={{ flex: 1, minWidth: 200 }}><label htmlFor="agn">{t('agentName')}</label>
            <input className={`input ${nameErr ? 'err' : ''}`} id="agn" value={name} onChange={e => { setName(e.target.value); setNameErr(false) }} placeholder="Rumah" /></div>
          <button className="btn primary"><Icon name="plus" />{t('addAgent')}</button>
        </form></section>
    </>
  )
}

/* ---------------------------------------------------------------- settings data */
type PublicSettings = {
  retention_days: number; timezone: string; language: Lang; cooldown_min: number
  telegram: { bot_token_masked: string | null; chat_id: string | null }
  alerts: { down: boolean; recovery: boolean; slow: boolean; agent_offline: boolean }
  summary: { enabled: boolean; frequency: string; every_hours: number; at: string; weekday: number; last_sent_at: string | null }
  quiet_hours: { enabled: boolean; from: string; to: string }
}

function useSettings() {
  const { t } = useI18n()
  const toast = useToast()
  const { data, setData } = useLoad<PublicSettings>('/api/settings')
  const save = async (patch: Record<string, unknown>, quiet = false) => {
    try { const r = await api<PublicSettings>('/api/settings', { method: 'PATCH', json: patch }); setData(r); if (!quiet) toast(t('saved')); return true }
    catch (x) { toast(t('saveFailed', { e: (x as Error).message }), 'err'); return false }
  }
  return { s: data, save }
}

function DataTab() {
  const { t } = useI18n()
  const { s, save } = useSettings()
  const [custom, setCustom] = useState<number | null>(null)
  if (!s) return <div className="card skel skel-card" />
  const opts = [7, 30, 90]
  const isCustom = custom != null || !opts.includes(s.retention_days)
  return (
    <section className="card"><div className="card-h"><h2>{t('retention')}</h2><span className="sub">{t('retentionSub')}</span></div>
      <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Seg value={isCustom ? -1 : s.retention_days} options={[...opts.map(n => ({ v: n, label: t('days', { n }) })), { v: -1, label: t('f_custom') }]}
          onChange={v => { if (v === -1) setCustom(s.retention_days); else { setCustom(null); save({ retention_days: v }) } }} />
        {isCustom && <div className="field" style={{ maxWidth: 200 }}><label htmlFor="retc">{t('customDays')}</label>
          <input className="input" type="number" id="retc" min={1} max={365} defaultValue={s.retention_days} onBlur={e => save({ retention_days: Math.max(1, Math.min(365, Number(e.target.value) || 30)) })} /></div>}
        <p className="muted" style={{ margin: 0 }}>{t('retentionNote')}</p>
      </div></section>
  )
}

const TZS = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'UTC']

function TelegramTab() {
  const { t } = useI18n()
  const toast = useToast()
  const { s, save } = useSettings()
  const [token, setToken] = useState('')
  const [chat, setChat] = useState<string | null>(null)
  const [show, setShow] = useState(false)
  const [sending, setSending] = useState(false)
  if (!s) return <div className="card skel skel-card" />

  async function saveBot() {
    const p: Record<string, string> = {}
    if (token) p.bot_token = token
    if (chat != null) p.chat_id = chat
    if (Object.keys(p).length && (await save({ telegram: p }))) { setToken(''); setChat(null) }
  }
  async function sendTest() {
    setSending(true)
    try { await api('/api/settings/telegram-test', { method: 'POST' }); toast(t('testSent')) }
    catch (x) { toast(t('testSendFail', { e: (x as { data?: { error?: string } }).data?.error || (x as Error).message }), 'err') }
    finally { setSending(false) }
  }
  const sum = s.summary, qh = s.quiet_hours
  const alertRows: [keyof PublicSettings['alerts'], DictKey, DictKey][] = [
    ['down', 'a_down', 'a_down_d'], ['recovery', 'a_recovery', 'a_recovery_d'], ['slow', 'a_slow', 'a_slow_d'], ['agent_offline', 'a_agent_offline', 'a_agent_offline_d'],
  ]

  return (
    <>
      <section className="card"><div className="card-h"><h2>{t('tgBot')}</h2></div>
        <div className="card-b form-grid">
          <div className="field"><label htmlFor="tgt">{t('botToken')}</label>
            <div className="pw"><input className="input mono" id="tgt" type={show ? 'text' : 'password'} autoComplete="off" value={token} placeholder={s.telegram.bot_token_masked || '123456789:AA…'} onChange={e => setToken(e.target.value.trim())} />
              <button type="button" onClick={() => setShow(!show)} aria-label={show ? t('hidePw') : t('showPw')}><Icon name={show ? 'eyeoff' : 'eye'} /></button></div>
            <span className="hint">{t('botTokenHint')}</span></div>
          <div className="field"><label htmlFor="tgc">{t('chatId')}</label>
            <input className="input mono" id="tgc" value={chat ?? s.telegram.chat_id ?? ''} onChange={e => setChat(e.target.value.trim())} placeholder="-1001234567890" />
            <span className="hint">{t('chatIdHint')}</span></div>
          <div className="full" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={!token && chat == null} onClick={saveBot}>{t('save')}</button>
            <button className="btn" disabled={sending || !s.telegram.bot_token_masked || !s.telegram.chat_id} onClick={sendTest}><Icon name="send" />{t('sendTest')}</button>
          </div>
        </div></section>

      <section className="card"><div className="card-h"><h2>{t('alertTypes')}</h2></div>
        <div className="card-b" style={{ paddingTop: 4 }}>
          {alertRows.map(([k, l, d]) => (
            <div className="toggle-row" key={k}><div className="tx"><b>{t(l)}</b><span>{t(d)}</span></div>
              <Switch checked={s.alerts[k]} label={t(l)} onChange={v => save({ alerts: { [k]: v } })} /></div>
          ))}
          <div className="toggle-row"><div className="tx"><b>{t('cooldown')}</b><span>{t('cooldownHint')}</span></div>
            <input className="input" type="number" min={0} max={240} defaultValue={s.cooldown_min} style={{ width: 90 }} aria-label={t('cooldown')}
              onBlur={e => save({ cooldown_min: Math.max(0, Math.min(240, Number(e.target.value) || 0)) })} /></div>
        </div></section>

      <section className="card"><div className="card-h"><h2>{t('summary')}</h2>
        <div className="act"><Switch checked={sum.enabled} label={t('summaryOn')} onChange={v => save({ summary: { enabled: v } })} /></div></div>
        <div className="card-b form-grid" style={sum.enabled ? undefined : { opacity: 0.5, pointerEvents: 'none' }}>
          <div className="field"><label htmlFor="sf">{t('frequency')}</label>
            <select className="input" id="sf" value={sum.frequency} onChange={e => save({ summary: { frequency: e.target.value } })}>
              {['1h', '6h', 'daily', 'weekly', 'custom'].map(f => <option key={f} value={f}>{t(`f_${f}` as DictKey)}</option>)}</select></div>
          {sum.frequency === 'custom' && <div className="field"><label htmlFor="sh">{t('everyHours')}</label>
            <input className="input" type="number" id="sh" min={1} max={168} defaultValue={sum.every_hours} onBlur={e => save({ summary: { every_hours: Math.max(1, Math.min(168, Number(e.target.value) || 12)) } })} /></div>}
          {(sum.frequency === 'daily' || sum.frequency === 'weekly') && <div className="field"><label htmlFor="sa">{t('sendAt')}</label>
            <input className="input" type="time" id="sa" defaultValue={sum.at} onBlur={e => e.target.value && save({ summary: { at: e.target.value } })} /></div>}
          {sum.frequency === 'weekly' && <div className="field"><label htmlFor="sd">{t('weekday')}</label>
            <select className="input" id="sd" value={sum.weekday} onChange={e => save({ summary: { weekday: Number(e.target.value) } })}>
              {[1, 2, 3, 4, 5, 6, 0].map(d => <option key={d} value={d}>{t(`wd_${d}` as DictKey)}</option>)}</select></div>}
          <div className="field"><label htmlFor="stz">{t('timezone')}</label>
            <select className="input" id="stz" value={s.timezone} onChange={e => save({ timezone: e.target.value })}>
              {(TZS.includes(s.timezone) ? TZS : [s.timezone, ...TZS]).map(z => <option key={z}>{z}</option>)}</select></div>
        </div></section>

      <section className="card"><div className="card-h"><h2>{t('quiet')}</h2><span className="sub">{t('quietD')}</span>
        <div className="act"><Switch checked={qh.enabled} label={t('quiet')} onChange={v => save({ quiet_hours: { enabled: v } })} /></div></div>
        <div className="card-b form-grid" style={qh.enabled ? undefined : { opacity: 0.5, pointerEvents: 'none' }}>
          <div className="field"><label htmlFor="qf">{t('from')}</label><input className="input" type="time" id="qf" defaultValue={qh.from} onBlur={e => e.target.value && save({ quiet_hours: { from: e.target.value } })} /></div>
          <div className="field"><label htmlFor="qt">{t('to')}</label><input className="input" type="time" id="qt" defaultValue={qh.to} onBlur={e => e.target.value && save({ quiet_hours: { to: e.target.value } })} /></div>
        </div></section>
    </>
  )
}

/* ---------------------------------------------------------------- account & appearance */
function AccountTab() {
  const { t } = useI18n()
  const toast = useToast()
  const [f, setF] = useState({ username: '', current_password: '', new_password: '', confirm: '' })
  const [errs, setErrs] = useState<Record<string, string>>({})
  useEffect(() => { api<{ username: string }>('/api/account').then(r => setF(x => ({ ...x, username: x.username || r.username }))).catch(() => {}) }, [])
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const er: Record<string, string> = {}
    if (f.username.trim().length < 3) er.username = t('req')
    if (!f.current_password) er.current_password = t('req')
    if (f.new_password && f.new_password.length < 8) er.new_password = t('pwShort')
    if (f.new_password !== f.confirm) er.confirm = t('pwMismatch')
    setErrs(er)
    if (Object.keys(er).length) return
    try {
      await api('/api/account', { method: 'POST', json: { username: f.username, current_password: f.current_password, new_password: f.new_password || undefined } })
      toast(t('acctSaved')); setF({ ...f, current_password: '', new_password: '', confirm: '' })
    } catch (x) {
      const code = (x as { data?: { error?: string } }).data?.error
      if (code === 'wrong_password') setErrs({ current_password: t('pwWrong') })
      else toast(t('saveFailed', { e: code || (x as Error).message }), 'err')
    }
  }
  const field = (k: keyof typeof f, label: string, type: string, ac: string, hint?: string) => (
    <div className="field"><label htmlFor={`ac_${k}`}>{label}</label>
      <input className={`input ${errs[k] ? 'err' : ''}`} id={`ac_${k}`} type={type} autoComplete={ac} value={f[k]} onChange={e => set(k, e.target.value)} />
      {errs[k] ? <span className="err-text">{errs[k]}</span> : hint ? <span className="hint">{hint}</span> : null}</div>
  )
  return (
    <section className="card"><div className="card-h"><h2>{t('acct')}</h2></div>
      <form className="card-b form-grid" onSubmit={submit} noValidate>
        {field('username', t('newUser'), 'text', 'username')}
        {field('current_password', t('curPw'), 'password', 'current-password')}
        {field('new_password', t('newPw'), 'password', 'new-password', t('pwRule'))}
        {field('confirm', t('newPw2'), 'password', 'new-password')}
        <div className="full"><button className="btn primary">{t('save')}</button></div>
      </form></section>
  )
}

function AppearanceTab() {
  const { t, lang, setLang } = useI18n()
  const { theme, setTheme } = useTheme()
  const mounted = useMounted()
  const cur = mounted ? theme || 'system' : 'system'
  return (
    <>
      <section className="card"><div className="card-h"><h2>{t('theme')}</h2></div><div className="card-b">
        <div className="radio-cards">{([['light', 'l'], ['dark', 'd'], ['system', 's']] as const).map(([k, c]) => (
          <button key={k} aria-pressed={cur === k} onClick={() => setTheme(k)}><span className={`sw ${c}`} />{t(`th_${k}`)}</button>
        ))}</div></div></section>
      <section className="card"><div className="card-h"><h2>{t('language')}</h2><span className="sub">{t('languageHint')}</span></div><div className="card-b">
        <Seg value={lang} options={[{ v: 'en' as Lang, label: 'English' }, { v: 'id' as Lang, label: 'Bahasa Indonesia' }]} onChange={setLang} /></div></section>
    </>
  )
}
