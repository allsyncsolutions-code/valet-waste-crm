import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { hasSupabase } from '../lib/supabaseClient.js'
import { loadCustomers } from '../lib/customersData.js'
import {
  loadSchedules,
  createSchedule,
  updateSchedule,
  toggleScheduleActive,
  deleteSchedule,
  subscribeSchedules,
  FREQUENCIES,
  DAYS,
  freqLabel,
} from '../lib/schedulesData.js'

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const initialsOf = (name) =>
  (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

const BLANK = { customerId: '', service: '', frequency: 'weekly', dayOfWeek: 'monday', startDate: '', notes: '', active: true }

export default function Schedule({ app }) {
  const isMobile = app.isMobile
  const [schedules, setSchedules] = useState([])
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(BLANK)

  async function refresh() {
    const rows = await loadSchedules()
    setSchedules(rows)
  }

  useEffect(() => {
    if (!hasSupabase) {
      setErr('Supabase env vars not set — check .env.local')
      setLoading(false)
      return
    }
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    loadCustomers().then(setCustomers).catch(() => {})
    const unsub = subscribeSchedules(() => {
      refresh().catch(() => {})
      loadCustomers().then(setCustomers).catch(() => {})
    })
    return () => unsub && unsub()
  }, [])

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const q = search.toLowerCase().trim()
  const filtered = useMemo(
    () => (q ? schedules.filter((s) => (s.customerName + ' ' + s.service + ' ' + s.customerAddress).toLowerCase().includes(q)) : schedules),
    [schedules, q]
  )

  // Group by pickup day; on-call / no day go in their own bucket.
  const groups = useMemo(() => {
    const byDay = {}
    const other = []
    for (const s of filtered) {
      if (s.frequency === 'on_call' || !s.dayOfWeek) other.push(s)
      else (byDay[s.dayOfWeek] = byDay[s.dayOfWeek] || []).push(s)
    }
    const ordered = DAY_ORDER.filter((d) => byDay[d]).map((d) => ({ key: d, label: cap(d), items: byDay[d] }))
    if (other.length) ordered.push({ key: 'other', label: 'On-call / unscheduled', items: other })
    return ordered
  }, [filtered])

  const activeCount = schedules.filter((s) => s.active).length

  function openAdd() {
    setEditId(null)
    setForm({ ...BLANK, customerId: customers[0]?.id || '' })
    setShowForm(true)
  }
  function openEdit(s) {
    setEditId(s.id)
    setForm({
      customerId: s.customerId,
      service: s.service,
      frequency: s.frequency,
      dayOfWeek: s.dayOfWeek || 'monday',
      startDate: s.startDate || '',
      notes: s.notes,
      active: s.active,
    })
    setShowForm(true)
  }

  async function onToggle(s) {
    setSchedules((cur) => cur.map((x) => (x.id === s.id ? { ...x, active: !x.active } : x)))
    try {
      await toggleScheduleActive(s.id, !s.active)
    } catch (e) {
      setErr(e.message || String(e))
      refresh().catch(() => {})
    }
  }
  async function onDelete(s) {
    if (!window.confirm(`Delete ${s.customerName}'s pickup schedule?`)) return
    setSchedules((cur) => cur.filter((x) => x.id !== s.id))
    try {
      await deleteSchedule(s.id)
    } catch (e) {
      setErr(e.message || String(e))
      refresh().catch(() => {})
    }
  }

  async function submit(e) {
    e.preventDefault()
    if (!form.customerId) {
      setErr('Pick a customer for this schedule.')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      if (editId) await updateSchedule(editId, form)
      else await createSchedule({ ...form, customerName: customers.find((c) => c.id === form.customerId)?.name })
      setShowForm(false)
      await refresh()
    } catch (e2) {
      setErr(e2.message || String(e2))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by customer, service or address…" style={searchInput} />
          <div style={searchIcon}>⌕</div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11.5, color: '#7c8a82', flex: 'none' }}>{activeCount} active · {schedules.length} total</div>
        <button onClick={openAdd} disabled={!customers.length} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: customers.length ? 'pointer' : 'default', opacity: customers.length ? 1 : 0.5 }} title={customers.length ? '' : 'Add a client first'}>+ Add schedule</button>
      </div>

      {err && <div style={errorBox}>{err}</div>}

      {loading && <div style={empty}>Loading schedules…</div>}
      {!loading && !schedules.length && (
        <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 13, padding: '44px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>▤</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 5 }}>No pickup schedules yet</div>
          <div style={{ fontSize: 13, color: '#7c8a82', marginBottom: 16 }}>{customers.length ? 'Add a recurring pickup for one of your clients.' : 'Add a client first — schedules attach to a customer.'}</div>
          {!!customers.length && <button onClick={openAdd} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>+ Add schedule</button>}
        </div>
      )}

      {!loading && !!schedules.length && !filtered.length && <div style={empty}>No schedules match “{search}”.</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {groups.map((g) => (
          <div key={g.key}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '0 2px 8px' }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '.1em', color: '#1f7a4d', fontWeight: 600 }}>{g.label.toUpperCase()}</div>
              <div style={{ flex: 1, height: 1, background: '#e6eae6' }} />
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>{g.items.length}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
              {g.items.map((s) => (
                <div key={s.id} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '13px 15px', opacity: s.active ? 1 : 0.62 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                    <div style={{ width: 36, height: 36, flex: 'none', borderRadius: 9, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 12 }}>{initialsOf(s.customerName)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.customerName}</div>
                      <div style={{ fontSize: 11.5, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.service || 'No service noted'}</div>
                    </div>
                    <span style={{ flex: 'none', fontFamily: MONO, fontSize: 10, color: '#1f7a4d', background: '#e7f1eb', padding: '2px 8px', borderRadius: 6 }}>{freqLabel(s.frequency)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11 }}>
                    <button onClick={() => onToggle(s)} style={{ ...pillBtn, color: s.active ? '#1f7a4d' : '#9aa69e', borderColor: s.active ? '#cfe0d5' : '#e0e4df' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.active ? '#22b06b' : '#c2cabf', display: 'inline-block' }} /> {s.active ? 'Active' : 'Paused'}
                    </button>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => openEdit(s)} style={miniBtn}>Edit</button>
                    <button onClick={() => onDelete(s)} style={{ ...miniBtn, color: '#c0492f' }}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div onClick={() => !saving && setShowForm(false)} style={overlay}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submit} style={modal}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{editId ? 'Edit schedule' : 'Add pickup schedule'}</div>
            <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 16 }}>A recurring pickup attached to a customer.</div>

            <Field label="Customer *">
              <select value={form.customerId} onChange={(e) => set({ customerId: e.target.value })} style={inp} disabled={!!editId}>
                <option value="">Select a customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Service"><input value={form.service} onChange={(e) => set({ service: e.target.value })} style={inp} placeholder="4yd dumpster x2" /></Field>
            <div style={twoCol}>
              <Field label="Frequency">
                <select value={form.frequency} onChange={(e) => set({ frequency: e.target.value })} style={inp}>
                  {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Day">
                <select value={form.dayOfWeek} onChange={(e) => set({ dayOfWeek: e.target.value })} style={inp} disabled={form.frequency === 'on_call'}>
                  {DAYS.map((d) => <option key={d} value={d}>{cap(d)}</option>)}
                </select>
              </Field>
            </div>
            <div style={twoCol}>
              <Field label="Start date"><input value={form.startDate || ''} onChange={(e) => set({ startDate: e.target.value })} style={inp} type="date" /></Field>
              <Field label="Status">
                <select value={form.active ? 'active' : 'paused'} onChange={(e) => set({ active: e.target.value === 'active' })} style={inp}>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                </select>
              </Field>
            </div>
            <Field label="Notes"><input value={form.notes} onChange={(e) => set({ notes: e.target.value })} style={inp} placeholder="Gate code, access notes…" /></Field>

            <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
              <button type="button" onClick={() => setShowForm(false)} disabled={saving} style={cancelBtn}>Cancel</button>
              <button type="submit" disabled={saving || !form.customerId} style={{ ...primaryBtn, opacity: saving || !form.customerId ? 0.6 : 1 }}>{saving ? 'Saving…' : editId ? 'Save changes' : 'Create schedule'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 11 }}>
      <div style={{ fontSize: 11.5, color: '#5d6b63', marginBottom: 5, fontWeight: 500 }}>{label}</div>
      {children}
    </label>
  )
}

const twoCol = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }
const inp = { width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '9px 11px', fontSize: 15, outline: 'none', boxSizing: 'border-box' }
const empty = { padding: '22px 14px', textAlign: 'center', color: '#9aa69e', fontSize: 12.5 }
const errorBox = { marginBottom: 14, background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5 }
const miniBtn = { background: '#f3f5f2', border: '1px solid #e6eae6', borderRadius: 7, padding: '5px 11px', fontSize: 12, fontWeight: 600, color: '#5d6b63', cursor: 'pointer' }
const pillBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #cfe0d5', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }
const modal = { width: 480, maxWidth: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }
const cancelBtn = { flex: 'none', background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const primaryBtn = { flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const searchInput = { width: '100%', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '9px 12px 9px 32px', fontSize: 16, outline: 'none', boxSizing: 'border-box' }
const searchIcon = { position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e' }
