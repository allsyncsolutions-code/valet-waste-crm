import { useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { freqLabel } from '../lib/schedulesData.js'

const DAY_ABBR = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' }

// Bulk review popup for paused addresses (the "what do we do with these?"
// flow): multi-select rows, then resume, remove, tie untied ones to an
// existing client, or create a brand-new contact and tie them to it.
export default function PausedReview({ paused, customers, busy, onResume, onRemove, onAssign, onCreateAndAssign, onClose }) {
  const [selected, setSelected] = useState(() => new Set(paused.map((p) => p.id)))
  const [filter, setFilter] = useState('')
  const [tieCustomerId, setTieCustomerId] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ name: '', contactName: '', phone: '', email: '' })

  const q = filter.toLowerCase().trim()
  const rows = useMemo(
    () => (q ? paused.filter((p) => (p.customerName + ' ' + p.address + ' ' + p.service).toLowerCase().includes(q)) : paused),
    [paused, q]
  )
  const allSelected = rows.length > 0 && rows.every((p) => selected.has(p.id))
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) rows.forEach((p) => next.delete(p.id))
      else rows.forEach((p) => next.add(p.id))
      return next
    })
  const toggleOne = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const sel = paused.filter((p) => selected.has(p.id))
  const untiedSel = sel.filter((p) => !p.customerId)
  const tiedSel = sel.filter((p) => p.customerId)
  const activeCustomers = customers.filter((c) => c.status !== 'archived')
  const canCreate = form.name.trim().length > 1

  return (
    <div onClick={() => !busy && onClose()} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
          <div style={{ fontWeight: 700, fontSize: 16, flex: 1 }}>Review paused addresses</div>
          <button onClick={onClose} disabled={busy} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#7c8a82', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 14 }}>
          Pick what happens to old stops: resume them onto routes, remove them for good, or tie addresses that aren't attached to anyone to a client.
        </div>

        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by client, address or service…" style={{ ...inp, marginBottom: 10, fontSize: 13.5 }} />

        <div style={{ border: '1px solid #e6eae6', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px', background: '#f7f9f7', borderBottom: '1px solid #e6eae6', fontFamily: MONO, fontSize: 10, letterSpacing: '.06em', color: '#7c8a82' }}>
            <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ cursor: 'pointer' }} />
            <div style={{ flex: 1 }}>ADDRESS · CLIENT</div>
            <div style={{ flex: 'none', width: 96, textAlign: 'right' }}>DAYS · FREQ</div>
          </div>
          <div style={{ maxHeight: '38vh', overflowY: 'auto' }}>
            {rows.map((p) => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px', borderBottom: '1px solid #f1f3f0', cursor: 'pointer', background: selected.has(p.id) ? '#f4f9f5' : '#fff', fontSize: 12.5 }}>
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} style={{ cursor: 'pointer' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.address || p.name}</div>
                  <div style={{ fontSize: 11, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.customerId ? p.customerName : <span style={{ color: '#c0492f', fontWeight: 600 }}>⚠ not tied to a client</span>}
                    {p.service ? ` · ${p.service}` : ''}
                  </div>
                </div>
                <div style={{ flex: 'none', width: 96, textAlign: 'right', fontFamily: MONO, fontSize: 10, color: '#7c8a82' }}>
                  {(p.days || []).slice(0, 3).map((d) => DAY_ABBR[d]).join(' ') || '—'} · {freqLabel(p.frequency)}
                </div>
              </label>
            ))}
            {!rows.length && <div style={{ padding: '18px 12px', textAlign: 'center', color: '#9aa69e', fontSize: 12 }}>No paused addresses match “{filter}”.</div>}
          </div>
        </div>

        {/* Tie untied selection to a client */}
        {untiedSel.length > 0 && (
          <div style={{ marginTop: 12, background: '#fbf6e7', border: '1px solid #e8d79a', borderRadius: 10, padding: '11px 13px' }}>
            <div style={{ fontSize: 12, color: '#6d5711', marginBottom: 8, fontWeight: 600 }}>
              {untiedSel.length} selected {untiedSel.length === 1 ? 'address isn’t' : 'addresses aren’t'} tied to a client — who do they belong to?
            </div>
            {!showNew ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select value={tieCustomerId} onChange={(e) => setTieCustomerId(e.target.value)} style={{ ...inp, flex: 1, minWidth: 180, fontSize: 13 }}>
                  <option value="">Pick an existing client…</option>
                  {activeCustomers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button
                  onClick={() => onAssign(untiedSel.map((p) => p.id), tieCustomerId)}
                  disabled={busy || !tieCustomerId}
                  style={{ ...smallBtn, background: '#8a6d1e', color: '#fff', border: 'none', opacity: busy || !tieCustomerId ? 0.5 : 1 }}
                >
                  Tie to client
                </button>
                <button onClick={() => setShowNew(true)} disabled={busy} style={{ ...smallBtn, background: '#fff', color: '#8a6d1e', border: '1px solid #e8d79a' }}>
                  ＋ New contact
                </button>
              </div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Client / company name *" style={{ ...inp, fontSize: 13 }} />
                  <input value={form.contactName} onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))} placeholder="Contact person" style={{ ...inp, fontSize: 13 }} />
                  <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="Phone" style={{ ...inp, fontSize: 13 }} />
                  <input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="Email" style={{ ...inp, fontSize: 13 }} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setShowNew(false)} disabled={busy} style={{ ...smallBtn, background: '#fff', color: '#5d6b63', border: '1px solid #dde2dd' }}>Back</button>
                  <button
                    onClick={() => onCreateAndAssign(untiedSel.map((p) => p.id), form)}
                    disabled={busy || !canCreate}
                    style={{ ...smallBtn, background: '#8a6d1e', color: '#fff', border: 'none', opacity: busy || !canCreate ? 0.5 : 1 }}
                  >
                    {busy ? 'Creating…' : `Create contact & tie ${untiedSel.length} ${untiedSel.length === 1 ? 'address' : 'addresses'}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Bulk actions */}
        <div style={{ display: 'flex', gap: 9, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => onResume(sel.map((p) => p.id))}
            disabled={busy || !sel.length}
            style={{ ...actionBtn, background: '#1f7a4d', color: '#fff', border: 'none', opacity: busy || !sel.length ? 0.5 : 1 }}
          >
            ▶ Resume {sel.length || ''}
          </button>
          <button
            onClick={() => onRemove(sel.map((p) => p.id))}
            disabled={busy || !sel.length}
            style={{ ...actionBtn, background: '#fff', color: '#c0492f', border: '1px solid #f3b7b0', opacity: busy || !sel.length ? 0.5 : 1 }}
          >
            🗑 Remove {sel.length || ''}
          </button>
          <span style={{ flex: 1, fontSize: 11, color: '#9aa69e', textAlign: 'right' }}>
            {tiedSel.length ? `${tiedSel.length} tied · ` : ''}{untiedSel.length ? `${untiedSel.length} untied` : ''}
            {busy ? ' · working…' : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

const inp = { width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '8px 10px', fontSize: 14, outline: 'none', boxSizing: 'border-box' }
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto' }
const modal = { width: 640, maxWidth: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }
const smallBtn = { cursor: 'pointer', borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600 }
const actionBtn = { cursor: 'pointer', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 700 }
