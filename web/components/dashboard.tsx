'use client'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n, useNow } from './providers'
import { api, Icon, LocPill, methodIcon, Pill, Seg } from './ui'
import { colorVar, ResponseChart, Sparkline } from './chart'
import { fmtDT, fmtDTs, fmtDur, fmtMs, fmtPct, fmtTime, HOUR, DAY, methodLabel, ts } from '@/lib/format'
import { incEnd, incStart, liveState, locationState, targetUptime, unionLen, uptimeBlocks } from '@/lib/uptime'
import type { Agent, DashboardData, Incident, LogRow, SeriesPoint, Target } from '@/lib/types'
import type { DictKey } from '@/lib/i18n'

export type Range = '1h' | '24h' | '7d' | '30d' | 'custom'
export interface RangeState { range: Range; from?: number; to?: number }

export function rangeQuery(r: RangeState) {
  return r.range === 'custom' && r.from && r.to ? `from=${r.from}&to=${r.to}` : `range=${r.range === 'custom' ? '24h' : r.range}`
}

const LS_KEY = 'um_dash'
function loadPrefs(): { loc: string; r: RangeState } {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY) || ''); if (v && v.r) return v } catch { /* empty */ }
  return { loc: 'all', r: { range: '24h' } }
}

/** Polls an API URL every 30 s (PRD DB-09) and exposes the last update time. */
export function usePolling<T>(url: string | null, ms = 30_000) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState(false)
  const [updated, setUpdated] = useState(0)
  const urlRef = useRef(url)
  urlRef.current = url
  const load = useCallback(async () => {
    const u = urlRef.current
    if (!u) return
    try { const d = await api<T>(u); if (urlRef.current === u) { setData(d); setErr(false); setUpdated(Date.now()) } }
    catch { setErr(true) }
  }, [])
  useEffect(() => {
    load()
    const i = setInterval(() => { if (document.visibilityState === 'visible') load() }, ms)
    const v = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', v)
    return () => { clearInterval(i); document.removeEventListener('visibilitychange', v) }
  }, [url, ms, load])
  return { data, err, updated, reload: load }
}

export function LiveIndicator({ updated, err }: { updated: number; err: boolean }) {
  const { t, lang } = useI18n()
  const now = useNow(5000)
  if (err) return <span className="live" style={{ color: 'var(--down)' }}><Icon name="alert" />{t('loadFailed')}</span>
  const d = now - updated
  return <span className="live"><i /><span>{updated ? t('updated', { t: d < 5000 ? t('justNow') : t('ago', { t: fmtDur(d, lang) }) }) : t('loading')}</span></span>
}

