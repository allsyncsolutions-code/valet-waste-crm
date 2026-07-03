// Lawn Care employee management — who worked what, what they're getting paid
// for (check-in + photos gated), admin pay overrides with a visible trail, and
// informational clock in/out. Week runs Sunday–Saturday. Techs are paid per
// job; hours are for visibility only.
import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { loadTeam } from '../lib/teamData.js'
import { loadWeekPay, approveStopPay, loadWeekTimesheets, clockIn, clockOut, weekStartOf, addDaysStr } from '../lib/payData.js'

const GREEN = '#1f7a4d'
const LAWN = '#7a9e2e'
const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`)
const fmtD = (s) => new Date(s + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })
const fmtT = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—')
const hrs = (t) => {
  if (!t.clock_in || !t.clock_out) return null
  return Math.round(((new Date(t.clock_out) - new Date(t.clock_in)) / 3600000) * 10) / 10
}

export default function EmployeePay({ app }) {
  const me = app.user || {}
  const isAdmin = me.role === 'admin'
  const [weekStart, setWeekStart] = useState(weekStartOf())
  const [byDriver, setByDriver] = useState({})
  const [team, setTeam] = useState([])
  const [sheets, setSheets] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setLoading(true)
    setErr('')
    try {
      const [pay, tm, ts] = await Promise.all([loadWeekPay(weekStart), loadTeam(), loadWeekTimesheets(weekStart)])
      setByDriver(pay)
      setTeam(tm)
      setSheets(ts)
    } catch (e) { setErr(e.message || String(e)) }
    setLoading(false)
  }
  useEffect(() => { refresh() }, [weekStart])

  const nameOf = (id) => team.find((t) => t.id === id)?.full_name || team.find((t) => t.id === id)?.email || 'Unassigned'

  // Admins see everyone; techs/staff see just their own row.
  const driverIds = useMemo(() => {
    const ids = Object.keys(byDriver)
    return isAdmin ? ids : ids.filter((id) => id === me.id)
  }, [byDriver, isAdmin, me.id])

  const myToday = sheets.find((s) => s.profile_id === me.id && s.work_date === new Date().toISOString().slice(0, 10))

  async function approve(stop) {
    if (!window.confirm(`Approve pay for ${stop.address} (${fmtD(stop.date)}) even though it's missing ${stop.missing}? This is recorded in the timesheet.`)) return
    setBusy(true)
    try { await approveStopPay(stop.id, me.full_name || me.email, `${stop.address} ${stop.date}`); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }
  async function punch(inOut) {
    setBusy(true)
    setErr('')
    try { inOut === 'in' ? await clockIn(me.id) : await clockOut(me.id); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  const weekEnd = addDaysStr(weekStart, 6)
  const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '15px 17px' }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ fontSize: 13, color: '#5d6b63', marginBottom: 12 }}>
        Techs are paid <b>per job</b> — a job pays out when it has a check-in, a check-out, and at least one photo. Anything missing needs an admin's approval (recorded below). Clock in/out tracks how long jobs take; it doesn't change pay.
      </div>
      {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {/* week picker + my clock */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button onClick={() => setWeekStart(addDaysStr(weekStart, -7))} style={navBtn}>‹</button>
        <div style={{ fontWeight: 800, fontSize: 14.5 }}>{fmtD(weekStart)} – {fmtD(weekEnd)}</div>
        <button onClick={() => setWeekStart(addDaysStr(weekStart, 7))} style={navBtn}>›</button>
        {weekStart !== weekStartOf() && <button onClick={() => setWeekStart(weekStartOf())} style={{ ...navBtn, color: GREEN, fontWeight: 700 }}>This week</button>}
        <span style={{ flex: 1 }} />
        {!myToday?.clock_in ? (
          <button onClick={() => punch('in')} disabled={busy} style={{ background: LAWN, color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>⏱ Clock in</button>
        ) : !myToday?.clock_out ? (
          <button onClick={() => punch('out')} disabled={busy} style={{ background: '#fff', color: LAWN, border: `1px solid ${LAWN}`, borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>⏱ Clock out (in {fmtT(myToday.clock_in)})</button>
        ) : (
          <span style={{ fontSize: 12.5, color: '#7c8a82' }}>Today: {fmtT(myToday.clock_in)}–{fmtT(myToday.clock_out)} ({hrs(myToday)}h)</span>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 28, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading…</div>
      ) : !driverIds.length ? (
        <div style={{ ...card, textAlign: 'center', color: '#7c8a82', fontSize: 13, border: '1px dashed #d8ddd6' }}>
          No lawn jobs this week{isAdmin ? ' — assign lawn routes in Routes & Dispatch.' : '.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {driverIds.map((did) => {
            const stops = byDriver[did] || []
            const total = stops.filter((s) => s.payable).reduce((n, s) => n + Number(s.pay || 0), 0)
            const pending = stops.filter((s) => !s.payable)
            const mySheets = sheets.filter((s) => s.profile_id === did && (s.clock_in || s.clock_out))
            const totalHrs = mySheets.reduce((n, t) => n + (hrs(t) || 0), 0)
            return (
              <div key={did} style={card}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                  <div style={{ fontWeight: 800, fontSize: 15.5 }}>{nameOf(did === '__unassigned__' ? null : did)}</div>
                  <span style={{ fontSize: 12, color: '#7c8a82' }}>{stops.length} job{stops.length === 1 ? '' : 's'}{totalHrs ? ` · ${Math.round(totalHrs * 10) / 10}h clocked` : ''}</span>
                  <span style={{ flex: 1 }} />
                  <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 15, color: GREEN }}>{money(total)} <span style={{ fontSize: 11, color: '#7c8a82', fontWeight: 400 }}>payable this week</span></div>
                  {pending.length > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#8a6414', background: '#faf3e2', borderRadius: 7, padding: '3px 9px' }}>{pending.length} needs review</span>}
                </div>

                {stops.sort((a, b) => (a.date < b.date ? -1 : 1)).map((s) => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', borderTop: '1px solid #f2f4f2', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: '#7c8a82', width: 86, flex: 'none' }}>{fmtD(s.date)}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.address || '(no address)'} <span style={{ color: '#9aa69e', fontWeight: 400, fontSize: 11.5 }}>Route {s.route}</span></div>
                      {s.override ? (
                        <div style={{ fontSize: 11.5, color: '#8a6414' }}>Pay approved by {s.overrideBy} {s.overrideAt ? `· ${new Date(s.overrideAt).toLocaleDateString()}` : ''} (missing {s.missing || 'requirements'})</div>
                      ) : !s.payable ? (
                        <div style={{ fontSize: 11.5, color: '#c0492f' }}>Missing {s.missing}</div>
                      ) : (
                        <div style={{ fontSize: 11.5, color: GREEN }}>✓ Checked in/out · {s.photos} photo{s.photos === 1 ? '' : 's'}</div>
                      )}
                    </div>
                    <span style={{ fontFamily: MONO, fontSize: 12.5, color: '#7c8a82', flex: 'none' }} title="What the client is charged">{money(s.charge)}</span>
                    <span style={{ fontFamily: MONO, fontSize: 13.5, fontWeight: 700, color: s.payable ? GREEN : '#c2c9c2', flex: 'none' }} title="What the tech earns">{money(s.pay)}</span>
                    {isAdmin && !s.payable && (
                      <button onClick={() => approve(s)} disabled={busy} style={{ background: '#fff', border: '1px solid #b07d1855', color: '#8a6414', borderRadius: 8, padding: '5px 10px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', flex: 'none' }}>Approve pay</button>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const navBtn = { background: '#fff', border: '1px solid #dde2dd', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13, color: '#5d6b63' }
