'use client'
import { useEffect, useRef } from 'react'
import { useTheme } from 'next-themes'
import type { ECharts, EChartsOption } from 'echarts'
import { useI18n } from './providers'
import { DAY, fmtDT, fmtMs, fmtTime } from '@/lib/format'
import { incEnd, incStart } from '@/lib/uptime'
import type { Agent, Incident, SeriesPoint, Target } from '@/lib/types'

export const colorVar = (i: number) => `--c${(i % 6) + 1}`
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()

interface Props {
  targets: Target[]
  allTargets: Target[]   // for stable colors
  agents: Agent[]
  series: SeriesPoint[]
  incidents: Incident[]
  from: number; to: number; step: number; now: number
  showLoc: boolean
  slowLine?: number
  height?: number
}

/** Response-time line chart: tooltip, legend toggle, drag/slider zoom, red incident areas, red down markers (PRD DB-04). */
export function ResponseChart(props: Props) {
  const latest = useRef(props)
  latest.current = props
  const p = props
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<ECharts | null>(null)
  const { lang, t } = useI18n()
  const { resolvedTheme } = useTheme()

  // create / dispose
  useEffect(() => {
    let disposed = false
    let ro: ResizeObserver | null = null
    import('echarts').then(ec => {
      if (disposed || !el.current) return
      chart.current = ec.init(el.current)
      ro = new ResizeObserver(() => chart.current?.resize())
      ro.observe(el.current)
      render(true)
    })
    return () => { disposed = true; ro?.disconnect(); chart.current?.dispose(); chart.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // theme / language change → full re-render; data change → keep zoom
  useEffect(() => { render(true) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [resolvedTheme, lang])
  useEffect(() => { render(false) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [p.series, p.targets, p.incidents, p.from, p.to])

  function render(full: boolean) {
    const c = chart.current
    if (!c) return
    const p = latest.current
    const fg = css('--fg'), muted = css('--muted'), line = css('--line'), surf = css('--surface'), down = css('--down'), off = css('--off')
    const agentName = (id: string) => p.agents.find(a => a.id === id)?.name || ''
    const grid: number[] = []
    for (let x = Math.floor(p.from / p.step) * p.step; x < p.to; x += p.step) grid.push(x)

    const lines = p.targets.map(tg => {
      const idx = p.allTargets.findIndex(x => x.id === tg.id)
      const color = css(colorVar(idx < 0 ? 0 : idx))
      const pts = new Map(p.series.filter(s => s.target_id === tg.id).map(s => [Math.floor(s.t / p.step) * p.step, s]))
      return {
        name: tg.name + (p.showLoc ? ' · ' + agentName(tg.agent_id) : ''),
        type: 'line' as const, showSymbol: grid.length <= 90, symbolSize: 4, connectNulls: false,
        lineStyle: { width: 1.6, color }, itemStyle: { color }, emphasis: { focus: 'series' as const },
        areaStyle: p.slowLine ? { color, opacity: 0.08 } : undefined,
        data: grid.map(x => { const s = pts.get(x); return [x, s && s.ok > 0 && s.avg != null ? Number(s.avg) : null, s ? (s.ok === 0 ? 'down' : '') : 'nodata'] }),
      }
    })
    const downPts: [number, number][] = []
    for (const s of p.series) if (p.targets.some(tg => tg.id === s.target_id) && s.total > 0 && s.ok < s.total / 2) downPts.push([s.t, 0])
    const tids = new Set(p.targets.map(x => x.id)), aids = new Set(p.targets.map(x => x.agent_id))
    const areas = p.incidents
      .filter(i => (i.kind === 'target_down' && i.target_id && tids.has(i.target_id)) || (i.kind === 'agent_offline' && aids.has(i.agent_id)))
      .map(i => [{ xAxis: Math.max(p.from, incStart(i)), itemStyle: { color: i.kind === 'agent_offline' && i.cause !== 'internet' ? off : down, opacity: 0.13 } }, { xAxis: Math.min(p.to, incEnd(i, p.now)) }])

    const series: EChartsOption['series'] = [
      ...lines.map((l, k) => (k === 0 ? { ...l, markArea: { silent: true, data: areas as never } } : l)),
      { name: t('st_down'), type: 'scatter', symbol: 'triangle', symbolSize: 8, itemStyle: { color: down }, data: downPts, z: 5, tooltip: { show: false } },
      ...(p.slowLine ? [{ name: t('slowThreshold'), type: 'line' as const, data: [], markLine: { silent: true, symbol: 'none', lineStyle: { color: css('--slow'), type: 'dashed' as const }, label: { color: css('--slow'), formatter: `${p.slowLine} ms`, position: 'insideEndTop' as const }, data: [{ yAxis: p.slowLine }] } }] : []),
    ]

    if (!full) { c.setOption({ series }, { replaceMerge: ['series'] }); return }
    const span = p.to - p.from
    c.setOption({
      textStyle: { fontFamily: 'IBM Plex Sans, system-ui, sans-serif', color: muted },
      grid: { left: 8, right: 16, top: 58, bottom: 64, containLabel: true },
      tooltip: {
        trigger: 'axis', backgroundColor: surf, borderColor: line, textStyle: { color: fg, fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: muted, type: 'dashed' } },
        formatter: (ps: unknown) => {
          const arr = (ps as { value: [number, number | null, string]; marker: string; seriesName: string; seriesType: string }[]).filter(x => x.seriesType === 'line')
          if (!arr.length) return ''
          let h = `<div style="font-weight:600;margin-bottom:4px">${fmtDT(arr[0].value[0], lang)}</div>`
          for (const x of arr) {
            const v = x.value[1], st = x.value[2]
            h += `<div style="display:flex;gap:10px;justify-content:space-between"><span>${x.marker}${x.seriesName.replace(/</g, '&lt;')}</span><b style="font-family:JetBrains Mono,monospace">${v == null ? (st === 'down' ? t('st_down') : t('st_nodata')) : fmtMs(v)}</b></div>`
          }
          return h
        },
      },
      legend: { top: 2, left: 0, right: 56, type: 'scroll', textStyle: { color: fg, fontSize: 12 }, inactiveColor: line, icon: 'roundRect', itemWidth: 12, itemHeight: 4, pageIconColor: muted, pageTextStyle: { color: muted } },
      xAxis: { type: 'time', min: p.from, max: p.to, axisLine: { lineStyle: { color: line } }, splitLine: { show: false },
        axisLabel: { color: muted, hideOverlap: true, formatter: (v: number) => fmtTime(v, lang, span > 2 * DAY ? { day: '2-digit', month: 'short' } : { hour: '2-digit', minute: '2-digit' }) } },
      yAxis: { type: 'value', name: 'ms', nameGap: 12, nameTextStyle: { color: muted, align: 'right', padding: [0, 6, 0, 0] }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: line, type: 'dashed', opacity: 0.7 } } },
      dataZoom: [
        { type: 'inside', filterMode: 'none' },
        { type: 'slider', height: 22, bottom: 8, borderColor: line, fillerColor: css('--accent-weak'), handleStyle: { color: surf, borderColor: muted },
          dataBackground: { lineStyle: { color: muted, opacity: 0.4 }, areaStyle: { color: muted, opacity: 0.08 } }, textStyle: { color: muted }, labelFormatter: (v: number) => fmtDT(v, lang) },
      ],
      toolbox: { right: 0, top: 0, itemSize: 14, feature: { dataZoom: { yAxisIndex: 'none' } }, iconStyle: { borderColor: muted } },
      animationDuration: 300,
      series,
    }, { notMerge: true })
  }

  return <div ref={el} style={{ width: '100%', height: p.height || 340 }} role="img" aria-label={t('responseTime')} />
}

/** Small SVG sparkline used on target cards. */
export function Sparkline({ points, color }: { points: { v: number | null; down: boolean }[]; color: string }) {
  const w = 110, h = 34
  const nums = points.map(p => p.v).filter((v): v is number => v != null)
  if (!nums.length) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" />
  const mx = Math.max(...nums) * 1.1 || 1
  const X = (i: number) => (i / Math.max(1, points.length - 1)) * (w - 4) + 2
  const Y = (v: number) => h - 3 - (v / mx) * (h - 8)
  let d = '', started = false, last = 0, first = -1
  points.forEach((p, i) => {
    if (p.v == null) { started = false; return }
    d += `${started ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)} `
    started = true; last = i; if (first < 0) first = i
  })
  const area = `${d}L${X(last).toFixed(1)} ${h} L${X(first).toFixed(1)} ${h} Z`
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={area} fill={color} opacity={0.12} />
      {points.map((p, i) => p.down ? <rect key={i} x={X(i) - 1.5} y={2} width={3} height={h - 4} fill="var(--down)" opacity={0.75} /> : null)}
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
      <circle cx={X(last)} cy={Y(points[last].v!)} r={2.4} fill={color} />
    </svg>
  )
}
