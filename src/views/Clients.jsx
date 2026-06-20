import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { loadCustomers, createClient, subscribeCustomers, attachTag, detachTag, deleteClient } from '../lib/customersData.js'
import { listTags, findOrCreateTag, subscribeTags } from '../lib/tagsData.js'

const FREQ = [
  ['weekly', 'Weekly'],
  ['biweekly', 'Every 2 weeks'],
  ['monthly', 'Monthly'],
  ['1st_3rd', '1st & 3rd week'],
  ['2nd_4th', '2nd & 4th week'],
  ['on_call', 'On call'],
]
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const CADENCE = [
  ['monthly', 'Monthly batch'],
  ['per_service', 'Per service'],
  ['weekly', 'Weekly'],
  ['quarterly', 'Quarterly'],
  ['annual', 'Annual'],
]
const STATUS = ['active', 'paused', 'prospect']

const freqLabel = (f) => (FREQ.find((x) => x[0] === f) || [f, f])[1]
const cadenceLabel = (c) => (CADENCE.find((x) => x[0] === c) || [c, c])[1]
const initialsOf = (name) =>
  (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

const BLANK = {
  name: '', address: '', contactName: '', email: '', phone: '', status: 'active', notes: '',
  service: '', frequency: 'weekly', dayOfWeek: 'monday',
  cadence: 'monthly', amount: '',
}

export default function Clients({ app }) {
  const isMobile = app.isMobile
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [selId, setSelId] = useState(null)
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [tagInput, setTagInput] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [allTags, setAllTags] = useState([])

  async function refresh() {
    const rows = await loadCustomers()
    setCustomers(rows)
    setSelId((cur) => cur || (rows[0] && rows[0].id) || null)
  }

  useEffect(() => {
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    const reloadTags = () => listTags().then(setAllTags).catch(() => {})
    reloadTags()
    const unsubC = subscribeCustomers(() => refresh().catch(() => {}))
    const unsubT = subscribeTags(reloadTags)
    return () => { unsubC && unsubC(); unsubT && unsubT() }
  }, [])

  const q = search.toLowerCase().trim()
  const list = useMemo(
    () => (q ? customers.filter((c) => (c.name + ' ' + c.address).toLowerCase().includes(q)) : customers),
    [customers, q]
  )
  const cur = customers.find((c) => c.id === selId) || null
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  async function addTag() {
    const t = tagInput.trim()
    if (!cur || !t) return
    setTagInput('')
    if (cur.tags.some((x) => x.name.toLowerCase() === t.toLowerCase())) return
    try {
      const tag = await findOrCreateTag(t)
      if (!tag) return
      setCustomers((cs) => cs.map((c) => (c.id === cur.id ? { ...c, tags: [...c.tags, tag] } : c)))
      await attachTag(cur.id, tag.id)
    } catch (e) {
      setErr(e.message || String(e))
      refresh().catch(() => {})
    }
  }
  async function removeTag(tag) {
    if (!cur) return
    setCustomers((cs) => cs.map((c) => (c.id === cur.id ? { ...c, tags: c.tags.filter((x) => x.id !== tag.id) } : c)))
    try {
      await detachTag(cur.id, tag.id)
    } catch (e) {
      setErr(e.message || String(e))
      refresh().catch(() => {})
    }
  }
  async function doDelete() {
    if (!cur) return
    const id = cur.id
    try {
      await deleteClient(id)
      setConfirmDelete(false)
      setCustomers((cs) => cs.filter((c) => c.id !== id))
      setSelId(null)
    } catch (e) {
      setErr(e.message || String(e))
    }
  }

  async function submit(e) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    setErr(null)
    try {
      const id = await createClient({
        name: form.name.trim(),
        address: form.address.trim(),
        contactName: form.contactName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        status: form.status,
        notes: form.notes.trim(),
        pickup: { service: form.service.trim(), frequency: form.frequency, dayOfWeek: form.frequency === 'on_call' ? null : form.dayOfWeek },
        invoice: { cadence: form.cadence, amount: form.amount === '' ? null : Number(form.amount) },
      })
      setShowForm(false)
      setForm(BLANK)
      await refresh()
      setSelId(id)
    } catch (e2) {
      setErr(e2.message || String(e2))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1.25fr', gap: 18 }}>
      {/* list */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 8 }}>
        <div style={{ display: 'flex', gap: 8, margin: '6px 6px 8px' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" style={searchInput} />
            <div style={searchIcon}>⌕</div>
          </div>
          <button onClick={() => { setForm(BLANK); setShowForm(true) }} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '0 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>+ Add</button>
        </div>

        {loading && <div style={empty}>Loading…</div>}
        {!loading && !customers.length && <div style={empty}>No clients yet. Add one with the button above, or ask Trashy Randy.</div>}

        {list.map((c) => {
          const on = c.id === selId
          return (
            <div key={c.id} onClick={() => { setSelId(c.id); setConfirmDelete(false); setTagInput('') }} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 10px', borderRadius: 10, cursor: 'pointer', marginBottom: 2, background: on ? '#f3faf5' : '#fff', border: `1px solid ${on ? '#cfe0d5' : 'transparent'}` }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 12, flex: 'none' }}>{initialsOf(c.name)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                <div style={{ fontSize: 11, color: '#7c8a82' }}>{c.pickup ? freqLabel(c.pickup.frequency) : 'No schedule'}</div>
              </div>
              {c.status !== 'active' && <span style={{ flex: 'none', fontFamily: MONO, fontSize: 9, color: '#b07a1e', background: '#fdf2e0', padding: '1px 6px', borderRadius: 5 }}>{c.status}</span>}
            </div>
          )
        })}
      </div>

      {/* detail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5 }}>{err}</div>}

        {!cur && !loading && (
          <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 13, padding: '40px 22px', textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>
            Select a client, or add your first one.
          </div>
        )}

        {cur && (
          <>
            <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                <div style={{ width: 48, height: 48, borderRadius: 11, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 15, flex: 'none' }}>{initialsOf(cur.name)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 18 }}>{cur.name}</div>
                  <div style={{ fontSize: 12.5, color: '#7c8a82' }}>{cur.address || 'No address'}</div>
                </div>
                <button onClick={app.openAssistant} style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>✦ Ask AI</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginTop: 16 }}>
                <Stat label="Pickup" value={cur.pickup ? `${freqLabel(cur.pickup.frequency)}${cur.pickup.dayOfWeek ? ' · ' + cap(cur.pickup.dayOfWeek) : ''}` : '—'} />
                <Stat label="Billing" value={cur.invoice ? cadenceLabel(cur.invoice.cadence) : '—'} />
                <Stat label="Rate" value={cur.invoice && cur.invoice.amount != null ? `$${Number(cur.invoice.amount).toFixed(2)}` : '—'} mono />
              </div>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Tags</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
                {cur.tags.map((t) => (
                  <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.color, background: t.color + '1a', border: '1px solid ' + t.color + '55', borderRadius: 20, padding: '4px 10px' }}>
                    {t.name}
                    <span onClick={() => removeTag(t)} title="Remove tag" style={{ cursor: 'pointer', opacity: 0.7, fontWeight: 600 }}>×</span>
                  </span>
                ))}
                {!cur.tags.length && <span style={{ fontSize: 12, color: '#9aa69e' }}>No tags yet.</span>}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); addTag() }} style={{ display: 'flex', gap: 8 }}>
                <input list="tag-options" value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="Add or pick a tag…" style={{ ...inp, flex: 1 }} />
                <datalist id="tag-options">
                  {allTags.filter((a) => !cur.tags.some((ct) => ct.id === a.id)).map((a) => <option key={a.id} value={a.name} />)}
                </datalist>
                <button type="submit" style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '0 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Add</button>
              </form>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Details</div>
              <Row label="Service" value={cur.pickup?.service || '—'} />
              <Row label="Contact" value={cur.contactName || '—'} />
              <Row label="Email" value={cur.email || '—'} />
              <Row label="Phone" value={cur.phone || '—'} />
              <Row label="Status" value={cap(cur.status)} />
              {cur.notes && <Row label="Notes" value={cur.notes} />}
            </div>

            {confirmDelete ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fdecea', border: '1px solid #f3b7b0', borderRadius: 11, padding: '12px 14px' }}>
                <div style={{ flex: 1, fontSize: 12.5, color: '#9a2c1e' }}>Delete {cur.name} and its schedules? This can’t be undone.</div>
                <button onClick={() => setConfirmDelete(false)} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                <button onClick={doDelete} style={{ background: '#c0492f', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} style={{ alignSelf: 'flex-start', background: '#fff', border: '1px solid #f0c9c2', color: '#c0492f', borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Delete client</button>
            )}
          </>
        )}
      </div>

      {showForm && (
        <div onClick={() => !saving && setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ width: 520, maxWidth: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Add client</div>
            <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 16 }}>Creates the customer plus a pickup schedule and invoice schedule.</div>

            <Field label="Business name *"><input autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} style={inp} placeholder="Acme Property Group" /></Field>
            <Field label="Address"><input value={form.address} onChange={(e) => set({ address: e.target.value })} style={inp} placeholder="123 Main St" /></Field>
            <div style={twoCol}>
              <Field label="Contact"><input value={form.contactName} onChange={(e) => set({ contactName: e.target.value })} style={inp} /></Field>
              <Field label="Phone"><input value={form.phone} onChange={(e) => set({ phone: e.target.value })} style={inp} /></Field>
            </div>
            <Field label="Email"><input value={form.email} onChange={(e) => set({ email: e.target.value })} style={inp} type="email" /></Field>

            <Divider>Pickup schedule</Divider>
            <Field label="Service"><input value={form.service} onChange={(e) => set({ service: e.target.value })} style={inp} placeholder="4yd dumpster x2" /></Field>
            <div style={twoCol}>
              <Field label="Frequency">
                <select value={form.frequency} onChange={(e) => set({ frequency: e.target.value })} style={inp}>
                  {FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Day">
                <select value={form.dayOfWeek} onChange={(e) => set({ dayOfWeek: e.target.value })} style={inp} disabled={form.frequency === 'on_call'}>
                  {DAYS.map((d) => <option key={d} value={d}>{cap(d)}</option>)}
                </select>
              </Field>
            </div>

            <Divider>Invoice schedule</Divider>
            <div style={twoCol}>
              <Field label="Cadence">
                <select value={form.cadence} onChange={(e) => set({ cadence: e.target.value })} style={inp}>
                  {CADENCE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Rate ($)"><input value={form.amount} onChange={(e) => set({ amount: e.target.value })} style={inp} type="number" step="0.01" placeholder="optional" /></Field>
            </div>
            <Field label="Status">
              <select value={form.status} onChange={(e) => set({ status: e.target.value })} style={inp}>
                {STATUS.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
              </select>
            </Field>

            <div style={{ display: 'flex', gap: 9, marginTop: 18 }}>
              <button type="button" onClick={() => setShowForm(false)} disabled={saving} style={{ flex: 'none', background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button type="submit" disabled={saving || !form.name.trim()} style={{ flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving || !form.name.trim() ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Create client'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

function Stat({ label, value, mono }) {
  return (
    <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '11px 13px' }}>
      <div style={{ fontSize: 11, color: '#7c8a82' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13, marginTop: 3, fontFamily: mono ? MONO : 'inherit' }}>{value}</div>
    </div>
  )
}
function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderTop: '1px solid #f0f2ef' }}>
      <div style={{ width: 90, flex: 'none', fontSize: 12, color: '#9aa69e' }}>{label}</div>
      <div style={{ fontSize: 13 }}>{value}</div>
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
function Divider({ children }) {
  return <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', margin: '6px 0 12px', paddingTop: 12, borderTop: '1px solid #eef0ed' }}>{String(children).toUpperCase()}</div>
}

const twoCol = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }
const inp = { width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '9px 11px', fontSize: 15, outline: 'none', boxSizing: 'border-box' }
const empty = { padding: '22px 14px', textAlign: 'center', color: '#9aa69e', fontSize: 12.5 }

export const searchInput = { width: '100%', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '9px 12px 9px 32px', fontSize: 16, outline: 'none', boxSizing: 'border-box' }
export const searchIcon = { position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e' }
