'use client'
import Link from 'next/link'
import { useState } from 'react'
import { useI18n } from './providers'
import { Icon, Pill } from './ui'
import { ResponseChart } from './chart'
import { IncidentList, LiveIndicator, LogTable, RangePicker, rangeQuery, usePolling, UptimeBars, type RangeState } from './dashboard'
import { fmtDur, fmtMs, fmtPct, methodLabel } from '@/lib/format'
import { incEnd, incStart, liveState, targetUptime } from '@/lib/uptime'
import type { DashboardData } from '@/lib/types'

type Stats = { total: number; ok: number; min: number | null; avg: number | null; max: number | null; p95: number | null }

/** Target detail page (PRD DB-08): stats, chart with slow threshold, uptime bar, incidents, log. */
export function TargetDetail({ id }: { id: string }) {
  const { t, lang } = useI18n()
  const [r, setR] = useState<RangeState>({ range: '24h' })
  const q = rangeQuery(r)
  const { data, err, updated } = usePolling<DashboardData>(`/api/dashboard?target=${id}&${q}`)
  const { data: stats } = usePolling<Stats>(`/api/targets/${id}/stats?${q}`)
  const tg = data?.targets[0]

  if (data && !tg) return <div className="card empty"><Icon name="alert" /><span>404</span><Link className="btn" href="/">{t('back')}</Link></div>

  const agent = data?.agents.find(a => a.id === tg?.agent_id)
  const incs = data && tg ? data.incidents.filter(i => (i.kind === 'target_down' && i.target_id === tg.id) || (i.kind === 'agent_offline' && i.agent_id === tg.agent_id))
    .filter(i => incEnd(i, data.now) > data.from && incStart(i) < data.to) : []
  const up = data && tg ? targetUptime(tg, data.incidents, data.from, data.to, data.now).up : null
  const stat = (label: string, v: React.ReactNode, cls = '') => <div className={`card stat ${cls}`}><span className="eyebrow">{label}</span><div className="v">{v}</div></div>

  return (
    <>
      <Link className="back" href="/"><Icon name="left" />{t('back')}</Link>
      {tg && agent && (
        <div className="dhead">
          <h1 style={{ fontSize: 24 }}>{tg.name}</h1><Pill s={liveState(tg, agent)} />
          <span className="chip">{methodLabel(tg.method)}</span><span className="mono muted">{tg.address}</span>
          <span className="muted">· {agent.name} · {t('every', { s: fmtDur(tg.interval_sec * 1000, lang) })}</span>
        </div>
      )}
      <div className="filters"><RangePicker value={r} onChange={setR} allowCustom={false} /><LiveIndicator updated={updated} err={err} /></div>
      <section className="dstats">
        {stat(t('uptime'), fmtPct(up == null ? null : up * 100), 'up')}
        {stat(t('incidents'), incs.length, incs.length ? 'down' : '')}
        {stat(t('min'), fmtMs(stats?.min))}
        {stat(t('avg'), fmtMs(stats?.avg))}
        {stat(t('max'), fmtMs(stats?.max))}
        {stat(t('p95'), fmtMs(stats?.p95))}
      </section>
      {data && tg && <>
        <section className="card"><div className="card-h"><h2>{t('responseTime')}</h2><span className="sub">{t('slowThreshold')}: {tg.slow_threshold_ms} ms</span></div>
          <div className="card-b"><ResponseChart targets={[tg]} allTargets={[tg]} agents={data.agents} series={data.series} incidents={incs} from={data.from} to={data.to} step={data.step} now={data.now} showLoc={false} slowLine={tg.slow_threshold_ms} height={300} /></div></section>
        <section className="card"><div className="card-h"><h2>{t('uptimeBars')}</h2></div>
          <div className="card-b"><UptimeBars targets={[tg]} agents={data.agents} incidents={data.incidents} from={data.from} to={data.to} now={data.now} showLoc={false} /></div></section>
        <section className="card"><div className="card-h" style={{ paddingBottom: 6 }}><h2>{t('incidents')}</h2></div>
          <IncidentList incidents={incs} targets={[tg]} agents={data.agents} now={data.now} compact /></section>
        <LogTable query={q} targets={[tg]} agents={data.agents} showLoc={false} fixedTarget={tg.id} />
      </>}
    </>
  )
}
