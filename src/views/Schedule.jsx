import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { hasSupabase } from '../lib/supabaseClient.js'
import {
  loadPropertyPickups,
  savePropertyPickup,
  setPropertyPaused,
  assignPropertyCustomer,
  subscribeSchedules,
  FREQUENCIES,
  DAYS,
  freqLabel,
} from '../lib/schedulesData.js'
import { deleteProperty, loadCustomers, createClient } from '../lib/customersData.js'
import { logActivity } from '../lib/activityData.js'
import PausedReview from '../components/PausedReview.jsx'

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const DAY_ABBR = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' }
const orderDays = (days) => DAY_ORDER.filter((d) => (days || []).includes(d))
// Sort key: earliest pickup weekday (unscheduled sinks to the bottom), then address.
const dayRank = (days) => {
  const o = orderDays(days)
  return o.length ? DAY_ORDER.indexOf(o[0]) : 99
}

export default function Schedule({ app }) {
  const isMobile = app.isMobile
  const [pickups, setPickups] = useState([]) // one row per property
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [search, setSearch] = useState('')
  const [selId, setSelId] = useState(null) // clicked row → reveals Edit days
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState({ days: [], frequency: 'weekly' })
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState(null) // pause/resume/remove in flight
  const [showPaused, setShowPaused] = useState(false) // paused stops hidden by default (same rule as dispatch)
  const [reviewOpen, setReviewOpen] = useState(false) // bulk paused-address cleanup popup
  const [customers, setCustomers] = useState([]) // client list for the tie-to flow
  const [reviewBusy, setReviewBusy] = useState(false)

  async function refresh() {
    setPickups(await loadPropertyPickups(app.activeLine))
  }

  useEffect(() => {
    if (!hasSupabase) {
      setErr('Supabase env vars not set — check .env.local')
      setLoading(false)
      return
    }
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    const unsub = subscribeSchedules(() => { refresh().catch(() => {}) })
    return () => unsub && unsub()
  }, [app.activeLine])

  const q = search.toLowerCase().trim()
  // Paused addresses (properties.paused = the same flag dispatch/routes use) are
  // hidden by default so dead stops like the old Ancient City Hideaways addresses
  // don't clutter the list; the toggle brings them back for review/reactivation.
  const visible = useMemo(
    () => (showPaused ? pickups : pickups.filter((p) => !p.paused)),
    [pickups, showPaused]
  )
  const pausedCount = pickups.filter((p) => p.paused).length
  const rows = useMemo(() => {
    const list = q
      ? visible.filter((p) => (p.customerName + ' ' + p.address + ' ' + p.service).toLowerCase().includes(q))
      : visible
    return list.slice().sort((a, b) => {
      const dr = dayRank(a.days) - dayRank(b.days)
      if (dr) return dr
      return (a.address || a.name).localeCompare(b.address || b.name)
    })
  }, [visible, q])

  const scheduledCount = visible.filter((p) => orderDays(p.days).length).length

  function openEdit(p) {
    setEditId(p.id)
    setForm({ days: orderDays(p.days), frequency: p.frequency || 'weekly' })
  }
  const toggleDay = (d) =>
    setForm((f) => ({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] }))

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    try {
      await savePropertyPickup(editId, { days: form.days, frequency: form.frequency })
      setEditId(null)
      await refresh()
    } catch (e2) {
      setErr(e2.message || String(e2))
    } finally {
      setSaving(false)
    }
  }

  // Pause/resume flips properties.paused — the exact flag Routes & Dispatch
  // filter on, so a paused stop drops off every board, not just this page.
  async function togglePause(p) {
    const label = p.address || p.name
    if (!p.paused) {
      if (!window.confirm(`Pause ${label}?\n\nIt stays a client address but drops off every route, the unrouted list, and this schedule until resumed.`)) return
    }
    setBusyId(p.id)
    setErr(null)
    try {
      await setPropertyPaused(p.id, !p.paused)
      await refresh()
    } catch (e2) {
      setErr(e2.message || String(e2))
    } finally {
      setBusyId(null)
    }
  }

  // Full removal: deletes the address from the client record (server-side RPC
  // keeps the audit trail). For "no longer serviced" addresses, Pause is the
  // safer choice — Remove is for addresses that shouldn't exist at all.
  async function removeAddress(p) {
    const label = p.address || p.name
    if (!window.confirm(`Remove ${label} entirely?\n\nThis deletes the address from the client's record — it disappears from schedules, routes, and the client profile. Past service history stays in the audit log. If you just want to stop servicing it, use Pause instead.`)) return
    setBusyId(p.id)
    setErr(null)
    try {
      await deleteProperty(p.id)
      logActivity({ type: 'property_deleted', summary: `Removed address ${label} from schedules`, entityType: 'property', entityId: p.id })
      if (editId === p.id) setEditId(null)
      if (selId === p.id) setSelId(null)
      await refresh()
    } catch (e2) {
      setErr(e2.message || String(e2))
    } finally {
      setBusyId(null)
    }
  }

  // --- Bulk paused-address review (the popup) -------------------------------
  async function openReview() {
    setReviewOpen(true)
    if (!customers.length) {
      loadCustomers()
        .then((list) => setCustomers(list.filter((c) => (c.business_line || 'waste') === (app.activeLine || 'waste'))))
        .catch(() => {})
    }
  }

  // Run an async op over ids one at a time; collect failures instead of
  // aborting the batch. Returns how many succeeded.
  async function runBatch(ids, op) {
    setReviewBusy(true)
    setErr(null)
    let ok = 0
    const failures = []
    for (const id of ids) {
      try {
        await op(id)
        ok++
      } catch (e2) {
        failures.push(e2.message || String(e2))
      }
    }
    await refresh()
    setReviewBusy(false)
    if (failures.length) setErr(`${ok}/${ids.length} done. ${failures.length} failed: ${failures[0]}`)
    return ok
  }

  const bulkResume = (ids) => runBatch(ids, (id) => setPropertyPaused(id, false))

  function bulkRemove(ids) {
    if (!window.confirm(`Remove ${ids.length} ${ids.length === 1 ? 'address' : 'addresses'} entirely?\n\nThey disappear from schedules, routes, and client profiles. Past service history stays in the audit log. If you just want to stop servicing them, use Resume/Pause instead.`)) return
    runBatch(ids, async (id) => {
      await deleteProperty(id)
      logActivity({ type: 'property_deleted', summary: 'Removed address from schedules (bulk paused review)', entityType: 'property', entityId: id })
    })
  }

  const bulkAssign = (ids, customerId) =>
    runBatch(ids, async (id) => {
      await assignPropertyCustomer(id, customerId)
      const c = customers.find((x) => x.id === customerId)
      logActivity({ type: 'property_assigned', summary: `Tied address to ${c?.name || 'a client'}`, entityType: 'property', entityId: id })
    })

  // Create a brand-new contact and tie the selected untied addresses to it.
  async function bulkCreateAndAssign(ids, form) {
    setReviewBusy(true)
    setErr(null)
    try {
      const customerId = await createClient({
        name: form.name.trim(),
        contactName: form.contactName.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        businessLine: app.activeLine,
      })
      await runBatch(ids, (id) => assignPropertyCustomer(id, customerId))
    } catch (e2) {
      setErr(e2.message || String(e2))
      setReviewBusy(false)
    }
  }

  const editing = pickups.find((p) => p.id === editId)
  const pausedRows = pickups.filter((p) => p.paused)
  // Columns: Address | Client | Service | Days | Freq | Action. Trim on mobile.
  const cols = isMobile ? '1fr 116px 96px' : 'minmax(0,2.1fr) minmax(0,1.3fr) minmax(0,1fr) 122px 84px 168px'

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by client, address or service…" style={searchInput} />
          <div style={searchIcon}>⌕</div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11.5, color: '#7c8a82', flex: 'none' }}>{scheduledCount} scheduled · {visible.length} addresses{pausedCount ? ` · ${pausedCount} paused` : ''}</div>
        {pausedCount > 0 && (
          <button
            onClick={() => setShowPaused((v) => !v)}
            style={{ flex: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '.03em', padding: '5px 10px', borderRadius: 7, border: `1px solid ${showPaused ? '#8a6d1e' : '#dde2dd'}`, background: showPaused ? '#f6efdd' : '#fff', color: showPaused ? '#8a6d1e' : '#7c8a82' }}
          >
            {showPaused ? 'Hide paused' : `Show paused (${pausedCount})`}
          </button>
        )}
        {pausedCount > 0 && (
          <button
            onClick={openReview}
            style={{ flex: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '.03em', padding: '5px 10px', borderRadius: 7, border: '1px solid #f3b7b0', background: '#fdecea', color: '#9a2c1e' }}
          >
            Review paused…
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#7c8a82', margin: '0 2px 12px' }}>
        One row per address — the same list Routes &amp; Dispatch build from. Click a row to edit days, pause an old stop (off every route until resumed), or remove it entirely.
      </div>

      {err && <div style={errorBox}>{err}</div>}
      {loading && <div style={empty}>Loading schedules…</div>}

      {!loading && !pickups.length && (
        <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 13, padding: '44px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>▤</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 5 }}>No addresses yet</div>
          <div style={{ fontSize: 13, color: '#7c8a82' }}>Add a client and their properties first — pickup days attach to each address.</div>
        </div>
      )}

      {!loading && !!pickups.length && !rows.length && <div style={empty}>No addresses match “{search}”.</div>}

      {!loading && !!rows.length && (
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, overflow: 'hidden' }}>
          {/* header */}
          <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '9px 14px', borderBottom: '1px solid #e6eae6', background: '#f7f9f7', fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#7c8a82' }}>
            <div>ADDRESS</div>
            {!isMobile && <div>CLIENT</div>}
            {!isMobile && <div>SERVICE</div>}
            <div>DAYS</div>
            {!isMobile && <div>FREQ</div>}
            <div />
          </div>
          {/* rows */}
          <div style={{ maxHeight: '64vh', overflowY: 'auto' }}>
            {rows.map((p) => {
              const sel = selId === p.id
              const days = orderDays(p.days)
              return (
                <div
                  key={p.id}
                  onClick={() => setSelId(sel ? null : p.id)}
                  style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '8px 14px', borderBottom: '1px solid #f1f3f0', alignItems: 'center', cursor: 'pointer', background: sel ? '#eef5f0' : '#fff', fontSize: 13, opacity: p.paused ? 0.55 : 1 }}
                >
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ minWidth: 0, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.address || p.name}</span>
                    {p.needsReview && <span title="Flagged for review" style={{ flex: 'none', fontFamily: MONO, fontSize: 9.5, fontWeight: 700, color: '#c0492f', background: '#fbeae6', padding: '1px 5px', borderRadius: 4, letterSpacing: '.03em' }}>⚠ REVIEW</span>}
                    {p.paused && <span title="Paused — off every route until resumed" style={{ flex: 'none', fontFamily: MONO, fontSize: 9.5, fontWeight: 700, color: '#8a6d1e', background: '#f6efdd', padding: '1px 5px', borderRadius: 4, letterSpacing: '.03em' }}>⏸ PAUSED</span>}
                  </div>
                  {!isMobile && <div style={{ minWidth: 0, color: '#5d6b63', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.customerName}</div>}
                  {!isMobile && <div style={{ minWidth: 0, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.service || '—'}</div>}
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {days.length ? days.map((d) => (
                      <span key={d} style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: '#1f7a4d', background: '#eef5f0', border: '1px solid #d6e6dc', padding: '1px 5px', borderRadius: 4 }}>{DAY_ABBR[d]}</span>
                    )) : <span style={{ fontSize: 11.5, color: '#c08a2e' }}>None</span>}
                  </div>
                  {!isMobile && <div style={{ color: '#7c8a82', fontSize: 12 }}>{freqLabel(p.frequency)}</div>}
                  <div style={{ textAlign: 'right', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {sel ? (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); openEdit(p) }} style={editBtn}>Edit days</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); togglePause(p) }}
                          disabled={busyId === p.id}
                          title={p.paused ? 'Resume — put this address back on routes' : 'Pause — keep the address but take it off every route'}
                          style={{ ...editBtn, background: p.paused ? '#1f7a4d' : '#fff', color: p.paused ? '#fff' : '#8a6d1e', border: p.paused ? 'none' : '1px solid #e2d3ac', opacity: busyId === p.id ? 0.6 : 1 }}
                        >
                          {p.paused ? '▶ Resume' : '⏸ Pause'}
                        </button>
                      </>
                    ) : (
                      <span style={{ color: '#c2cabf', fontSize: 14 }}>›</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {editId && editing && (
        <div onClick={() => !saving && setEditId(null)} style={overlay}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submit} style={modal}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 2 }}>Pickup days</div>
            <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 16 }}>{editing.address || editing.name} · {editing.customerName}</div>

            <div style={{ fontSize: 11.5, color: '#5d6b63', marginBottom: 7, fontWeight: 500 }}>Service days (pick one or more)</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {DAYS.map((d) => {
                const on = form.days.includes(d)
                return (
                  <button type="button" key={d} onClick={() => toggleDay(d)} style={{ flex: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 8, border: `1px solid ${on ? '#1f7a4d' : '#dde2dd'}`, background: on ? '#e7f1eb' : '#fff', color: on ? '#1f7a4d' : '#7c8a82' }}>{DAY_ABBR[d]}</button>
                )
              })}
            </div>

            <div style={{ fontSize: 11.5, color: '#5d6b63', marginBottom: 5, fontWeight: 500 }}>Frequency</div>
            <select value={form.frequency} onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))} style={inp}>
              {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>

            <div style={{ display: 'flex', gap: 9, marginTop: 18 }}>
              <button type="button" onClick={() => setEditId(null)} disabled={saving} style={cancelBtn}>Cancel</button>
              <button type="submit" disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save days'}</button>
            </div>

            <div style={{ display: 'flex', gap: 9, marginTop: 12, paddingTop: 12, borderTop: '1px solid #f1f3f0', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => { togglePause(editing) }}
                disabled={busyId === editing.id}
                style={{ flex: 'none', cursor: 'pointer', background: 'none', border: '1px solid #e2d3ac', color: '#8a6d1e', borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600 }}
              >
                {editing.paused ? '▶ Resume this address' : '⏸ Pause this address'}
              </button>
              <button
                type="button"
                onClick={() => { removeAddress(editing) }}
                disabled={busyId === editing.id}
                style={{ flex: 'none', cursor: 'pointer', background: 'none', border: 'none', color: '#c0492f', fontSize: 12, fontWeight: 600, padding: '7px 4px' }}
              >
                Remove address…
              </button>
              <span style={{ flex: 1, fontSize: 11, color: '#9aa69e', textAlign: 'right' }}>Pause keeps history; remove deletes it.</span>
            </div>
          </form>
        </div>
      )}

      {reviewOpen && pausedRows.length > 0 && (
        <PausedReview
          key={pausedRows.map((p) => p.id).join(',')}
          paused={pausedRows}
          customers={customers}
          busy={reviewBusy}
          onClose={() => !reviewBusy && setReviewOpen(false)}
          onResume={bulkResume}
          onRemove={bulkRemove}
          onAssign={bulkAssign}
          onCreateAndAssign={bulkCreateAndAssign}
        />
      )}
    </div>
  )
}

const inp = { width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '9px 11px', fontSize: 15, outline: 'none', boxSizing: 'border-box' }
const empty = { padding: '22px 14px', textAlign: 'center', color: '#9aa69e', fontSize: 12.5 }
const errorBox = { marginBottom: 14, background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5 }
const editBtn = { background: '#1f7a4d', border: 'none', borderRadius: 7, padding: '5px 11px', fontSize: 12, fontWeight: 600, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }
const modal = { width: 460, maxWidth: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }
const cancelBtn = { flex: 'none', background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const primaryBtn = { flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const searchInput = { width: '100%', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '9px 12px 9px 32px', fontSize: 16, outline: 'none', boxSizing: 'border-box' }
const searchIcon = { position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e' }
