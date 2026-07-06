import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { loadCustomers, createClient, updateCustomer, subscribeCustomers, attachTag, detachTag, deleteClient, loadProperties, addProperty, updateProperty, loadPropertyVisits, countDuplicateProperties, findDuplicateProperties, mergeProperties, deleteProperty } from '../lib/customersData.js'
import { geocodeAll } from '../lib/importData.js'
import { listTags, findOrCreateTag, subscribeTags } from '../lib/tagsData.js'
import { stripeStatus, stripePaymentLink } from '../lib/stripeData.js'
import { loadPropertyPhotos, uploadPropertyPhoto, updatePropertyPhoto, deletePropertyPhoto } from '../lib/propertyPhotosData.js'

const todayStr = () => new Date().toISOString().slice(0, 10)
const fmtDay = (d) => { try { return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return d } }

const FREQ = [
  ['weekly', 'Weekly'],
  ['biweekly', 'Every 2 weeks'],
  ['monthly', 'Monthly'],
  ['1st_3rd', '1st & 3rd week'],
  ['2nd_4th', '2nd & 4th week'],
  ['on_call', 'On call'],
]
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const DAY_ABBR = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' }
// Order a property's days Mon→Sun for display.
const orderDays = (days) => DAYS.filter((d) => (days || []).includes(d))
const daysLabel = (days) => orderDays(days).map((d) => DAY_ABBR[d]).join(' · ')
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
const fmtDate = (ts) => { try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return ts } }
const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) } catch { return ts } }

const BLANK = {
  name: '', address: '', contactName: '', email: '', phone: '', status: 'active', notes: '',
  service: '', frequency: 'weekly', dayOfWeek: 'monday',
  cadence: 'monthly', amount: '',
}
const BLANK_PROP = { address: '', service: '', notes: '', price: '', techPay: '', days: [], frequency: 'weekly' }

