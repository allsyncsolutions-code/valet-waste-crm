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
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const orderDays = (days) => DAY_ORDER.filter((d) => (days || []).includes(d))
const initialsOf = (name) =>
  (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

export default function Schedule({ app }) {
  const isMobile = app.isMobile
  const [pickups, setPickups] = useState([]) // one row per property
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [search, setSearch] = useState('')
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState({ days: [], frequency: 'weekly' })
  const [saving, setSaving] = useState(false)

  async function refresh() {
    setPickups(await loadPropertyPickups())
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
  }, [])

  const q = search.toLowerCase().trim()
  const filtered = useMemo(
    () => (q ? pickups.filter((p) => (p.customerName + ' ' + p.address + ' ' + p.service).toLowerCase().includes(q)) : pickups),
    [pickups, q]
  )

  // A property appears under EACH day it runs; ones with no day go to "Unscheduled".
  const groups = useMemo(() => {
    const byDay = {}
    const none = []
    for (const p of filtered) {
      const days = orderDays(p.days)
      if (!days.length) { none.push(p); continue }
      for (const d of days) (byDay[d] = byDay[d] || []).push(p)
    }
    const ordered = DAY_ORDER.filter((d) => byDay[d]).map((d) => ({ key: d, label: cap(d), items: byDay[d] }))
    if (none.length) ordered.push({ key: 'none', label: 'Unscheduled', items: none })
    return ordered
  }, [filtered])

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

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by client, address or service…" style={searchInput} />
          <div style={searchIcon}>⌕</div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11.5, color: '#7c8a82', flex: 'none' }}>{scheduledCount} scheduled · {pickups.length} addresses</div>
      </div>
      <div style={{ fontSize: 12, color: '#7c8a82', margin: '0 2px 14px' }}>
        Pickup days live on each address — an address can run more than one day a week. Set them here or from a client’s property list.
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

      {!loading && !!pickups.length && !filtered.length && <div style={empty}>No addresses match “{search}”.</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {groups.map((g) => (
          <div key={g.key}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '0 2px 8px' }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '.1em', color: g.key === 'none' ? '#c08a2e' : '#1f7a4d', fontWeight: 600 }}>{g.label.toUpperCase()}</div>
              <div style={{ flex: 1, height: 1, background: '#e6eae6' }} />
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>{g.items.length}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
              {g.items.map((p) => (
                <div key={p.id + g.key} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '13px 15px', opacity: p.customerStatus === 'paused' ? 0.6 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                    <div style={{ width: 36, height: 36, flex: 'none', borderRadius: 9, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 12 }}>{initialsOf(p.customerName)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.address || p.name}</div>
                      <div style={{ fontSize: 11.5, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.customerName}{p.service ? ' · ' + p.service : ''}</div>
                    </div>
                    <span style={{ flex: 'none', fontFamily: MONO, fontSize: 10, color: '#1f7a4d', background: '#e7f1eb', padding: '2px 8px', borderRadius: 6 }}>{freqLabel(p.frequency)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11 }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {orderDays(p.days).map((d) => (
                        <span key={d} style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: '#1f7a4d', background: '#eef5f0', border: '1px solid #d6e6dc', padding: '2px 6px', borderRadius: 5 }}>{DAY_ABBR[d]}</span>
                      ))}
                      {!orderDays(p.days).length && <span style={{ fontSize: 11.5, color: '#c08a2e' }}>No pickup day</span>}
                    </div>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => openEdit(p)} style={miniBtn}>Edit days</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

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
const miniBtn = { background: '#f3f5f2', border: '1px solid #e6eae6', borderRadius: 7, padding: '5px 11px', fontSize: 12, fontWeight: 600, color: '#5d6b63', cursor: 'pointer' }
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }
const modal = { width: 460, maxWidth: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }
const cancelBtn = { flex: 'none', background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const primaryBtn = { flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const searchInput = { width: '100%', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '9px 12px 9px 32px', fontSize: 16, outline: 'none', boxSizing: 'border-box' }
const searchIcon = { position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e' }
