// Month calendar for one-time jobs (Junk Removal). Replaces the recurring
// Schedules list when the Junk line is active — junk is a one-time service.
import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { loadJobsForMonth, createJob, setJobStatus, deleteJob } from '../lib/jobsData.js'
import { loadCustomers } from '../lib/customersData.js'
import { loadDrivers } from '../lib/teamData.js'

const GREEN = '#1f7a4d'
const monthStartStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
const dstr = (d) => d.toISOString().slice(0, 10)
const money = (v) => (v == null ? '' : `$${Number(v).toFixed(0)}`)
const STATUS_COLOR = { scheduled: '#2f6db0', done: GREEN, canceled: '#9aa69e' }

export default function JobCalendar({ app, line = 'junk', accent = '#2f6db0' }) {
  const [month, setMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1) })
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [selDate, setSelDate] = useState(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [customers, setCustomers] = useState([])
  const [drivers, setDrivers] = useState([])
  const [form, setForm] = useState({ customerId: '', address: '', window: '', amount: '', driverId: '', notes: '' })

  async function refresh(m = month) {
    setLoading(true)
    setErr('')
    try { setJobs(await loadJobsForMonth(line, monthStartStr(m))) }
    catch (e) { setErr(e.message || String(e)) }
    setLoading(false)
  }
  useEffect(() => { refresh(month) }, [month, line])
  useEffect(() => {
    // Any client can book a one-time job (a trash client can order junk removal).
    loadCustomers().then(setCustomers).catch(() => {})
    loadDrivers().then(setDrivers).catch(() => {})
  }, [line])

  const byDate = useMemo(() => {
    const m = {}
    for (const j of jobs) { m[j.date] ||= []; m[j.date].push(j) }
    return m
  }, [jobs])

  // calendar grid: weeks of the visible month (Sun–Sat)
  const weeks = useMemo(() => {
    const first = new Date(month)
    const start = new Date(first)
    start.setDate(1 - first.getDay())
    const out = []
    const cur = new Date(start)
    while (cur <= new Date(month.getFullYear(), month.getMonth() + 1, 0) || cur.getDay() !== 0) {
      if (cur.getDay() === 0) out.push([])
      out[out.length - 1].push(new Date(cur))
      cur.setDate(cur.getDate() + 1)
      if (out.length > 6) break
    }
    return out
  }, [month])

  async function submitJob(e) {
    e.preventDefault()
    if (!selDate) return
    setBusy(true)
    setErr('')
    try {
      const cust = customers.find((c) => c.id === form.customerId)
      await createJob(line, { ...form, date: selDate, address: form.address || cust?.address || '' })
      setForm({ customerId: '', address: '', window: '', amount: '', driverId: '', notes: '' })
      setAdding(false)
      await refresh()
    } catch (e2) { setErr(e2.message || String(e2)) }
    setBusy(false)
  }

  async function mark(j, status) {
    setBusy(true)
    try { await setJobStatus(j.id, status, `${j.customerName || j.address} (${j.date})`); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }
  async function remove(j) {
    if (!window.confirm('Delete this job?')) return
    setBusy(true)
    try { await deleteJob(j.id); await refresh() } catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const todayStr = dstr(new Date())
  const selJobs = selDate ? byDate[selDate] || [] : []
  const inp = { border: '1px solid #d8ddd6', borderRadius: 8, padding: '9px 11px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ fontSize: 13, color: '#5d6b63', marginBottom: 12 }}>
        One-time jobs live on this calendar — no recurring routes. Click a day to see or add jobs. Ask Trashy Randy when a job fits best around the day's trash routes.
      </div>
      {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} style={{ background: '#fff', border: '1px solid #dde2dd', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>‹</button>
        <div style={{ fontWeight: 800, fontSize: 16, minWidth: 170, textAlign: 'center' }}>{monthLabel}</div>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} style={{ background: '#fff', border: '1px solid #dde2dd', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>›</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: '#7c8a82' }}>{loading ? 'Loading…' : `${jobs.length} job${jobs.length === 1 ? '' : 's'} this month`}</span>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', borderBottom: '1px solid #eef0ee' }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} style={{ padding: '8px 0', textAlign: 'center', fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: '#7c8a82', letterSpacing: '.05em' }}>{d.toUpperCase()}</div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', borderBottom: wi < weeks.length - 1 ? '1px solid #eef0ee' : 'none' }}>
            {week.map((day) => {
              const ds = dstr(day)
              const inMonth = day.getMonth() === month.getMonth()
              const dayJobs = byDate[ds] || []
              const isSel = selDate === ds
              return (
                <div
                  key={ds}
                  onClick={() => { setSelDate(ds); setAdding(false) }}
                  style={{ minHeight: 84, padding: 6, cursor: 'pointer', background: isSel ? '#eef6f1' : inMonth ? '#fff' : '#fafbfa', borderRight: '1px solid #eef0ee', position: 'relative' }}
                >
                  <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: ds === todayStr ? 800 : 600, color: ds === todayStr ? accent : inMonth ? '#5d6b63' : '#c2c9c2' }}>{day.getDate()}</div>
                  {dayJobs.slice(0, 3).map((j) => (
                    <div key={j.id} title={`${j.customerName || j.address} ${money(j.amount)}`} style={{ marginTop: 3, fontSize: 10.5, fontWeight: 600, color: '#fff', background: STATUS_COLOR[j.status] || accent, borderRadius: 5, padding: '2px 5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: j.status === 'canceled' ? 'line-through' : 'none' }}>
                      {j.customerName || j.address || 'Job'}
                    </div>
                  ))}
                  {dayJobs.length > 3 && <div style={{ fontSize: 10, color: '#7c8a82', marginTop: 2 }}>+{dayJobs.length - 3} more</div>}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {selDate && (
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '15px 17px', marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{new Date(selDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
            <span style={{ flex: 1 }} />
            <button onClick={() => setAdding(!adding)} style={{ background: adding ? '#fff' : accent, color: adding ? '#5d6b63' : '#fff', border: `1px solid ${adding ? '#dde2dd' : accent}`, borderRadius: 9, padding: '8px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>{adding ? 'Cancel' : '+ Add job'}</button>
          </div>

          {adding && (
            <form onSubmit={submitJob} style={{ display: 'grid', gridTemplateColumns: app.isMobile ? '1fr' : '1fr 1fr', gap: 10, marginBottom: 14, background: '#fafbfa', border: '1px solid #eef0ee', borderRadius: 10, padding: 12 }}>
              <select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} style={inp}>
                <option value="">Client (optional)</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Address (defaults to client's)" style={inp} />
              <input value={form.window} onChange={(e) => setForm({ ...form, window: e.target.value })} placeholder="Time window, e.g. 9–11am" style={inp} />
              <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="Price $" type="number" step="0.01" style={inp} />
              <select value={form.driverId} onChange={(e) => setForm({ ...form, driverId: e.target.value })} style={inp}>
                <option value="">Driver (optional)</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
              </select>
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes" style={inp} />
              <button type="submit" disabled={busy} style={{ gridColumn: '1 / -1', background: accent, color: '#fff', border: 'none', borderRadius: 9, padding: '10px 0', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>{busy ? 'Saving…' : `Schedule job for ${selDate}`}</button>
            </form>
          )}

          {!selJobs.length && !adding && <div style={{ fontSize: 13, color: '#9aa69e' }}>No jobs this day.</div>}
          {selJobs.map((j) => (
            <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid #f2f4f2', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: '#fff', background: STATUS_COLOR[j.status] || accent, borderRadius: 5, padding: '3px 7px' }}>{j.status.toUpperCase()}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{j.customerName || 'No client'}{j.amount != null && <span style={{ color: GREEN }}> · {money(j.amount)}</span>}</div>
                <div style={{ fontSize: 12, color: '#7c8a82' }}>{j.address}{j.window ? ` · ${j.window}` : ''}{j.driverName ? ` · ${j.driverName}` : ''}{j.notes ? ` · ${j.notes}` : ''}</div>
              </div>
              <span style={{ flex: 1 }} />
              {j.status === 'scheduled' && <button onClick={() => mark(j, 'done')} disabled={busy} style={{ background: '#fff', border: `1px solid ${GREEN}55`, color: GREEN, borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Mark done</button>}
              {j.status === 'scheduled' && <button onClick={() => mark(j, 'canceled')} disabled={busy} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#7c8a82', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>}
              <button onClick={() => remove(j)} disabled={busy} style={{ background: '#fff', border: '1px solid #c0492f55', color: '#c0492f', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