export function RangePicker({ value, onChange, allowCustom = true }: { value: RangeState; onChange: (r: RangeState) => void; allowCustom?: boolean }) {
  const { t } = useI18n()
  const ranges: Range[] = allowCustom ? ['1h', '24h', '7d', '30d', 'custom'] : ['1h', '24h', '7d', '30d']
  const toLocal = (ms: number) => new Date(ms + 7 * HOUR).toISOString().slice(0, 16)
  const [cf, setCf] = useState(() => toLocal(value.from || Date.now() - 3 * DAY))
  const [ct, setCt] = useState(() => toLocal(value.to || Date.now()))
  return (
    <>
      <Seg value={value.range} label="Range" options={ranges.map(r => ({ v: r, label: t(`range_${r}` as DictKey) }))}
        onChange={r => onChange(r === 'custom' ? { range: 'custom', from: Date.parse(cf + ':00+07:00'), to: Date.parse(ct + ':00+07:00') } : { range: r })} />
      {value.range === 'custom' && (
        <div className="custom-range" style={{ width: '100%' }}>
          <div className="field"><label htmlFor="cf">{t('from')} (WIB)</label><input className="input" type="datetime-local" id="cf" value={cf} onChange={e => setCf(e.target.value)} /></div>
          <div className="field"><label htmlFor="ct">{t('to')} (WIB)</label><input className="input" type="datetime-local" id="ct" value={ct} onChange={e => setCt(e.target.value)} /></div>
          <button className="btn" onClick={() => { const f = Date.parse(cf + ':00+07:00'), to = Date.parse(ct + ':00+07:00'); if (f && to && to > f) onChange({ range: 'custom', from: f, to }) }}>{t('apply')}</button>
        </div>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- dashboard */
export function Dashboard() {
  const { t, lang } = useI18n()
  const [prefs, setPrefs] = useState<{ loc: string; r: RangeState } | null>(null)
  useEffect(() => setPrefs(loadPrefs()), [])
  useEffect(() => { if (prefs) try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)) } catch { /* empty */ } }, [prefs])

  const q = prefs ? `${rangeQuery(prefs.r)}${prefs.loc !== 'all' ? `&loc=${prefs.loc}` : ''}` : null
  const { data, err, updated } = usePolling<DashboardData>(q ? `/api/dashboard?${q}` : null)

  if (!prefs) return null
  const showLoc = prefs.loc === 'all'
  const agentsSel = data ? data.agents.filter(a => prefs.loc === 'all' || a.id === prefs.loc) : []

  return (
    <>
      <div className="filters">
        <select className="input" aria-label={t('location')} value={prefs.loc} onChange={e => setPrefs({ ...prefs, loc: e.target.value })}>
          <option value="all">{t('allLocations')}</option>
          {data?.agents.filter(a => a.status !== 'revoked').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <LiveIndicator updated={updated} err={err} />
        <RangePicker value={prefs.r} onChange={r => setPrefs({ ...prefs, r })} />
      </div>

      {!data ? <Skeleton /> : data.agents.length === 0 ? (
        <div className="card empty"><Icon name="server" /><span>{t('emptyAgents')}</span><Link className="btn primary" href="/settings?tab=agents">{t('goSettings')}</Link></div>
      ) : (
        <>
          {agentsSel.filter(a => a.status === 'offline' && a.last_heartbeat_at).map(a => (
            <div className="banner" role="status" key={a.id}><Icon name="off" /><div>
              <b>{t('agentOfflineBanner', { loc: a.name, t: fmtDT(ts(a.last_heartbeat_at)!, lang), d: t('ago', { t: fmtDur(data.now - ts(a.last_heartbeat_at)!, lang) }) })}</b><br />
              <span className="muted">{t('agentOfflineBanner2')}</span></div></div>
          ))}
          <Summary data={data} agents={agentsSel} />
          <LocStrip data={data} agents={agentsSel} />
          <section>
            <div className="card-h" style={{ padding: '0 0 10px' }}><h2>{t('targets')}</h2><span className="sub">{t('targetsSub')}</span></div>
            <TargetCards data={data} showLoc={showLoc} />
          </section>
          {data.targets.length > 0 && <>
            <section className="card">
              <div className="card-h"><h2>{t('responseTime')}</h2><span className="sub">{t('responseSub')}</span></div>
              <div className="card-b">
                <ResponseChart targets={data.targets.filter(x => !x.paused)} allTargets={data.targets} agents={data.agents} series={data.series} incidents={data.incidents}
                  from={data.from} to={data.to} step={data.step} now={data.now} showLoc={showLoc} />
              </div>
            </section>
            <section className="card">
              <div className="card-h"><h2>{t('uptimeBars')}</h2><span className="sub">{fmtDT(data.from, lang)} – {fmtDT(data.to, lang)}</span></div>
              <div className="card-b"><UptimeBars targets={data.targets} agents={data.agents} incidents={data.incidents} from={data.from} to={data.to} now={data.now} showLoc={showLoc} /></div>
            </section>
          </>}
          <div className="two-col">
            <LogTable query={q!} targets={data.targets} agents={data.agents} showLoc={showLoc} />
            <section className="card" style={{ alignSelf: 'start' }}>
              <div className="card-h" style={{ paddingBottom: 6 }}><h2>{t('incidents')}</h2><span className="sub">{t('inRange')}</span>
                <div className="act"><a className="btn sm" href={`/api/export?type=incidents&${q}`}><Icon name="dl" />CSV</a></div></div>
              <IncidentList incidents={data.incidents} targets={data.targets} agents={data.agents} now={data.now} />
            </section>
          </div>
        </>
      )}
    </>
  )
}

function Skeleton() {
  return (
    <>
      <div className="summary">{[0, 1, 2, 3].map(i => <div key={i} className="card stat"><span className="skel" style={{ height: 12, width: '50%' }} /><span className="skel" style={{ height: 28, width: '70%' }} /></div>)}</div>
      <div className="targets">{[0, 1, 2].map(i => <div key={i} className="card skel skel-card" />)}</div>
    </>
  )
}

function weightedAvg(series: SeriesPoint[]) {
  let sum = 0, n = 0
  for (const s of series) if (s.avg != null && s.ok > 0) { sum += Number(s.avg) * s.ok; n += s.ok }
  return n ? sum / n : null
}

function Summary({ data, agents }: { data: DashboardData; agents: Agent[] }) {
  const { t, lang } = useI18n()
  const { from, to, now } = data
  let down = 0, mon = 0, maxMon = 0
  for (const tg of data.targets) { const r = targetUptime(tg, data.incidents, from, to, now); down += r.down; mon += r.monitored; maxMon = Math.max(maxMon, r.monitored) }
  const ivs = data.incidents.filter(i => i.kind === 'target_down' || i.cause === 'internet')
    .map(i => [Math.max(from, incStart(i)), Math.min(to, incEnd(i, now))] as [number, number]).filter(x => x[1] > x[0])
  const downDur = unionLen(ivs)
  const span = maxMon
  const upPct = mon ? (1 - down / mon) * 100 : null
  const avg = weightedAvg(data.series)
  const states = agents.filter(a => a.status !== 'revoked').map(a => locationState(a, data.targets))
  const order = ['down', 'off', 'degraded', 'pending', 'ok']
  const worst = states.slice().sort((x, y) => order.indexOf(x) - order.indexOf(y))[0]
  const online = agents.filter(a => a.status === 'online').length
  const n = data.incidents.length

  return (
    <section className="summary" aria-label="Summary">
      <div className="card stat"><span className="eyebrow">{t('curStatus')}</span>
        <div className="v" style={{ fontSize: 20, paddingTop: 4 }}>{worst ? <LocPill s={worst} /> : '–'}</div>
        <div className="d">{agents.length === 1 ? `${agents[0].name}${agents[0].host ? ' · ' + agents[0].host : ''}` : t('ofLocationsOnline', { a: online, b: states.length })}</div></div>
      <div className="card stat up"><span className="eyebrow">{t('totalUptime')}</span>
        <div className="v">{upPct == null ? '–' : upPct >= 99.995 ? '100' : upPct.toFixed(2)}<small>%</small></div>
        <div className="d">{fmtDur(upPct == null ? 0 : (span * upPct) / 100, lang)} {t('monitored', { d: fmtDur(span, lang) })}</div></div>
      <div className="card stat down"><span className="eyebrow">{t('totalDowntime')}</span>
        <div className="v">{fmtDur(downDur, lang)}</div>
        <div className="d">{n === 1 ? t('incident1') : t('incidentsN', { n })} {t('inRange')}</div></div>
      <div className="card stat"><span className="eyebrow">{t('avgResponse')}</span>
        <div className="v">{avg == null ? '–' : Math.round(avg)}<small>ms</small></div>
        <div className="d">{data.targets.length} {t('targets').toLowerCase()}</div></div>
    </section>
  )
}

function LocStrip({ data, agents }: { data: DashboardData; agents: Agent[] }) {
  const { t, lang } = useI18n()
  const now = useNow(10000)
  return (
    <section className="loc-strip">
      {agents.filter(a => a.status !== 'revoked').map(a => {
        const st = locationState(a, data.targets)
        const mine = data.targets.filter(x => x.agent_id === a.id && !x.paused)
        const gw = mine.find(x => x.is_gateway)
        const ext = mine.filter(x => !x.is_gateway)
        let lan: 'ok' | 'bad' | 'unk' = 'unk', isp: 'ok' | 'bad' | 'unk' = 'unk'
        if (st !== 'off' && st !== 'pending') {
          lan = gw ? (gw.state === 'down' ? 'bad' : gw.state === 'unknown' ? 'unk' : 'ok') : 'unk'
          isp = lan === 'bad' ? 'unk' : ext.length && ext.every(x => x.state === 'down') ? 'bad' : ext.length ? 'ok' : 'unk'
        }
        const D = ({ k, ok, bad, label }: { k: string; ok: DictKey; bad: DictKey; label: string }) =>
          <span className={k}><Icon name={k === 'ok' ? 'check' : k === 'bad' ? 'x' : 'off'} />{k === 'ok' ? t(ok) : k === 'bad' ? t(bad) : `${label} ?`}</span>
        return (
          <div className="card loc" key={a.id}>
            <Icon name={a.status === 'online' ? 'server' : 'off'} />
            <div><div className="nm">{a.name} {a.host && <span className="muted mono" style={{ fontWeight: 400 }}>{a.host}</span>}</div>
              <div className="muted" style={{ fontSize: 12 }}>{t('lastHb', { t: a.last_heartbeat_at ? t('ago', { t: fmtDur(now - ts(a.last_heartbeat_at)!, lang) }) : t('never') })}</div></div>
            <div className="diag"><LocPill s={st} /><D k={lan} ok="lanOk" bad="lanBad" label="LAN" /><D k={isp} ok="ispOk" bad="ispBad" label="ISP" /></div>
          </div>
        )
      })}
    </section>
  )
}

function sparkPoints(series: SeriesPoint[], tid: string, from: number, to: number, n = 40) {
  const w = (to - from) / n
  const b = Array.from({ length: n }, () => ({ sum: 0, ok: 0, total: 0 }))
  for (const s of series) {
    if (s.target_id !== tid) continue
    const k = Math.min(n - 1, Math.max(0, Math.floor((s.t - from) / w)))
    b[k].total += s.total; b[k].ok += s.ok; if (s.avg != null) b[k].sum += Number(s.avg) * s.ok
  }
  return b.map(x => ({ v: x.ok ? x.sum / x.ok : null, down: x.total > 0 && x.ok < x.total / 2 }))
}

function TargetCards({ data, showLoc }: { data: DashboardData; showLoc: boolean }) {
  const { t, lang } = useI18n()
  const now = useNow(10000)
  if (!data.targets.length) return <div className="card empty"><Icon name="target" /><span>{t('emptyTargets')}</span><Link className="btn primary" href="/settings?tab=targets">{t('goSettings')}</Link></div>
  return (
    <div className="targets">
      {data.targets.map((tg, i) => {
        const ag = data.agents.find(a => a.id === tg.agent_id)
        const st = liveState(tg, ag)
        const up = targetUptime(tg, data.incidents, data.from, data.to, data.now).up
        const last = ts(tg.last_checked_at)
        return (
          <Link key={tg.id} href={`/targets/${tg.id}`} className={`card tcard st-${st}`} style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="row1"><Icon name={methodIcon(tg)} /><span className="tn">{tg.name}</span><Pill s={st} /></div>
            <div className="addr"><span className="chip">{methodLabel(tg.method)}</span><span className="mono">{tg.address}</span>
              {tg.is_gateway && <span className="chip">{t('gateway')}</span>}{showLoc && ag && <span>· {ag.name}</span>}</div>
            <div className="row3">
              <div className="kv"><b>{fmtPct(up == null ? null : up * 100)}</b><span>{t('uptime')}</span></div>
              <div className="kv"><b>{fmtMs(tg.last_response_ms)}</b><span>{t('last')}</span></div>
              <Sparkline points={sparkPoints(data.series, tg.id, data.from, data.to)} color={`var(${colorVar(i)})`} />
            </div>
            <div className="foot"><span>{t('lastCheck', { t: last ? t('ago', { t: fmtDur(now - last, lang) }) : t('never') })}</span><span>{t('every', { s: fmtDur(tg.interval_sec * 1000, lang) })}</span></div>
          </Link>
        )
      })}
    </div>
  )
}

export function UptimeBars({ targets, agents, incidents, from, to, now, showLoc }: { targets: Target[]; agents: Agent[]; incidents: Incident[]; from: number; to: number; now: number; showLoc: boolean }) {
  const { t, lang } = useI18n()
  const [n, setN] = useState(60)
  useEffect(() => { const f = () => setN(window.innerWidth < 600 ? 30 : 60); f(); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  return (
    <div className="ubars">
      {targets.map(tg => {
        const blocks = uptimeBlocks(tg, incidents, from, to, now, n)
        const up = targetUptime(tg, incidents, from, to, now).up
        return (
          <div className="ubar-row" key={tg.id}>
            <div className="nm">{tg.name} {showLoc && <span className="muted" style={{ fontWeight: 400 }}>· {agents.find(a => a.id === tg.agent_id)?.name}</span>}</div>
            <div className="ubar">{blocks.map((b, i) => (
              <i key={i} className={b.cls} title={`${fmtDT(b.s, lang)} – ${fmtTime(b.e, lang)} · ${b.cls === 'n' ? t('st_nodata') : b.down > 0 ? `${t('st_down')} ${fmtDur(b.down, lang)}` : `${t('st_up')} 100%`}`} />
            ))}</div>
            <div className="pct">{fmtPct(up == null ? null : up * 100)}</div>
          </div>
        )
      })}
      <div className="ubar-axis"><div /><div><span>{fmtDT(from, lang)}</span><span>{fmtDT(to, lang)}</span></div><div /></div>
      <div className="legend-s">
        <span><i style={{ background: 'var(--up)' }} />{t('st_up')}</span>
        <span><i style={{ background: 'var(--down)' }} />{t('st_down')}</span>
        <span><i style={{ background: 'linear-gradient(var(--up) 0 55%,var(--down) 55%)' }} />{t('st_down')} &lt; 50%</span>
        <span><i style={{ background: 'var(--off-weak)', outline: '1px solid var(--line)' }} />{t('st_nodata')}</span>
      </div>
    </div>
  )
}

export function IncidentList({ incidents, targets, agents, now, compact }: { incidents: Incident[]; targets: Target[]; agents: Agent[]; now: number; compact?: boolean }) {
  const { t, lang } = useI18n()
  if (!incidents.length) return <div className="empty"><Icon name="check" /><span>{t('noIncidents')}</span></div>
  // group simultaneous target incidents at one location (same start minute + cause) into one row
  const rows: { key: string; start: number; end: number | null; who: string; cause: string }[] = []
  const seen = new Map<string, number>()
  for (const i of incidents) {
    const ag = agents.find(a => a.id === i.agent_id)
    const start = incStart(i)
    const k = `${i.kind}:${i.agent_id}:${Math.floor(start / 60000)}:${i.cause}`
    const cause = t((i.cause ? `cause_${i.cause}` : 'cause_pending') as DictKey) + (i.detail && !['isp', 'lan', 'internet', 'server'].includes(i.cause || '') ? ` — ${i.detail}` : '')
    if (i.kind === 'target_down' && seen.has(k)) {
      const r = rows[seen.get(k)!]; const n = (Number(r.who.match(/\d+/)?.[0]) || 1) + 1
      r.who = `${ag?.name || ''} · ${t('affected', { n })}`; continue
    }
    const tn = targets.find(x => x.id === i.target_id)?.name || ''
    const who = i.kind === 'agent_offline' ? `${t('kind_agent_offline')} · ${ag?.name || ''}` : compact ? tn : `${tn} · ${ag?.name || ''}`
    seen.set(k, rows.length)
    rows.push({ key: i.id, start, end: i.ended_at ? Date.parse(i.ended_at) : null, who, cause })
  }
  return (
    <div className="tbl-wrap"><table className="tbl cards inc"><tbody>
      {rows.map(r => (
        <tr key={r.key}>
          <td data-k="time" className="num">{fmtDT(r.start, lang)}</td>
          <td data-k="target">{r.who}</td>
          <td data-k="err" style={{ color: 'var(--fg)' }}>{r.cause}</td>
          <td data-k="dur" className="num">{r.end ? fmtDur(r.end - r.start, lang) : <span className="pill down"><Icon name="x" />{t('ongoing')} · {fmtDur(now - r.start, lang)}</span>}</td>
        </tr>
      ))}
    </tbody></table></div>
  )
}

export function LogTable({ query, targets, agents, showLoc, fixedTarget }: { query: string; targets: Target[]; agents: Agent[]; showLoc: boolean; fixedTarget?: string }) {
  const { t, lang } = useI18n()
  const [f, setF] = useState({ target: fixedTarget || 'all', status: 'all', q: '', sort: 'time', dir: 'desc', page: 1 })
  const [qDeb, setQDeb] = useState('')
  useEffect(() => { const h = setTimeout(() => setQDeb(f.q), 300); return () => clearTimeout(h) }, [f.q])
  useEffect(() => setF(x => ({ ...x, page: 1 })), [query])
  const params = `${query}${f.target !== 'all' ? `&target=${f.target}` : ''}&status=${f.status}&q=${encodeURIComponent(qDeb)}&sort=${f.sort}&dir=${f.dir}`
  const { data } = usePolling<{ total: number; rows: LogRow[] }>(`/api/logs?${params}&page=${f.page}&size=15`)
  const pages = Math.max(1, Math.ceil((data?.total || 0) / 15))
  const th = (k: string, label: string) => (
    <th><button onClick={() => setF({ ...f, sort: k, dir: f.sort === k && f.dir === 'desc' ? 'asc' : 'desc', page: 1 })} aria-sort={f.sort === k ? (f.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {label}{f.sort === k ? (f.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>
  )
  return (
    <section className="card">
      <div className="card-h" style={{ paddingBottom: 12 }}><h2>{t('checkLog')}</h2>
        <div className="act"><a className="btn sm" href={`/api/export?type=logs&${params}`}><Icon name="dl" />{t('exportCsv')}</a></div></div>
      <div className="tools">
        {!fixedTarget && <select className="input" aria-label={t('col_target')} value={f.target} onChange={e => setF({ ...f, target: e.target.value, page: 1 })}>
          <option value="all">{t('allTargets')}</option>
          {targets.map(x => <option key={x.id} value={x.id}>{x.name}{showLoc ? ' · ' + (agents.find(a => a.id === x.agent_id)?.name || '') : ''}</option>)}
        </select>}
        <select className="input" aria-label={t('col_status')} value={f.status} onChange={e => setF({ ...f, status: e.target.value, page: 1 })}>
          <option value="all">{t('allStatus')}</option>
          {(['up', 'slow', 'down'] as const).map(s => <option key={s} value={s}>{t(`st_${s}`)}</option>)}
        </select>
        <input className="input search" placeholder={t('searchErr')} value={f.q} onChange={e => setF({ ...f, q: e.target.value, page: 1 })} />
      </div>
      <div className="tbl-wrap"><table className="tbl cards">
        <thead><tr>{th('time', t('col_time'))}{th('target', t('col_target'))}<th>{t('col_method')}</th>{th('status', t('col_status'))}{th('ms', t('col_ms'))}<th>{t('col_err')}</th></tr></thead>
        <tbody>
          {data?.rows.map(r => (
            <tr key={r.id}>
              <td data-k="time" className="num">{fmtDTs(Date.parse(r.checked_at), lang)}</td>
              <td data-k="target">{r.target_name}{showLoc && <span className="muted" style={{ fontWeight: 400 }}> · {r.agent_name}</span>}</td>
              <td data-k="method"><span className="chip">{methodLabel(r.method)}</span></td>
              <td data-k="status"><Pill s={r.status} />{r.delayed && <> <span className="chip">{t('buffered')}</span></>}</td>
              <td data-k="ms" className="mono num">{fmtMs(r.response_ms)}</td>
              <td data-k="err" className="err">{r.error || ''}</td>
            </tr>
          ))}
          {data && !data.rows.length && <tr><td colSpan={6}><div className="empty">{t('noRows')}</div></td></tr>}
        </tbody>
      </table></div>
      <div className="pager"><span>{t('rows', { n: (data?.total || 0).toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB') })} · {t('page', { a: f.page, b: pages })}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}><Icon name="left" />{t('prev')}</button>
          <button className="btn sm" disabled={f.page >= pages} onClick={() => setF({ ...f, page: f.page + 1 })}>{t('next')}</button>
        </div></div>
    </section>
  )
}

