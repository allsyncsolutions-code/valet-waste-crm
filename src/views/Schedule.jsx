import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { hasSupabase } from '../lib/supabaseClient.js'
import {
  loadPropertyPickups,
  savePropertyPickup,
  subscribeSchedules,
  FREQUENCIES,
  DAYS,
  freqLabel,
} from '../lib/schedulesData.js'

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
  const rows = useMemo(() => {
    const list = q
      ? pickups.filter((p) => (p.customerName + ' ' + p.address + ' ' + p.service).toLowerCase().includes(q))
      : pickups
    return list.slice().sort((a, b) => {
      const dr = dayRank(a.days) - dayRank(b.days)
      if (dr) return dr
      return (a.address || a.name).localeCompare(b.address || b.name)
    })
  }, [pickups, q])

  const scheduledCount = pickups.filter((p) => orderDays(p.days).length).length

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

  const editing = pickups.find((p) => p.id === editId)
  // Columns: Address | Client | Service | Days | Freq | Action. Trim on mobile.
  const cols = isMobile ? '1fr 116px 96px' : 'minmax(0,2.1fr) minmax(0,1.3fr) minmax(0,1fr) 122px 84px 92px'

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by client, address or service…" style={searchInput} />
          <div style={searchIcon}>⌕</div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11.5, color: '#7c8a82', flex: 'none' }}>{scheduledCount} scheduled · {pickups.length} addresses</div>
      </div>
      <div style={{ fontSize: 12, color: '#7c8a82', margin: '0 2px 12px' }}>
        Pickup days live on each address — click a row to set them (an address can run more than one day a week).
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
                  style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '8px 14px', borderBottom: '1px solid #f1f3f0', alignItems: 'center', cursor: 'pointer', background: sel ? '#eef5f0' : '#fff', fontSize: 13 }}
                >
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ minWidth: 0, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.address || p.name}</span>
                    {p.needsReview && <span title="Flagged for review" style={{ flex: 'none', fontFamily: MONO, fontSize: 9.5, fontWeight: 700, color: '#c0492f', background: '#fbeae6', padding: '1px 5px', borderRadius: 4, letterSpacing: '.03em' }}>⚠ REVIEW</span>}
                  </div>
                  {!isMobile && <div style={{ minWidth: 0, color: '#5d6b63', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.customerName}</div>}
                  {!isMobile && <div style={{ minWidth: 0, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.service || '—'}</div>}
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {days.length ? days.map((d) => (
                      <span key={d} style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: '#1f7a4d', background: '#eef5f0', border: '1px solid #d6e6dc', padding: '1px 5px', borderRadius: 4 }}>{DAY_ABBR[d]}</span>
                    )) : <span style={{ fontSize: 11.5, color: '#c08a2e' }}>None</span>}
                  </div>
                  {!isMobile && <div style={{ color: '#7c8a82', fontSize: 12 }}>{freqLabel(p.frequency)}</div>}
                  <div style={{ textAlign: 'right' }}>
                    {sel ? (
                      <button onClick={(e) => { e.stopPropagation(); openEdit(p) }} style={editBtn}>Edit days</button>
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
          </form>
        </div>
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
