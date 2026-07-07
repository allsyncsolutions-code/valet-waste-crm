// "Time Sheets & Payroll" — a tech's own hours, jobs, and pay. Week view
// (Sun–Sat, per-day breakdown) with a month view for the accrual that pays out
// on the 1st. Pay is PER JOB (clock-in + complete + photo required); hours are
// informational from the timesheets table.
import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { loadWeekPay, loadWeekTimesheets, loadMonthPay, weekStartOf, addDaysStr } from '../lib/payData.js'

const GREEN = '#1f7a4d'
const LAWN = '#7a9e2e'
const money = (v) => '$' + Number(v || 0).toFixed(2)
const parse = (s) => new Date(s + 'T12:00:00')
const prettyD = (s) => parse(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const hhmm = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—')
const hoursBetween = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 36e5) : 0)

export default function TimeSheets({ app }) {
  const me = app.user || {}
  const [mode, setMode] = useState('week') // week | month
  const [weekStart, setWeekStart] = useState(weekStartOf())
  const [stops, setStops] = useState([]) // my stops this week
  const [sheets, setSheets] = useState([]) // my timesheets this week
  const [month, setMonth] = useState(null) // { monthLabel, payDateLabel, mine: {payable, pending} }
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr('')
    Promise.all([
      loadWeekPay(weekStart),
      loadWeekTimesheets(weekStart).catch(() => []),
      loadMonthPay(weekStart),
    ])
      .then(([byDriver, ts, m]) => {
        if (!alive) return
        setStops((byDriver[me.id] || []).sort((a, b) => (a.date < b.date ? -1 : 1)))
        setSheets((ts || []).filter((t) => t.profile_id === me.id))
        setMonth({ ...m, mine: m.totals[me.id] || { payable: 0, pending: 0 } })
      })
      .catch((e) => { if (alive) setErr(e.message || String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [weekStart, me.id])

  const weekEnd = addDaysStr(weekStart, 6)
  const weekLabel = `${prettyD(weekStart)} – ${prettyD(weekEnd)}`

  const totals = useMemo(() => {
    const payable = stops.filter((s) => s.payable).reduce((t, s) => t + Number(s.pay || 0), 0)
    const pending = stops.filter((s) => !s.payable).reduce((t, s) => t + Number(s.pay || 0), 0)
    const hours = sheets.reduce((t, s) => t + hoursBetween(s.clock_in, s.clock_out), 0)
    return { payable, pending, hours, jobs: stops.length, done: stops.filter((s) => s.payable).length }
  }, [stops, sheets])

  // Per-day rows Sun–Sat: jobs + hours.
  const dayRows = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const key = addDaysStr(weekStart, i)
    const dayStops = stops.filter((s) => s.date === key)
    const sheet = sheets.find((t) => t.work_date === key)
    return { key, dayStops, sheet, hours: sheet ? hoursBetween(sheet.clock_in, sheet.clock_out) : 0 }
  }), [weekStart, stops, sheets])

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12, background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '9px 12px' }}>
        <div onClick={() => setWeekStart((w) => addDaysStr(w, -7))} style={navBtn}>‹</div>
        <div style={{ fontWeight: 700, fontSize: 14, minWidth: 190, textAlign: 'center' }}>{weekLabel}</div>
        <div onClick={() => setWeekStart((w) => addDaysStr(w, 7))} style={navBtn}>›</div>
        <div onClick={() => setWeekStart(weekStartOf())} style={{ fontSize: 12, fontWeight: 600, color: GREEN, border: '1px solid #cfe0d5', borderRadius: 8, padding: '6px 11px', cursor: 'pointer' }}>This week</div>
        <div style={{ flex: 1 }} />
        {['week', 'month'].map((m) => (
          <button key={m} onClick={() => setMode(m)} style={{ background: mode === m ? GREEN : '#fff', color: mode === m ? '#fff' : '#5d6b63', border: `1px solid ${mode === m ? GREEN : '#dde2dd'}`, borderRadius: 8, padding: '6px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize' }}>{m}</button>
        ))}
      </div>

      {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {/* summary cards */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <Card label={mode === 'week' ? 'Week pay (earned)' : `${month?.monthLabel || 'Month'} (earned)`} value={money(mode === 'week' ? totals.payable : month?.mine?.payable)} accent={GREEN} sub={mode === 'week' ? `${totals.done}/${totals.jobs} jobs payable` : `pays ${month?.payDateLabel || 'the 1st'}`} />
        <Card label="Pending" value={money(mode === 'week' ? totals.pending : month?.mine?.pending)} accent="#b07a1e" sub="needs clock-in + complete + photo" />
        <Card label="Hours this week" value={totals.hours ? totals.hours.toFixed(1) + 'h' : '—'} accent="#2f6db0" sub="from clock in/out (info only)" />
        <Card label="Jobs this week" value={String(totals.jobs)} accent={LAWN} sub={`${totals.done} complete`} />
      </div>

      {loading ? (
        <div style={{ color: '#7c8a82', fontSize: 13, padding: 28, textAlign: 'center' }}>Loading…</div>
      ) : mode === 'month' ? (
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{month?.monthLabel} accrual</div>
          <div style={{ fontSize: 13, color: '#5d6b63', lineHeight: 1.6 }}>
            You've earned <b style={{ color: GREEN }}>{money(month?.mine?.payable)}</b> so far this month
            {Number(month?.mine?.pending) > 0 && <> with <b style={{ color: '#b07a1e' }}>{money(month?.mine?.pending)}</b> still pending (finish those jobs — clock in, complete, photo — to lock the pay in)</>}.
            Payroll for the month goes out on <b>{month?.payDateLabel}</b>.
          </div>
          <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 10 }}>Flip to Week to see the day-by-day and per-job breakdown.</div>
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '10px 14px' }}>
          {dayRows.map(({ key, dayStops, sheet, hours }) => (
            <div key={key} style={{ padding: '10px 2px', borderBottom: '1px solid #f1f3f0' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700, fontSize: 13, width: 110 }}>{prettyD(key)}</div>
                <div style={{ fontSize: 12, color: '#7c8a82' }}>
                  {sheet ? `⏱ ${hhmm(sheet.clock_in)} – ${hhmm(sheet.clock_out)}${hours ? ` · ${hours.toFixed(1)}h` : ''}` : 'no clock in/out'}
                </div>
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 12, color: '#5d6b63' }}>{dayStops.length ? `${dayStops.length} job${dayStops.length === 1 ? '' : 's'}` : ''}</div>
              </div>
              {dayStops.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '5px 0 0 12px', fontSize: 12.5 }}>
                  <span style={{ flex: 'none', color: s.payable ? GREEN : '#b07a1e' }}>{s.payable ? '✓' : '…'}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.address || '—'}</span>
                  {!s.payable && s.missing && <span style={{ flex: 'none', fontSize: 11, color: '#b07a1e' }}>needs {s.missing}</span>}
                  {s.override && <span style={{ flex: 'none', fontSize: 10.5, color: '#7c8a82', fontFamily: MONO }} title={`Approved by ${s.overrideBy}`}>OVERRIDE</span>}
                  <span style={{ flex: 'none', fontFamily: MONO, fontWeight: 600, color: s.payable ? GREEN : '#9aa69e' }}>{s.pay != null ? money(s.pay) : '—'}</span>
                </div>
              ))}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, padding: '12px 2px 6px', alignItems: 'baseline' }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Week total</div>
            <div style={{ flex: 1 }} />
            {totals.pending > 0 && <span style={{ fontSize: 12, color: '#b07a1e' }}>{money(totals.pending)} pending</span>}
            <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 15, color: GREEN }}>{money(totals.payable)}</span>
          </div>
        </div>
      )}

      <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 12 }}>
        A job pays when it has a clock-in, a completion, and at least one photo. Missing something? Finish it from My Day, or ask an admin to approve an override.
      </div>
    </div>
  )
}

function Card({ label, value, sub, accent }) {
  return (
    <div style={{ flex: 1, minWidth: 150, background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '12px 15px' }}>
      <div style={{ fontSize: 11, color: '#7c8a82' }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: accent, marginTop: 3 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: '#9aa69e', marginTop: 2 }}>{sub}</div>
    </div>
  )
}

const navBtn = { width: 30, height: 30, flex: 'none', borderRadius: 8, border: '1px solid #e6eae6', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5d6b63', fontSize: 15 }