export default function Clients({ app }) {
  const isMobile = app.isMobile
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [selId, setSelId] = useState(null)
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [tagInput, setTagInput] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [allTags, setAllTags] = useState([])
  const [stripeOk, setStripeOk] = useState(false)
  const [payLink, setPayLink] = useState(null)
  const [payBusy, setPayBusy] = useState(false)
  const [payErr, setPayErr] = useState(null)
  const [props, setProps] = useState([])
  const [editPid, setEditPid] = useState(null)
  const [editP, setEditP] = useState({ address: '', service: '', notes: '', price: '', techPay: '', days: [], frequency: 'weekly' })
  const [addingAddr, setAddingAddr] = useState(false)
  const [newP, setNewP] = useState(BLANK_PROP)
  const [pBusy, setPBusy] = useState(false)
  const [histPid, setHistPid] = useState(null)
  const [hist, setHist] = useState([])
  const [histBusy, setHistBusy] = useState(false)
  const [photoPid, setPhotoPid] = useState(null)
  const [photos, setPhotos] = useState([])
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoDate, setPhotoDate] = useState(todayStr())
  const [photoNote, setPhotoNote] = useState('')
  const [dupCount, setDupCount] = useState(0)
  const [dupOpen, setDupOpen] = useState(false)
  const [dupGroups, setDupGroups] = useState(null)
  const [dupBusy, setDupBusy] = useState(false)

  // Load the selected client's service properties.
  useEffect(() => {
    if (!selId) { setProps([]); return }
    let alive = true
    loadProperties(selId).then((r) => { if (alive) setProps(r) }).catch(() => { if (alive) setProps([]) })
    return () => { alive = false }
  }, [selId, customers])

  async function refresh() {
    const rows = await loadCustomers()
    setCustomers(rows)
    setSelId((cur) => cur || (rows[0] && rows[0].id) || null)
  }

  useEffect(() => {
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    const reloadTags = () => listTags().then(setAllTags).catch(() => {})
    reloadTags()
    countDuplicateProperties().then(setDupCount).catch(() => {})
    stripeStatus().then((d) => setStripeOk(!!(d && d.connected && d.chargesEnabled))).catch(() => {})
    const unsubC = subscribeCustomers(() => refresh().catch(() => {}))
    const unsubT = subscribeTags(reloadTags)
    return () => { unsubC && unsubC(); unsubT && unsubT() }
  }, [])

  async function toggleDuplicates() {
    if (dupOpen) { setDupOpen(false); return }
    setDupOpen(true)
    if (dupGroups == null && !dupBusy) {
      setDupBusy(true)
      try { setDupGroups(await findDuplicateProperties()) }
      catch (e) { setErr(e.message || String(e)) }
      finally { setDupBusy(false) }
    }
  }
  async function refreshDuplicates() {
    try {
      const [g, c] = await Promise.all([findDuplicateProperties(), countDuplicateProperties()])
      setDupGroups(g); setDupCount(c)
    } catch (e) { setErr(e.message || String(e)) }
    if (selId) loadProperties(selId).then(setProps).catch(() => {})
  }
  async function mergeGroup(keepProp, group) {
    if (dupBusy) return
    const removeIds = group.properties.filter((p) => p.id !== keepProp.id).map((p) => p.id)
    if (!removeIds.length) return
    if (!window.confirm(`Merge ${removeIds.length + 1} copies of "${keepProp.address}" into one?\n\nThe kept copy gets every pickup day from all copies and is flagged "Needs review". The other ${removeIds.length} ${removeIds.length === 1 ? 'copy is' : 'copies are'} deleted.`)) return
    setDupBusy(true)
    try { await mergeProperties(keepProp.id, removeIds); await refreshDuplicates() }
    catch (e) { setErr(e.message || String(e)) }
    finally { setDupBusy(false) }
  }
  async function removeDup(p) {
    if (dupBusy) return
    if (!window.confirm(`Delete this copy?\n\n${p.customer_name || '(no client)'} — ${p.address}`)) return
    setDupBusy(true)
    try { await deleteProperty(p.id); await refreshDuplicates() }
    catch (e) { setErr(e.message || String(e)) }
    finally { setDupBusy(false) }
  }

  // Only clients on the active business line (legacy rows count as waste).
  const lineCustomers = useMemo(
    () => customers.filter((c) => (c.business_line || 'waste') === (app.activeLine || 'waste')),
    [customers, app.activeLine],
  )
  const q = search.toLowerCase().trim()
  const list = useMemo(
    () => (q ? lineCustomers.filter((c) => (c.name + ' ' + c.address).toLowerCase().includes(q)) : lineCustomers),
    [lineCustomers, q]
  )
  const cur = lineCustomers.find((c) => c.id === selId) || null

  // Switching business line: drop any selection from the previous line.
  useEffect(() => {
    setSelId((cur) => (customers.find((c) => c.id === cur && (c.business_line || 'waste') === (app.activeLine || 'waste')) ? cur : (customers.find((c) => (c.business_line || 'waste') === (app.activeLine || 'waste'))?.id ?? null)))
  }, [app.activeLine, customers])
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
  async function makePayLink() {
    if (!cur || !cur.invoice || cur.invoice.amount == null) return
    setPayBusy(true)
    setPayErr(null)
    setPayLink(null)
    try {
      const d = await stripePaymentLink({ amount: cur.invoice.amount, description: 'Invoice — ' + cur.name, customerName: cur.name })
      setPayLink(d.url)
    } catch (e) {
      setPayErr(e.message || String(e))
    } finally {
      setPayBusy(false)
    }
  }
  function startEditProp(p) {
    setEditPid(p.id)
    setEditP({ address: p.address || '', service: p.service || '', notes: p.notes || '', price: p.price ?? '', techPay: p.tech_pay ?? '', days: p.pickup_days || [], frequency: p.pickup_frequency || 'weekly' })
  }
  async function toggleHistory(p) {
    if (histPid === p.id) { setHistPid(null); setHist([]); return }
    setHistPid(p.id); setHist([]); setHistBusy(true)
    try { setHist(await loadPropertyVisits(p.id)) }
    catch (e) { setErr(e.message || String(e)) }
    finally { setHistBusy(false) }
  }
  async function togglePhotos(p) {
    if (photoPid === p.id) { setPhotoPid(null); setPhotos([]); return }
    setPhotoPid(p.id); setPhotos([]); setPhotoDate(todayStr()); setPhotoNote(''); setPhotoBusy(true)
    try { setPhotos(await loadPropertyPhotos(p.id)) }
    catch (e) { setErr(e.message || String(e)) }
    finally { setPhotoBusy(false) }
  }
  async function addPhotos(p, fileList) {
    const files = Array.from(fileList || [])
    if (!files.length || photoBusy) return
    setPhotoBusy(true)
    setErr(null)
    try {
      for (const f of files) {
        await uploadPropertyPhoto(p.id, f, { takenOn: photoDate || todayStr(), note: photoNote.trim() || null })
      }
      setPhotoNote('')
      setPhotos(await loadPropertyPhotos(p.id))
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setPhotoBusy(false)
    }
  }
  async function changePhotoDate(ph, takenOn) {
    if (!takenOn || takenOn === ph.takenOn) return
    setPhotos((list) => list.map((x) => (x.id === ph.id ? { ...x, takenOn } : x)))
    try { await updatePropertyPhoto(ph.id, { takenOn }) }
    catch (e) { setErr(e.message || String(e)) }
  }
  async function removePhoto(p, ph) {
    if (photoBusy) return
    setPhotoBusy(true)
    try { await deletePropertyPhoto(ph); setPhotos(await loadPropertyPhotos(p.id)) }
    catch (e) { setErr(e.message || String(e)) }
    finally { setPhotoBusy(false) }
  }
  const toggleDay = (d) =>
    setEditP((e) => ({ ...e, days: e.days.includes(d) ? e.days.filter((x) => x !== d) : [...e.days, d] }))
  const toggleNewDay = (d) =>
    setNewP((e) => ({ ...e, days: e.days.includes(d) ? e.days.filter((x) => x !== d) : [...e.days, d] }))
  // Create a new address (property) under the selected client, then geocode it.
  async function saveNewProp() {
    if (pBusy || !selId) return
    const addr = newP.address.trim()
    if (!addr) return
    setPBusy(true)
    setErr(null)
    try {
      await addProperty(selId, {
        address: addr,
        service: newP.service.trim() || null,
        notes: newP.notes.trim() || null,
        price: newP.price === '' ? null : Number(newP.price),
        tech_pay: newP.techPay === '' ? null : Number(newP.techPay),
        pickup_days: orderDays(newP.days),
        pickup_frequency: newP.frequency,
      })
      setAddingAddr(false)
      setNewP(BLANK_PROP)
      setProps(await loadProperties(selId))
      // Fill in the map pin in the background.
      geocodeAll(() => {}).then(() => loadProperties(selId).then(setProps).catch(() => {})).catch(() => {})
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setPBusy(false)
    }
  }
  async function saveProp(p) {
    if (pBusy) return
    setPBusy(true)
    setErr(null)
    try {
      const patch = {
        service: editP.service.trim(),
        notes: editP.notes.trim(),
        price: editP.price === '' || editP.price == null ? null : Number(editP.price),
        tech_pay: editP.techPay === '' || editP.techPay == null ? null : Number(editP.techPay),
        pickup_days: orderDays(editP.days),
        pickup_frequency: editP.frequency,
      }
      const addrChanged = editP.address.trim() !== (p.address || '')
      if (addrChanged) patch.address = editP.address.trim()
      await updateProperty(p.id, patch)
      setEditPid(null)
      setProps(await loadProperties(selId))
      if (addrChanged) { await geocodeAll(() => {}); setProps(await loadProperties(selId)) }
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setPBusy(false)
    }
  }

  async function toggleReview(p) {
    if (pBusy) return
    setPBusy(true)
    setErr(null)
    try {
      await updateProperty(p.id, { needs_review: !p.needs_review })
      setProps(await loadProperties(selId))
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setPBusy(false)
    }
  }

  async function doDelete() {
    if (!cur) return
    const id = cur.id
    try {
      await deleteClient(id, cur.name)
      setConfirmDelete(false)
      setCustomers((cs) => cs.filter((c) => c.id !== id))
      setSelId(null)
    } catch (e) {
      setErr(e.message || String(e))
    }
  }

  function openEdit() {
    if (!cur) return
    setForm({
      name: cur.name || '', address: cur.address || '', contactName: cur.contactName || '',
      email: cur.email || '', phone: cur.phone || '', status: cur.status || 'active', notes: cur.notes || '',
      service: cur.pickup?.service || '', frequency: cur.pickup?.frequency || 'weekly',
      dayOfWeek: cur.pickup?.dayOfWeek || 'monday',
      cadence: cur.invoice?.cadence || 'monthly', amount: cur.invoice?.amount ?? '',
    })
    setEditingId(cur.id)
    setShowForm(true)
  }

  async function submit(e) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    setErr(null)
    const payload = {
      name: form.name.trim(),
      address: form.address.trim(),
      contactName: form.contactName.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      status: form.status,
      notes: form.notes.trim(),
      pickup: { service: form.service.trim(), frequency: form.frequency, dayOfWeek: null },
      invoice: { cadence: form.cadence, amount: form.amount === '' ? null : Number(form.amount) },
    }
    try {
      if (editingId) {
        await updateCustomer(editingId, payload)
        setShowForm(false)
        setEditingId(null)
        setForm(BLANK)
        await refresh()
        setSelId(editingId)
      } else {
        const id = await createClient({ ...payload, businessLine: app.activeLine || 'waste' })
        setShowForm(false)
        setForm(BLANK)
        await refresh()
        setSelId(id)
      }
    } catch (e2) {
      setErr(e2.message || String(e2))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
    {dupCount > 0 && (
      <div style={{ background: '#fdf7f2', border: '1px solid #f0d9c8', borderRadius: 12, padding: '12px 16px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, color: '#9a3412', fontWeight: 600, flex: 1, minWidth: 0 }}>
            ⚠ {dupCount} duplicate {dupCount === 1 ? 'address' : 'addresses'} detected (same address under more than one client).
          </span>
          <button onClick={toggleDuplicates} style={{ flex: 'none', background: '#fff', color: '#9a3412', border: '1px solid #e3b48f', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            {dupOpen ? 'Hide' : 'Review duplicates'}
          </button>
        </div>
        {dupOpen && (
          <div style={{ marginTop: 12 }}>
            {dupBusy ? (
              <div style={{ fontSize: 12.5, color: '#9aa69e' }}>Loading…</div>
            ) : !dupGroups || !dupGroups.length ? (
              <div style={{ fontSize: 12.5, color: '#9aa69e' }}>No duplicates found.</div>
            ) : (
              <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {dupGroups.map((g) => (
                  <div key={g.normalized} style={{ border: '1px solid #f0d9c8', borderRadius: 9, padding: '8px 11px', background: '#fff' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 5 }}>{(g.properties[0] && g.properties[0].address) || g.normalized} <span style={{ color: '#9a3412' }}>· {g.count}×</span></div>
                    {g.properties.map((p) => (
                      <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', fontSize: 12, padding: '5px 0', borderTop: '1px solid #f7f0e8' }}>
                        <div style={{ minWidth: 0 }}>
                          <div onClick={() => p.customer_id && setSelId(p.customer_id)} title="Open this client" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#1f7a4d', cursor: p.customer_id ? 'pointer' : 'default', fontWeight: 600 }}>
                            {p.customer_name || '(no client)'} <span style={{ color: '#7c8a82', fontWeight: 400 }}>{p.price != null ? `· $${Number(p.price).toFixed(2)}` : ''}{p.needs_review ? ' ⚠' : ''}</span>
                          </div>
                          <div style={{ color: '#9aa69e', fontSize: 11 }}>{dupMeta(p)}</div>
                        </div>
                        <span style={{ flex: 'none', display: 'flex', gap: 8 }}>
                          <button onClick={() => mergeGroup(p, g)} disabled={dupBusy} title="Keep this copy, merge the others into it (combines pickup days, flags for review)" style={dupActBtn('#1f7a4d')}>Keep &amp; merge</button>
                          <button onClick={() => removeDup(p)} disabled={dupBusy} title="Delete just this copy" style={dupActBtn('#c0492f')}>Delete</button>
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    )}
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1.25fr', gap: 18 }}>
      {/* list */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 8 }}>
        <div style={{ display: 'flex', gap: 8, margin: '6px 6px 8px' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" style={searchInput} />
            <div style={searchIcon}>⌕</div>
          </div>
          <button onClick={() => { setForm(BLANK); setEditingId(null); setShowForm(true) }} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '0 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>+ Add client</button>
        </div>

        {loading && <div style={empty}>Loading…</div>}
        {!loading && !customers.length && <div style={empty}>No clients yet. Add one with the button above, or ask Trashy Randy.</div>}

        {list.map((c) => {
          const on = c.id === selId
          return (
            <div key={c.id} onClick={() => { setSelId(c.id); setConfirmDelete(false); setTagInput(''); setPayLink(null); setPayErr(null); setAddingAddr(false); setNewP(BLANK_PROP); setEditPid(null) }} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 10px', borderRadius: 10, cursor: 'pointer', marginBottom: 2, background: on ? '#f3faf5' : '#fff', border: `1px solid ${on ? '#cfe0d5' : 'transparent'}` }}>
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
                {cur.portal_slug && (
                  <button
                    onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/?portal=${cur.portal_slug}`).then(() => window.alert('Portal link copied — share it with this client. They sign in with the email on file.')).catch(() => window.prompt('Copy this portal link:', `${window.location.origin}/?portal=${cur.portal_slug}`)) }}
                    title="Copy this client's shareable portal link"
                    style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}
                  >◫ Portal link</button>
                )}
                <button onClick={openEdit} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#1a2420', borderRadius: 9, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Edit</button>
                <button onClick={app.openAssistant} style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>✦ Ask AI</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginTop: 16 }}>
                <Stat label="Pickup days" value={(() => { const ds = daysLabel([...new Set(props.flatMap((p) => p.pickup_days || []))]); return ds || '—' })()} />
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

            {(
              <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>Addresses ({props.length})</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                    {props.some((p) => p.lat == null) && (
                      <div style={{ fontSize: 11.5, color: '#c08a2e' }}>{props.filter((p) => p.lat == null).length} without map pin</div>
                    )}
                    {!addingAddr && (
                      <button onClick={() => { setNewP(BLANK_PROP); setAddingAddr(true); setEditPid(null) }} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>+ Add address</button>
                    )}
                  </div>
                </div>
                {addingAddr && (
                  <div style={{ border: '1px solid #cfe0d5', background: '#f7faf8', borderRadius: 10, padding: '10px 12px', marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 10.5, color: '#1f7a4d', fontFamily: MONO, letterSpacing: '.06em', fontWeight: 700 }}>NEW ADDRESS</div>
                    <input autoFocus value={newP.address} onChange={(e) => setNewP({ ...newP, address: e.target.value })} style={{ ...inp, fontSize: 13 }} placeholder="Full address, City Zip *" />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input value={newP.service} onChange={(e) => setNewP({ ...newP, service: e.target.value })} style={{ ...inp, fontSize: 13 }} placeholder="Service" />
                      <input value={newP.notes} onChange={(e) => setNewP({ ...newP, notes: e.target.value })} style={{ ...inp, fontSize: 13 }} placeholder="Bin location / notes" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, color: '#7c8a82' }}>$</span>
                      <input value={newP.price} onChange={(e) => setNewP({ ...newP, price: e.target.value })} inputMode="decimal" style={{ ...inp, fontSize: 13, maxWidth: 140 }} placeholder="Price (e.g. 15)" />
                      <input value={newP.techPay} onChange={(e) => setNewP({ ...newP, techPay: e.target.value })} inputMode="decimal" style={{ ...inp, fontSize: 13, maxWidth: 140 }} placeholder="Tech pay $ (lawn)" title="What the assigned tech earns for servicing this address (Lawn Care per-job pay)" />
                      <span style={{ fontSize: 11.5, color: '#9aa69e' }}>per pickup</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: '#7c8a82', fontFamily: MONO, letterSpacing: '.06em', marginTop: 2 }}>PICKUP DAYS</div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {DAYS.map((d) => {
                        const on = newP.days.includes(d)
                        return (
                          <button type="button" key={d} onClick={() => toggleNewDay(d)} style={{ flex: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '5px 9px', borderRadius: 7, border: `1px solid ${on ? '#1f7a4d' : '#dde2dd'}`, background: on ? '#e7f1eb' : '#fff', color: on ? '#1f7a4d' : '#7c8a82' }}>{DAY_ABBR[d]}</button>
                        )
                      })}
                    </div>
                    <select value={newP.frequency} onChange={(e) => setNewP({ ...newP, frequency: e.target.value })} style={{ ...inp, fontSize: 13 }}>
                      {FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button onClick={() => { setAddingAddr(false); setNewP(BLANK_PROP) }} disabled={pBusy} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                      <button onClick={saveNewProp} disabled={pBusy || !newP.address.trim()} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: pBusy || !newP.address.trim() ? 0.6 : 1 }}>{pBusy ? 'Saving…' : 'Add address'}</button>
                    </div>
                  </div>
                )}
                {!props.length && !addingAddr && (
                  <div style={{ fontSize: 12.5, color: '#9aa69e', padding: '6px 0 2px' }}>No addresses yet — add the first one with the button above, or use the Import tab for a whole list.</div>
                )}
                <div style={{ maxHeight: 360, overflowY: 'auto', margin: '0 -6px' }}>
                  {props.map((p) => (
                    <div key={p.id} style={{ padding: '8px 6px', borderTop: '1px solid #f1f3f0' }}>
                      {editPid === p.id ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <input value={editP.address} onChange={(e) => setEditP({ ...editP, address: e.target.value })} style={{ ...inp, fontSize: 13 }} placeholder="Full address, City Zip" />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input value={editP.service} onChange={(e) => setEditP({ ...editP, service: e.target.value })} style={{ ...inp, fontSize: 13 }} placeholder="Service" />
                            <input value={editP.notes} onChange={(e) => setEditP({ ...editP, notes: e.target.value })} style={{ ...inp, fontSize: 13 }} placeholder="Bin location / notes" />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 13, color: '#7c8a82' }}>$</span>
                            <input value={editP.price} onChange={(e) => setEditP({ ...editP, price: e.target.value })} inputMode="decimal" style={{ ...inp, fontSize: 13, maxWidth: 140 }} placeholder="Price (e.g. 15)" />
                            <input value={editP.techPay} onChange={(e) => setEditP({ ...editP, techPay: e.target.value })} inputMode="decimal" style={{ ...inp, fontSize: 13, maxWidth: 140 }} placeholder="Tech pay $ (lawn)" title="What the assigned tech earns for servicing this address (Lawn Care per-job pay)" />
                            <span style={{ fontSize: 11.5, color: '#9aa69e' }}>per pickup</span>
                          </div>
                          <div style={{ fontSize: 10.5, color: '#7c8a82', fontFamily: MONO, letterSpacing: '.06em', marginTop: 2 }}>PICKUP DAYS</div>
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            {DAYS.map((d) => {
                              const on = editP.days.includes(d)
                              return (
                                <button type="button" key={d} onClick={() => toggleDay(d)} style={{ flex: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '5px 9px', borderRadius: 7, border: `1px solid ${on ? '#1f7a4d' : '#dde2dd'}`, background: on ? '#e7f1eb' : '#fff', color: on ? '#1f7a4d' : '#7c8a82' }}>{DAY_ABBR[d]}</button>
                              )
                            })}
                          </div>
                          <select value={editP.frequency} onChange={(e) => setEditP({ ...editP, frequency: e.target.value })} style={{ ...inp, fontSize: 13 }}>
                            {FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button onClick={() => setEditPid(null)} disabled={pBusy} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                            <button onClick={() => saveProp(p)} disabled={pBusy} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: pBusy ? 0.6 : 1 }}>{pBusy ? 'Saving…' : 'Save & re-geocode'}</button>
                          </div>
                        </div>
                      ) : (
                        <>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <div title={p.lat != null ? 'Geocoded' : 'No map pin yet'} style={{ marginTop: 5, width: 8, height: 8, borderRadius: '50%', flex: 'none', background: p.lat != null ? '#1f7a4d' : '#e0b450' }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>
                              {p.code ? <span style={{ color: '#7c8a82', fontWeight: 700, marginRight: 6 }}>{p.code}</span> : null}
                              {p.address || p.name}
                            </div>
                            <div style={{ fontSize: 12, color: '#7c8a82' }}>
                              {[p.service, p.notes].filter(Boolean).join(' · ') || '—'}
                            </div>
                            <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              {p.pickup_days && p.pickup_days.length ? (
                                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: MONO, color: '#1f7a4d', background: '#e7f1eb', padding: '2px 8px', borderRadius: 6, letterSpacing: '.04em' }}>
                                  {daysLabel(p.pickup_days)}{p.pickup_frequency && p.pickup_frequency !== 'weekly' ? ` · ${freqLabel(p.pickup_frequency)}` : ''}
                                </span>
                              ) : (
                                <span style={{ fontSize: 11, fontWeight: 600, fontFamily: MONO, color: '#c08a2e', background: '#fbf3e2', padding: '2px 8px', borderRadius: 6 }}>No pickup day</span>
                              )}
                              {p.needs_review && (
                                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: MONO, color: '#c0492f', background: '#fbeae6', padding: '2px 8px', borderRadius: 6, letterSpacing: '.03em' }}>⚠ Needs review</span>
                              )}
                            </div>
                          </div>
                          {p.price != null && <div style={{ fontSize: 12.5, color: '#5d6b63', flex: 'none' }}>${Number(p.price).toFixed(2)}</div>}
                          <button onClick={() => toggleReview(p)} disabled={pBusy} title={p.needs_review ? 'Clear the review flag' : 'Flag this property for the owner to review'} style={{ flex: 'none', background: 'none', border: 'none', color: p.needs_review ? '#1f7a4d' : '#c0492f', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px', opacity: pBusy ? 0.6 : 1 }}>{p.needs_review ? 'Mark reviewed' : 'Needs review'}</button>
                          <button onClick={() => toggleHistory(p)} disabled={histBusy && histPid === p.id} style={{ flex: 'none', background: 'none', border: 'none', color: '#5d6b63', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px' }}>{histPid === p.id ? 'Hide' : 'History'}</button>
                          <button onClick={() => togglePhotos(p)} disabled={photoBusy && photoPid === p.id} style={{ flex: 'none', background: 'none', border: 'none', color: '#5d6b63', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px' }}>{photoPid === p.id ? 'Hide' : 'Photos'}</button>
                          <button onClick={() => startEditProp(p)} style={{ flex: 'none', background: 'none', border: 'none', color: '#1f7a4d', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px' }}>Edit</button>
                        </div>
                        {histPid === p.id && (
                          <div style={{ margin: '6px 0 2px 18px', borderLeft: '2px solid #eef0ed', paddingLeft: 12 }}>
                            <div style={{ fontSize: 10.5, color: '#7c8a82', fontFamily: MONO, letterSpacing: '.06em', marginBottom: 6 }}>CHECK-IN HISTORY</div>
                            {histBusy ? (
                              <div style={{ fontSize: 12, color: '#9aa69e' }}>Loading…</div>
                            ) : hist.length === 0 ? (
                              <div style={{ fontSize: 12, color: '#9aa69e' }}>No check-ins recorded yet.</div>
                            ) : (
                              hist.map((v) => (
                                <div key={v.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, padding: '3px 0' }}>
                                  <span style={{ fontWeight: 600, color: '#1a2420', minWidth: 96 }}>{fmtDate(v.check_in)}</span>
                                  <span style={{ color: '#5d6b63' }}>
                                    in {fmtTime(v.check_in)}{v.check_out ? ` · out ${fmtTime(v.check_out)}` : ''}
                                  </span>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                        {photoPid === p.id && (
                          <div style={{ margin: '6px 0 2px 18px', borderLeft: '2px solid #eef0ed', paddingLeft: 12 }}>
                            <div style={{ fontSize: 10.5, color: '#7c8a82', fontFamily: MONO, letterSpacing: '.06em', marginBottom: 8 }}>PHOTOS — PROOF FOR ADDRESSES NOT CHECKED IN</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                              <label style={{ fontSize: 11.5, color: '#7c8a82' }}>Date
                                <input type="date" value={photoDate} max={todayStr()} onChange={(e) => setPhotoDate(e.target.value)} style={{ ...inp, fontSize: 12.5, marginLeft: 6, padding: '5px 8px', width: 'auto' }} />
                              </label>
                              <input value={photoNote} onChange={(e) => setPhotoNote(e.target.value)} placeholder="Note (e.g. bin not out)" style={{ ...inp, fontSize: 12.5, padding: '5px 8px', flex: 1, minWidth: 120 }} />
                              <label style={{ flex: 'none', cursor: photoBusy ? 'default' : 'pointer', fontSize: 12.5, fontWeight: 600, color: '#fff', background: photoBusy ? '#9aa69e' : '#1f7a4d', borderRadius: 8, padding: '6px 12px' }}>
                                {photoBusy ? 'Working…' : '+ Add photo'}
                                <input type="file" accept="image/*" multiple disabled={photoBusy} onChange={(e) => { addPhotos(p, e.target.files); e.target.value = '' }} style={{ display: 'none' }} />
                              </label>
                            </div>
                            {photoBusy && !photos.length ? (
                              <div style={{ fontSize: 12, color: '#9aa69e' }}>Loading…</div>
                            ) : photos.length === 0 ? (
                              <div style={{ fontSize: 12, color: '#9aa69e' }}>No photos yet. Pick a date, then add a photo of the address.</div>
                            ) : (
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8 }}>
                                {photos.map((ph) => (
                                  <div key={ph.id} style={{ border: '1px solid #e6eae6', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
                                    <div style={{ position: 'relative', aspectRatio: '1', background: '#eef0ed' }}>
                                      {ph.url ? (
                                        <a href={ph.url} target="_blank" rel="noreferrer"><img src={ph.url} alt={ph.note || 'photo'} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /></a>
                                      ) : (
                                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9aa69e', fontSize: 22 }}>▦</div>
                                      )}
                                      <button onClick={() => removePhoto(p, ph)} title="Delete photo" style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 6, border: 'none', background: 'rgba(15,30,20,.55)', color: '#fff', fontSize: 12, cursor: 'pointer', lineHeight: 1 }}>✕</button>
                                    </div>
                                    <div style={{ padding: '6px 7px' }}>
                                      <input type="date" value={ph.takenOn} max={todayStr()} onChange={(e) => changePhotoDate(ph, e.target.value)} style={{ width: '100%', border: '1px solid #eef0ed', borderRadius: 6, padding: '3px 5px', fontSize: 11, color: '#1a2420', outline: 'none' }} />
                                      {ph.note && <div style={{ fontSize: 11, color: '#7c8a82', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={ph.note}>{ph.note}</div>}
                                      {ph.source === 'randy' && <div style={{ fontSize: 9.5, color: '#9aa69e', fontFamily: MONO, marginTop: 2 }}>via Randy</div>}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {stripeOk && cur.invoice && cur.invoice.amount != null && (
              <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>Payment link</div>
                    <div style={{ fontSize: 12, color: '#7c8a82' }}>Charge ${Number(cur.invoice.amount).toFixed(2)} — send the link to your customer.</div>
                  </div>
                  <button onClick={makePayLink} disabled={payBusy} style={{ flex: 'none', background: '#635bff', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: payBusy ? 0.6 : 1 }}>{payBusy ? 'Creating…' : 'Create link'}</button>
                </div>
                {payErr && <div style={{ marginTop: 10, color: '#9a2c1e', fontSize: 12 }}>{payErr}</div>}
                {payLink && (
                  <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input readOnly value={payLink} onFocus={(e) => e.target.select()} style={{ ...inp, flex: 1, fontSize: 12 }} />
                    <a href={payLink} target="_blank" rel="noreferrer" style={{ flex: 'none', background: '#1f7a4d', color: '#fff', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>Open</a>
                  </div>
                )}
              </div>
            )}

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
        <div onClick={() => !saving && (setShowForm(false), setEditingId(null))} style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ width: 520, maxWidth: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{editingId ? 'Edit client' : 'Add client'}</div>
            <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 16 }}>{editingId ? 'Update this client and its pickup / invoice schedule.' : 'Creates the customer plus a pickup schedule and invoice schedule.'}</div>

            <Field label="Business name *"><input autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} style={inp} placeholder="Acme Property Group" /></Field>
            <Field label="Address"><input value={form.address} onChange={(e) => set({ address: e.target.value })} style={inp} placeholder="123 Main St" /></Field>
            <div style={twoCol}>
              <Field label="Contact"><input value={form.contactName} onChange={(e) => set({ contactName: e.target.value })} style={inp} /></Field>
              <Field label="Phone"><input value={form.phone} onChange={(e) => set({ phone: e.target.value })} style={inp} /></Field>
            </div>
            <Field label="Email"><input value={form.email} onChange={(e) => set({ email: e.target.value })} style={inp} type="email" /></Field>

            <Divider>Pickup defaults</Divider>
            <Field label="Service"><input value={form.service} onChange={(e) => set({ service: e.target.value })} style={inp} placeholder="4yd dumpster x2" /></Field>
            <Field label="Default frequency">
              <select value={form.frequency} onChange={(e) => set({ frequency: e.target.value })} style={inp}>
                {FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <div style={{ fontSize: 11.5, color: '#7c8a82', margin: '-4px 0 6px', lineHeight: 1.5 }}>
              Pickup <b>days</b> are set per address — open the client and use <b>Edit</b> on each property (an address can run more than one day a week).
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
              <button type="button" onClick={() => { setShowForm(false); setEditingId(null) }} disabled={saving} style={{ flex: 'none', background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button type="submit" disabled={saving || !form.name.trim()} style={{ flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving || !form.name.trim() ? 0.6 : 1 }}>{saving ? 'Saving…' : (editingId ? 'Save changes' : 'Create client')}</button>
            </div>
          </form>
        </div>
      )}
    </div>
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
const dupActBtn = (color) => ({ flex: 'none', background: '#fff', color, border: `1px solid ${color}55`, borderRadius: 7, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' })
// One-line "where this copy is from" for a duplicate: pickup day(s), import code, and when it was added.
const dupMeta = (p) => {
  const parts = []
  const d = daysLabel(p.pickup_days)
  parts.push(d ? d : 'no pickup day')
  if (p.code) parts.push(`#${p.code}`)
  if (p.created_at) parts.push(`added ${fmtDate(p.created_at)}`)
  return parts.join(' · ')
}

export const searchInput = { width: '100%', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '9px 12px 9px 32px', fontSize: 16, outline: 'none', boxSizing: 'border-box' }
export const searchIcon = { position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e' }
