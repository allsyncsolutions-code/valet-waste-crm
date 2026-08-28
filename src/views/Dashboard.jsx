import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { hasSupabase } from '../lib/supabaseClient.js'
import { loadCustomers, subscribeCustomers } from '../lib/customersData.js'
import { loadInvoices, subscribeInvoices, round2 } from '../lib/invoicesData.js'
import { loadPropertyPickups, subscribeSchedules, freqLabel } from '../lib/schedulesData.js'
import { scheduleHitsDate, loadDayOverrides } from '../lib/routesData.js'
import { loadOpenRequests, subscribeOpenRequests } from '../lib/requestsData.js'
import RequestTriage from '../components/RequestTriage.jsx'

// Local YYYY-MM-DD for "today" (matches how routes key their service_date).
const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const money = (v) => '$' + Number(v || 0).toFixed(2)
const initialsOf = (name) =>
  (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

const STATUS_META = {
  draft: { label: 'Draft', color: '#7c8a82', bg: '#eef0ed' },
  sent: { label: 'Sent', color: '#b07a1e', bg: '#fdf2e0' },
  paid: { label: 'Paid', color: '#1f7a4d', bg: '#e7f1eb' },
  void: { label: 'Void', color: '#9a2c1e', bg: '#fdecea' },
}

export default function Dashboard({ app }) {
  const { isMobile, go } = app
  const [customers, setCustomers] = useState([])
  const [invoices, setInvoices] = useState([])
  const [schedules, setSchedules] = useState([])
  const [overrides, setOverrides] = useState(null) // one-time day changes for today
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [openRequests, setOpenRequests] = useState(null) // null = still loading
  const [triageOpen, setTriageOpen] = useState(false)

  async function refresh() {
    const [c, i, s, ov] = await Promise.all([
      loadCustomers(), loadInvoices(app.activeLine), loadPropertyPickups(app.activeLine),
      loadDayOverrides(todayKey()).catch(() => null),
    ])
    setCustomers(c.filter((x) => (x.business_line || 'waste') === (app.activeLine || 'waste')))
    setInvoices(i)
    setSchedules(s)
    setOverrides(ov)
  }

  useEffect(() => {
    if (!hasSupabase) {
      setErr('Supabase env vars not set — check .env.local')
      setLoading(false)
      return
    }
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    let t
    const reload = () => { clearTimeout(t); t = setTimeout(() => refresh().catch(() => {}), 300) }
    const unsubC = subscribeCustomers(reload)
    const unsubI = subscribeInvoices(reload)
    const unsubS = subscribeSchedules(reload)
    // Open client requests (portal tickets) — realtime, plus a light poll in
    // case an insert lands before the channel settles.
    const reloadRequests = () => { loadOpenRequests().then(setOpenRequests).catch(() => {}) }
    reloadRequests()
    const unsubR = subscribeOpenRequests(reloadRequests)
    const poll = setInterval(reloadRequests, 60000)
    return () => { clearTimeout(t); unsubC && unsubC(); unsubI && unsubI(); unsubS && unsubS(); unsubR && unsubR(); clearInterval(poll) }
  }, [app.activeLine])

  const stats = useMemo(() => {
    const activeClients = customers.filter((c) => c.status === 'active').length
    const today = todayKey()
    // A property is due today if any of its pickup days lands on today's date
    // (respecting frequency / start date) and its client isn't paused.
    const todayPickups = schedules.filter((p) => {
      if (p.customerStatus === 'paused' || p.paused) return false
      if (overrides?.skips?.has(p.id)) return false // one-time moved off today
      if (overrides?.extras?.has(p.id)) return true // one-time moved onto today
      return (p.days || []).some((d) => scheduleHitsDate({ day_of_week: d, frequency: p.frequency, start_date: p.startDate, active: true }, today))
    })
    const outstanding = round2(invoices.filter((i) => i.status === 'sent').reduce((a, i) => a + i.total, 0))
    const collected = round2(invoices.filter((i) => i.status === 'paid').reduce((a, i) => a + i.total, 0))
    const drafts = invoices.filter((i) => i.status === 'draft').length
    return { activeClients, todayPickups, outstanding, collected, drafts }
  }, [customers, invoices, schedules, overrides])

  const recentInvoices = invoices.slice(0, 6)
  const hasAnything = customers.length || invoices.length || schedules.length

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      {err && <div style={errorBox}>{err}</div>}

      {/* Open client requests — a ticket queue on the dashboard until handled */}
      {!loading && openRequests?.length > 0 && (
        <div onClick={() => setTriageOpen(true)} style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, background: '#fdecea', border: '1px solid #f3b7b0', borderRadius: 12, padding: '13px 16px', cursor: 'pointer' }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: '#f6c1ba', color: '#9a2c1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontWeight: 700 }}>{openRequests.length}</div>
          <div style={{ flex: 1, fontSize: 13, color: '#9a2c1e', lineHeight: 1.4 }}>
            <b>{openRequests.length} client request{openRequests.length > 1 ? 's' : ''} waiting</b> — {openRequests.map((r) => r.name).slice(0, 3).join(', ')}{openRequests.length > 3 ? ` +${openRequests.length - 3} more` : ''}
            <span style={{ color: '#b3261e' }}> · oldest {Math.max(0, Math.floor((Date.now() - new Date(openRequests[openRequests.length - 1].createdAt).getTime()) / 86400000))}d</span>
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#9a2c1e' }}>Review →</div>
        </div>
      )}
      {triageOpen && (
        <RequestTriage requests={openRequests || []} onChanged={() => { loadOpenRequests().then(setOpenRequests).catch(() => {}) }} onClose={() => setTriageOpen(false)} app={app} />
      )}

      {loading && <div style={empty}>Loading dashboard…</div>}

      {!loading && !hasAnything && (
        <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '48px 26px', textAlign: 'center' }}>
          <div style={{ fontSize: 26, marginBottom: 10 }}>▦</div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Nothing to show yet</div>
          <div style={{ fontSize: 13, color: '#7c8a82', marginBottom: 18 }}>Add your first client to start seeing pickups, billing and activity here.</div>
          <button onClick={() => go('clients')} style={primaryBtn}>Go to Clients</button>
        </div>
      )}

      {!loading && hasAnything && (
        <>
          {/* KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}>
            <Kpi label="Active clients" value={String(stats.activeClients)} sub={`${customers.length} total`} accent="#1f7a4d" onClick={() => go('clients')} />
            <Kpi label="Today's pickups" value={String(stats.todayPickups.length)} sub={DOW[new Date().getDay()].replace(/^./, (m) => m.toUpperCase())} accent="#155e9c" onClick={() => go('schedule')} />
            <Kpi label="Outstanding" value={money(stats.outstanding)} sub={`${invoices.filter((i) => i.status === 'sent').length} sent`} accent="#b07a1e" onClick={() => go('invoices')} />
            <Kpi label="Collected" value={money(stats.collected)} sub={`${invoices.filter((i) => i.status === 'paid').length} paid`} accent="#1f7a4d" onClick={() => go('invoices')} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
            {/* Today's pickups */}
            <Panel title="Today's pickups" actionLabel="Schedules" onAction={() => go('schedule')}>
              {stats.todayPickups.length === 0 && <div style={panelEmpty}>No pickups scheduled for today.</div>}
              {stats.todayPickups.map((s) => (
                <div key={s.id} style={row}>
                  <div style={avatar}>{initialsOf(s.customerName)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.customerName}</div>
                    <div style={{ fontSize: 11.5, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.address || s.service || 'Pickup'}</div>
                  </div>
                  <span style={{ flex: 'none', fontFamily: MONO, fontSize: 10, color: '#1f7a4d', background: '#e7f1eb', padding: '2px 8px', borderRadius: 6 }}>{freqLabel(s.frequency)}</span>
                </div>
              ))}
            </Panel>

            {/* Recent invoices */}
            <Panel title="Recent invoices" actionLabel="Invoicing" onAction={() => go('invoices')}>
              {recentInvoices.length === 0 && <div style={panelEmpty}>No invoices yet.</div>}
              {recentInvoices.map((inv) => {
                const meta = STATUS_META[inv.status] || STATUS_META.draft
                return (
                  <div key={inv.id} onClick={() => go('invoices')} style={{ ...row, cursor: 'pointer' }}>
                    <div style={avatar}>{initialsOf(inv.customerName)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inv.customerName || 'Unknown'}</div>
                      <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>{inv.number}</div>
                    </div>
                    <div style={{ textAlign: 'right', flex: 'none' }}>
                      <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{money(inv.total)}</div>
                      <span style={{ fontFamily: MONO, fontSize: 9.5, color: meta.color, background: meta.bg, padding: '1px 6px', borderRadius: 5 }}>{meta.label}</span>
                    </div>
                  </div>
                )
              })}
            </Panel>
          </div>

          {stats.drafts > 0 && (
            <div onClick={() => go('invoices')} style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 11, background: '#fff7e9', border: '1px solid #f0dcb0', borderRadius: 12, padding: '13px 16px', cursor: 'pointer' }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: '#f6e3b8', color: '#8a6320', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontWeight: 700 }}>{stats.drafts}</div>
              <div style={{ flex: 1, fontSize: 13, color: '#8a6320' }}>You have {stats.drafts} draft invoice{stats.drafts > 1 ? 's' : ''} not sent yet.</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#8a6320' }}>Review →</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, sub, accent, onClick }) {
  return (
    <div onClick={onClick} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '14px 16px', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 11.5, color: '#7c8a82' }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 25, fontWeight: 600, color: accent, marginTop: 3, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: '#9aa69e', marginTop: 2 }}>{sub}</div>
    </div>
  )
}

function Panel({ title, actionLabel, onAction, children }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '6px 6px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px 8px' }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
        {actionLabel && <div onClick={onAction} style={{ fontSize: 12, fontWeight: 600, color: '#1f7a4d', cursor: 'pointer' }}>{actionLabel} →</div>}
      </div>
      <div style={{ padding: '0 8px' }}>{children}</div>
    </div>
  )
}

const row = { display: 'flex', alignItems: 'center', gap: 11, padding: '9px 8px', borderTop: '1px solid #f1f3f0' }
const avatar = { width: 34, height: 34, flex: 'none', borderRadius: 9, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 11 }
const empty = { padding: '40px 14px', textAlign: 'center', color: '#9aa69e', fontSize: 13 }
const panelEmpty = { padding: '18px 10px', textAlign: 'center', color: '#9aa69e', fontSize: 12.5 }
const errorBox = { marginBottom: 14, background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5 }
const primaryBtn = { background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
