import { useEffect, useMemo, useRef, useState } from 'react'
import { MONO } from '../data.js'
import { loadCustomers, createClient, updateCustomer, subscribeCustomers, attachTag, detachTag, deleteClient, loadProperties, addProperty, updateProperty, savePin, loadPropertyVisits, loadPropertyAddressIndex, countDuplicateProperties, findDuplicateProperties, mergeDuplicateGroup, loadPropertiesByIds, countPropertiesByCustomer, deleteProperty, sendPortalInvite, loadClientFieldActivity, loadClientPortalRequests, loadClientNotes, addClientNote, deleteClientNote, loadPropertyLog } from '../lib/customersData.js'
import PinPicker from '../components/PinPicker.jsx'
import { geocodeAll } from '../lib/importData.js'
import { listTags, findOrCreateTag, subscribeTags } from '../lib/tagsData.js'
import { paymentsStatus, invoicePaymentUrl } from '../lib/paymentsData.js'
import { createInvoice } from '../lib/invoicesData.js'
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
  name: '', address: '', contactName: '', email: '', phone: '', status: 'active', notes: '', billingType: 'subscription',
  notifyOnService: null, // null=auto (single-property only), true=always, false=never
  service: '', frequency: 'weekly', dayOfWeek: 'monday',
  cadence: 'monthly', amount: '',
}
// The Service-notification dropdown uses strings; map to the DB's true/false/null.
const NOTIFY_TO_STR = (v) => (v === true ? 'always' : v === false ? 'never' : 'auto')
const NOTIFY_FROM_STR = (s) => (s === 'always' ? true : s === 'never' ? false : null)
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
  const [paymentsOk, setPaymentsOk] = useState(false)
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
  const [mergeGrp, setMergeGrp] = useState(null) // duplicate group open in the Edit & Merge screen
  const [pickMerge, setPickMerge] = useState(false) // multi-select mode for a manual merge
  const [picked, setPicked] = useState(() => new Set()) // client ids picked for a manual merge
  const [addrIdx, setAddrIdx] = useState({}) // customer_id → its property addresses (for search)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteMsg, setInviteMsg] = useState('')
  const [actEvents, setActEvents] = useState([])
  const [actBusy, setActBusy] = useState(false)
  const [actSearch, setActSearch] = useState('')
  const [notes, setNotes] = useState([])
  const [noteInput, setNoteInput] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [billingFilter, setBillingFilter] = useState('all') // all | subscription | one_time
  const [logPid, setLogPid] = useState(null) // property whose activity log is open
  const [logRows, setLogRows] = useState([])
  const [logBusy, setLogBusy] = useState(false)
  const [focusPropId, setFocusPropId] = useState(null) // property briefly highlighted when jumped to from Routes/Field
  const [pinProp, setPinProp] = useState(null) // property whose pin is being set manually
  const [propSearch, setPropSearch] = useState('') // filter within a client's addresses
  const propRowRefs = useRef({}) // propertyId → DOM node (for scroll-to-address)

  // A route stop was clicked elsewhere (Routes / Field board) — jump to that
  // client, and if a specific property was passed, scroll it into view + flash it.
  useEffect(() => {
    const f = app.clientFocus
    if (f && f.id) {
      setSelId(f.id)
      setSearch('')
      setBillingFilter('all')
      setPropSearch('')
      if (f.propertyId) setFocusPropId(f.propertyId)
    }
  }, [app.clientFocus])

  // Once the focused property's row is in the DOM, scroll to it and clear the
  // highlight after a beat. Re-runs as props load / filter changes clear.
  useEffect(() => {
    if (!focusPropId) return
    const node = propRowRefs.current[focusPropId]
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    const t = setTimeout(() => setFocusPropId(null), 2600)
    return () => clearTimeout(t)
  }, [focusPropId, props])

  // Load the selected client's service properties.
  useEffect(() => {
    if (!selId) { setProps([]); return }
    let alive = true
    loadProperties(selId).then((r) => { if (alive) setProps(r) }).catch(() => { if (alive) setProps([]) })
    return () => { alive = false }
  }, [selId, customers])

  // Field activity (on-my-way / clock-in / complete / photos) for this client.
  useEffect(() => {
    if (!selId) { setActEvents([]); return }
    let alive = true
    setActBusy(true)
    setActSearch('')
    Promise.all([
      loadClientFieldActivity(selId).catch(() => []),
      loadClientPortalRequests(selId).catch(() => []),
    ])
      .then(([field, reqs]) => {
        if (!alive) return
        setActEvents([...field, ...reqs].sort((a, b) => new Date(b.ts) - new Date(a.ts)))
      })
      .finally(() => { if (alive) setActBusy(false) })
    return () => { alive = false }
  }, [selId])

  // Per-client notes log (running history).
  useEffect(() => {
    if (!selId) { setNotes([]); return }
    let alive = true
    loadClientNotes(selId).then((r) => { if (alive) setNotes(r) }).catch(() => { if (alive) setNotes([]) })
    return () => { alive = false }
  }, [selId])

  const actFiltered = useMemo(() => {
    const q = actSearch.trim().toLowerCase()
    if (!q) return actEvents
    return actEvents.filter((e) =>
      `${e.type} ${e.address || ''} ${e.kindLabel || ''} ${e.message || ''} ${e.route || ''} ${fmtDate(e.ts)} ${fmtTime(e.ts)}`.toLowerCase().includes(q))
  }, [actEvents, actSearch])

  // Filter a client's service addresses (property managers with many locations
  // shouldn't have to scroll to find one).
  const visibleProps = useMemo(() => {
    const q = propSearch.trim().toLowerCase()
    if (!q) return props
    return props.filter((p) =>
      `${p.address || p.name || ''} ${p.service || ''} ${p.notes || ''} ${(p.pickup_days || []).map(daysLabel).join(' ')}`.toLowerCase().includes(q))
  }, [props, propSearch])

  // Save a manually dropped pin (PinPicker) and refresh the address list.
  async function savePropPin(pt) {
    if (!pinProp) return
    await savePin(pinProp.id, pt.lat, pt.lng)
    if (selId) loadProperties(selId).then(setProps).catch(() => {})
  }

  async function refresh() {
    const rows = await loadCustomers()
    setCustomers(rows)
    setSelId((cur) => cur || (rows[0] && rows[0].id) || null)
    // Rebuild the address search index in the background (search matches property addresses too).
    loadPropertyAddressIndex().then(setAddrIdx).catch(() => {})
  }

  useEffect(() => {
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    const reloadTags = () => listTags().then(setAllTags).catch(() => {})
    reloadTags()
    countDuplicateProperties().then(setDupCount).catch(() => {})
    paymentsStatus().then((d) => setPaymentsOk(!!(d && d.connected))).catch(() => {})
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
  // The merge screen does the whole job (pick the survivor, choose what carries
  // over, preview) and calls back here when it's applied.
  async function afterMerge() {
    setMergeGrp(null)
    setPickMerge(false)
    setPicked(new Set())
    await refresh()
    await refreshDuplicates()
  }

  // Manual merge: pick 2+ clients in the list, then Edit & Merge — the same
  // screen as the duplicate cleanup, for pairs the detector never flagged.
  function togglePick(id) {
    setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  async function openManualMerge() {
    const chosen = customers.filter((c) => picked.has(c.id))
    if (chosen.length < 2) return
    setErr(null)
    try {
      const lists = await Promise.all(chosen.map((c) => loadProperties(c.id)))
      const norm = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
      const all = lists.flat()
      // One property per client: prefer an address shared with another picked
      // client (the classic missed duplicate), else their first address.
      const sel = lists.map((list) => (!list.length
        ? null
        : (list.find((p) => all.filter((q) => norm(q.address) === norm(p.address)).length > 1) || list[0])))
      if (sel.some((p) => !p)) { setErr('Every selected client needs at least one service address before they can be merged.'); return }
      setMergeGrp({ normalized: 'manual', count: sel.length, manual: true, properties: sel.map((p) => ({ id: p.id, address: p.address, customer_id: p.customer_id })) })
    } catch (e) {
      setErr(e.message || String(e))
    }
  }

  // Only clients on the active business line (legacy rows count as waste).
  const lineCustomers = useMemo(
    () => customers.filter((c) => (c.business_line || 'waste') === (app.activeLine || 'waste')),
    [customers, app.activeLine],
  )
  const q = search.toLowerCase().trim()
  const list = useMemo(() => {
    let l = lineCustomers
    if (billingFilter !== 'all') l = l.filter((c) => (c.billingType || 'subscription') === billingFilter)
    if (q) l = l.filter((c) => (c.name + ' ' + c.address).toLowerCase().includes(q) || (addrIdx[c.id] || '').includes(q))
    return l
  }, [lineCustomers, q, addrIdx, billingFilter])
  const cur = lineCustomers.find((c) => c.id === selId) || null

  // Switching business line: drop any selection from the previous line.
  // If the selected client isn't in the (loaded) customers list, leave the
  // selection alone — it may be a cross-view focus (Routes stop click) that
  // landed before the list finished loading.
  useEffect(() => {
    setSelId((cur) => {
      if (!cur) return cur
      const found = customers.find((c) => c.id === cur)
      if (!found) return cur
      return (found.business_line || 'waste') === (app.activeLine || 'waste') ? cur : (customers.find((c) => (c.business_line || 'waste') === (app.activeLine || 'waste'))?.id ?? null)
    })
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
      // Create a one-line invoice for the scheduled amount, then mint its pay link.
      const invId = await createInvoice({
        customerId: cur.id,
        status: 'sent',
        issueDate: new Date().toISOString().slice(0, 10),
        items: [{ description: 'Service', quantity: 1, unitPrice: Number(cur.invoice.amount) }],
      })
      const d = await invoicePaymentUrl(invId)
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
  // Per-address audit trail: who added it (Laura / Matt / Trashy Randy / ...),
  // edits, skips, one-time day changes.
  async function toggleLog(p) {
    if (logPid === p.id) { setLogPid(null); setLogRows([]); return }
    setLogPid(p.id); setLogRows([]); setLogBusy(true)
    try { setLogRows(await loadPropertyLog(p.id)) }
    catch (e) { setErr(e.message || String(e)) }
    finally { setLogBusy(false) }
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

  // Pause / resume a single address. Paused addresses keep all their history
  // but are skipped by every route builder + the dashboard due-count.
  async function togglePause(p) {
    if (pBusy) return
    setPBusy(true)
    setErr(null)
    try {
      await updateProperty(p.id, { paused: !p.paused })
      setProps(await loadProperties(selId))
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setPBusy(false)
    }
  }

  // Permanently delete an address (removes it from all routes). Prefer Pause to
  // keep history; this is the hard delete for addresses added in error / dropped.
  async function delProp(p) {
    if (pBusy) return
    if (!window.confirm(`Delete this address?\n\n${p.address || p.name}\n\nThis removes it from all routes and can't be undone. To keep its history but stop servicing it, use Pause instead.`)) return
    setPBusy(true)
    setErr(null)
    try {
      await deleteProperty(p.id)
      if (editPid === p.id) setEditPid(null)
      setProps(await loadProperties(selId))
      countDuplicateProperties().then(setDupCount).catch(() => {})
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setPBusy(false)
    }
  }

  // Per-client notes log: add / delete a dated note.
  async function submitNote(e) {
    if (e) e.preventDefault()
    const body = noteInput.trim()
    if (!body || noteBusy || !selId) return
    setNoteBusy(true)
    setErr(null)
    try {
      const n = await addClientNote(selId, body)
      setNotes((cur) => [n, ...cur])
      setNoteInput('')
    } catch (err) { setErr(err.message || String(err)) }
    finally { setNoteBusy(false) }
  }
  async function removeNote(n) {
    if (noteBusy) return
    if (!window.confirm('Delete this note?')) return
    setNoteBusy(true)
    setErr(null)
    try {
      await deleteClientNote(n.id)
      setNotes((cur) => cur.filter((x) => x.id !== n.id))
    } catch (err) { setErr(err.message || String(err)) }
    finally { setNoteBusy(false) }
  }

  // Email the client their portal invite (login link + save-a-card / 5th-week-free pitch).
  async function invitePortal() {
    if (!cur || inviteBusy) return
    setInviteBusy(true)
    setErr(null)
    setInviteMsg('')
    try {
      const r = await sendPortalInvite(cur.id)
      setInviteMsg(`✓ Invite sent to ${r.email} — portal login link + the save-a-card / 5th-week-free offer.`)
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setInviteBusy(false)
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
      billingType: cur.billingType || 'subscription',
      notifyOnService: cur.notifyOnService ?? null,
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
      billingType: form.billingType || 'subscription',
      notifyOnService: form.notifyOnService ?? null,
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
            <span style={{ display: 'block', fontWeight: 400, fontSize: 12, color: '#a87154', marginTop: 2 }}>
              Nothing is broken — Randy keeps working in the field and flags these for you. Clean them up here whenever you like.
            </span>
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
                    {/* One address, one button. Everything else happens on the merge screen. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 0 }}>{(g.properties[0] && g.properties[0].address) || g.normalized} <span style={{ color: '#9a3412' }}>· {g.count}×</span></div>
                      <button onClick={() => setMergeGrp(g)} disabled={dupBusy} title="Review both copies, pick which one stays, and choose what carries over" style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>Edit &amp; Merge</button>
                    </div>
                    {g.properties.map((p) => (
                      <div key={p.id} style={{ fontSize: 12, padding: '5px 0', borderTop: '1px solid #f7f0e8' }}>
                        <div onClick={() => p.customer_id && setSelId(p.customer_id)} title="Open this client" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#1f7a4d', cursor: p.customer_id ? 'pointer' : 'default', fontWeight: 600 }}>
                          {p.customer_name || '(no client)'} <span style={{ color: '#7c8a82', fontWeight: 400 }}>{p.price != null ? `· $${Number(p.price).toFixed(2)}` : ''}{p.needs_review ? ' ⚠' : ''}</span>
                        </div>
                        <div style={{ color: '#9aa69e', fontSize: 11 }}>{dupMeta(p)}</div>
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
    {mergeGrp && (
      <MergeDuplicates
        group={mergeGrp}
        customers={customers}
        isMobile={isMobile}
        onClose={() => setMergeGrp(null)}
        onDone={afterMerge}
      />
    )}
    {pinProp && (() => {
      const near = props.find((p) => p.lat != null && p.lng != null && p.id !== pinProp.id)
      return (
        <PinPicker
          address={pinProp.address || pinProp.name || ''}
          lat={pinProp.lat}
          lng={pinProp.lng}
          defaultCenter={near ? [near.lat, near.lng] : null}
          onClose={() => setPinProp(null)}
          onSave={savePropPin}
        />
      )
    })()}
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1.25fr', gap: 18 }}>
      {/* list */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 8 }}>
        <div style={{ display: 'flex', gap: 8, margin: '6px 6px 8px' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients or addresses…" style={searchInput} />
            <div style={searchIcon}>⌕</div>
          </div>
          <button onClick={() => { setForm(BLANK); setEditingId(null); setShowForm(true) }} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '0 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>+ Add client</button>
        </div>
        {/* manual merge picker: toggle it on, tick 2+ clients, Edit & Merge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 6px 8px', flexWrap: 'wrap' }}>
          <button onClick={() => { setPickMerge((v) => !v); setPicked(new Set()) }} title="Merge two clients that aren't flagged as duplicates" style={{ flex: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '5px 11px', borderRadius: 20, border: `1px solid ${pickMerge ? '#1f7a4d' : '#dde2dd'}`, background: pickMerge ? '#e7f1eb' : '#fff', color: pickMerge ? '#1f7a4d' : '#7c8a82' }}>⇄ Merge clients</button>
          {pickMerge && (
            <>
              <span style={{ fontSize: 11.5, color: '#9aa69e' }}>{picked.size ? `${picked.size} selected${picked.size < 2 ? ' — pick at least one more' : ''}` : 'Tick two or more clients to merge them'}</span>
              <div style={{ flex: 1 }} />
              <button onClick={openManualMerge} disabled={picked.size < 2} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: picked.size >= 2 ? 'pointer' : 'default', opacity: picked.size < 2 ? 0.5 : 1 }}>Edit &amp; Merge{picked.size >= 2 ? ` (${picked.size})` : ''}</button>
            </>
          )}
        </div>
        {/* billing-type filter: subscription vs single-payment clients */}
        <div style={{ display: 'flex', gap: 6, margin: '0 6px 8px', alignItems: 'center' }}>
          {[['all', 'All'], ['subscription', 'Subscription'], ['one_time', 'Single payment']].map(([v, l]) => {
            const on = billingFilter === v
            const n = v === 'all' ? lineCustomers.length : lineCustomers.filter((c) => (c.billingType || 'subscription') === v).length
            return (
              <button key={v} onClick={() => setBillingFilter(v)} style={{ flex: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '5px 11px', borderRadius: 20, border: `1px solid ${on ? '#1f7a4d' : '#dde2dd'}`, background: on ? '#e7f1eb' : '#fff', color: on ? '#1f7a4d' : '#7c8a82' }}>{l} ({n})</button>
            )
          })}
        </div>

        {loading && <div style={empty}>Loading…</div>}
        {!loading && !customers.length && <div style={empty}>No clients yet. Add one with the button above, or ask Trashy Randy.</div>}

        <div style={{ maxHeight: 'calc(100dvh - 220px)', overflowY: 'auto', margin: '0 -2px', paddingBottom: 4, WebkitOverflowScrolling: 'touch' }}>
        {list.map((c) => {
          const on = c.id === selId
          return (
            <div key={c.id} onClick={() => { setSelId(c.id); setConfirmDelete(false); setTagInput(''); setPayLink(null); setPayErr(null); setAddingAddr(false); setNewP(BLANK_PROP); setEditPid(null); setInviteMsg('') }} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 10px', borderRadius: 10, cursor: 'pointer', marginBottom: 2, background: picked.has(c.id) ? '#f2f9f5' : on ? '#f3faf5' : '#fff', border: `1px solid ${picked.has(c.id) ? '#1f7a4d' : on ? '#cfe0d5' : 'transparent'}` }}>
              {pickMerge && (
                <input type="checkbox" checked={picked.has(c.id)} onClick={(e) => e.stopPropagation()} onChange={() => togglePick(c.id)} title="Pick this client for the merge" style={{ width: 17, height: 17, accentColor: '#1f7a4d', flex: 'none', cursor: 'pointer' }} />
              )}
              <div style={{ width: 36, height: 36, borderRadius: 9, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 12, flex: 'none' }}>{initialsOf(c.name)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                <div style={{ fontSize: 11, color: '#7c8a82' }}>{c.pickup ? freqLabel(c.pickup.frequency) : 'No schedule'}</div>
              </div>
              {(c.billingType || 'subscription') === 'one_time' && <span title="Single-payment / on-demand client (not a subscription)" style={{ flex: 'none', fontFamily: MONO, fontSize: 9, fontWeight: 700, color: '#155e9c', background: '#e8f0fa', padding: '1px 6px', borderRadius: 5 }}>1×</span>}
              {c.autopay?.saved && <span title={`Autopay on — ${(c.autopay.brand || 'card').toUpperCase()} ••${c.autopay.last4 || ''} · 5th week free`} style={{ flex: 'none', fontFamily: MONO, fontSize: 9, fontWeight: 700, color: '#1f7a4d', background: '#e7f1eb', padding: '1px 6px', borderRadius: 5 }}>💳 CARD</span>}
              {c.status !== 'active' && <span style={{ flex: 'none', fontFamily: MONO, fontSize: 9, color: '#b07a1e', background: '#fdf2e0', padding: '1px 6px', borderRadius: 5 }}>{c.status}</span>}
            </div>
          )
        })}
        </div>
      </div>

      {/* detail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5 }}>{err}</div>}
        {inviteMsg && (
          <div style={{ background: '#e7f1eb', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 11, padding: '10px 14px', fontSize: 12.5, display: 'flex', gap: 10 }}>
            <span style={{ flex: 1 }}>{inviteMsg}</span>
            <span onClick={() => setInviteMsg('')} style={{ cursor: 'pointer', fontWeight: 700 }}>✕</span>
          </div>
        )}

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
                  <div style={{ fontWeight: 700, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {cur.name}
                    {(cur.billingType || 'subscription') === 'one_time' && (
                      <span title="Single-payment / on-demand client" style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: '#155e9c', background: '#e8f0fa', padding: '3px 9px', borderRadius: 7, letterSpacing: '.03em' }}>1× SINGLE PAYMENT</span>
                    )}
                    {cur.autopay?.saved && (
                      <span title="This client has a saved payment method — invoices are charged automatically and 5th-week-free applies" style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: '#1f7a4d', background: '#e7f1eb', padding: '3px 9px', borderRadius: 7, letterSpacing: '.03em' }}>
                        💳 AUTOPAY · {(cur.autopay.brand || 'CARD').toUpperCase()} ••{cur.autopay.last4 || ''}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: '#7c8a82' }}>{cur.address || 'No address'}</div>
                </div>
                {cur.portal_slug && !cur.autopay?.saved && (
                  <button
                    onClick={invitePortal}
                    disabled={inviteBusy || !cur.email}
                    title={cur.email ? `Email ${cur.email} a portal login link with the save-a-card offer (5th week free)` : 'Add an email to this client first'}
                    style={{ background: '#1f7a4d', border: 'none', color: '#fff', borderRadius: 9, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, cursor: cur.email ? 'pointer' : 'not-allowed', flex: 'none', opacity: inviteBusy || !cur.email ? 0.6 : 1 }}
                  >{inviteBusy ? 'Sending…' : '✉ 5th-week-free invite'}</button>
                )}
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
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Notes</div>
              <form onSubmit={submitNote} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <textarea value={noteInput} onChange={(e) => setNoteInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitNote(e) }} placeholder="Add a note about this client… (⌘/Ctrl+Enter to save)" rows={2} style={{ ...inp, flex: 1, fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }} />
                <button type="submit" disabled={noteBusy || !noteInput.trim()} style={{ flex: 'none', alignSelf: 'flex-start', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: noteBusy || !noteInput.trim() ? 0.6 : 1 }}>{noteBusy ? 'Saving…' : 'Add'}</button>
              </form>
              {!notes.length ? (
                <div style={{ fontSize: 12.5, color: '#9aa69e' }}>No notes yet — add the first one above.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {notes.map((n) => (
                    <div key={n.id} style={{ borderLeft: '2px solid #e7f1eb', paddingLeft: 12 }}>
                      <div style={{ fontSize: 13.5, color: '#1a2420', whiteSpace: 'pre-wrap', marginBottom: 3 }}>{n.body}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11.5, color: '#9aa69e' }}>{n.author_name || 'Staff'} · {fmtDate(n.created_at)} {fmtTime(n.created_at)}</span>
                        <button onClick={() => removeNote(n)} disabled={noteBusy} title="Delete this note" style={{ background: 'none', border: 'none', color: '#c0492f', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0, opacity: noteBusy ? 0.6 : 1 }}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Details</div>
              <Row label="Service" value={cur.pickup?.service || '—'} />
              <Row label="Contact Name" value={cur.contactName || '—'} />
              <Row label="Email" value={cur.email || '—'} />
              <Row label="Phone" value={cur.phone || '—'} />
              <Row label="Status" value={cap(cur.status)} />
              <Row label="Text on service" value={cur.notifyOnService === true ? 'Always' : cur.notifyOnService === false ? 'Never' : 'Auto (single-property only)'} />
              {cur.notes && <Row label="Notes" value={cur.notes} />}
            </div>

            {(
              <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Addresses ({props.length}){propSearch.trim() && visibleProps.length !== props.length ? <span style={{ color: '#7c8a82', fontWeight: 500, fontSize: 12 }}> · {visibleProps.length} of {props.length}</span> : null}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                  {props.some((p) => p.lat == null) && (
                    <div style={{ fontSize: 11.5, color: '#c08a2e' }}>{props.filter((p) => p.lat == null).length} without map pin</div>
                  )}
                  {!addingAddr && (
                    <button onClick={() => { setNewP(BLANK_PROP); setAddingAddr(true); setEditPid(null) }} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>+ Add address</button>
                  )}
                </div>
              </div>
              {props.length >= 2 && (
                <div style={{ position: 'relative', marginBottom: 10 }}>
                  <input value={propSearch} onChange={(e) => setPropSearch(e.target.value)} placeholder="Search addresses…" style={searchInput} />
                  <div style={searchIcon}>⌕</div>
                  {propSearch && <div onClick={() => setPropSearch('')} style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e', fontSize: 13, cursor: 'pointer' }}>✕</div>}
                </div>
              )}
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
                  <div style={{ fontSize: 12.5, color: '#9aa69e', padding: '6px 0 2px' }}>No addresses yet — add the first one with the button above, or use Import (in Settings) for a whole list.</div>
                )}
                {props.length > 0 && propSearch.trim() && visibleProps.length === 0 && (
                  <div style={{ fontSize: 12.5, color: '#9aa69e', padding: '6px 0 2px' }}>No addresses match “{propSearch.trim()}”.</div>
                )}
                <div style={{ maxHeight: 360, overflowY: 'auto', margin: '0 -6px' }}>
                  {visibleProps.map((p) => {
                    const flashing = focusPropId === p.id
                    return (
                    <div key={p.id} ref={(el) => { if (el) propRowRefs.current[p.id] = el }} style={{ padding: '8px 6px', borderTop: '1px solid #f1f3f0', background: flashing ? '#eef7f1' : 'transparent', boxShadow: flashing ? 'inset 3px 0 0 #1f7a4d' : 'none', transition: 'background .25s' }}>
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
                              {p.paused && (
                                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: MONO, color: '#8a6d1e', background: '#f6efdd', padding: '2px 8px', borderRadius: 6, letterSpacing: '.03em' }}>⏸ Paused · off routes</span>
                              )}
                            </div>
                            <div style={{ fontSize: 10.5, color: '#9aa69e', marginTop: 3 }}>
                              Added {p.created_at ? fmtDate(p.created_at) : '—'}{p.created_by ? ` by ${p.created_by}` : ''}
                            </div>
                          </div>
                          {p.price != null && <div style={{ fontSize: 12.5, color: '#5d6b63', flex: 'none' }}>${Number(p.price).toFixed(2)}</div>}
                          <button onClick={() => toggleReview(p)} disabled={pBusy} title={p.needs_review ? 'Clear the review flag' : 'Flag this property for the owner to review'} style={{ flex: 'none', background: 'none', border: 'none', color: p.needs_review ? '#1f7a4d' : '#c0492f', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px', opacity: pBusy ? 0.6 : 1 }}>{p.needs_review ? 'Mark reviewed' : 'Needs review'}</button>
                          <button onClick={() => toggleHistory(p)} disabled={histBusy && histPid === p.id} style={{ flex: 'none', background: 'none', border: 'none', color: '#5d6b63', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px' }}>{histPid === p.id ? 'Hide' : 'History'}</button>
                          <button onClick={() => toggleLog(p)} disabled={logBusy && logPid === p.id} title="Who added and changed this address" style={{ flex: 'none', background: 'none', border: 'none', color: '#5d6b63', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px' }}>{logPid === p.id ? 'Hide log' : 'Log'}</button>
                          <button onClick={() => togglePhotos(p)} disabled={photoBusy && photoPid === p.id} style={{ flex: 'none', background: 'none', border: 'none', color: '#5d6b63', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px' }}>{photoPid === p.id ? 'Hide' : 'Photos'}</button>
                          <button onClick={() => setPinProp(p)} title={p.lat != null ? 'Move this address\'s map pin manually' : 'No map pin — set it manually by clicking the map'} style={{ flex: 'none', background: 'none', border: 'none', color: p.lat != null ? '#5d6b63' : '#c08a2e', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px' }}>{p.lat != null ? 'Pin' : 'Set pin'}</button>
                          <button onClick={() => startEditProp(p)} style={{ flex: 'none', background: 'none', border: 'none', color: '#1f7a4d', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px' }}>Edit</button>
                          <button onClick={() => togglePause(p)} disabled={pBusy} title={p.paused ? 'Resume — put this address back on routes' : 'Pause — keep the address but skip it on all routes'} style={{ flex: 'none', background: 'none', border: 'none', color: p.paused ? '#1f7a4d' : '#8a6d1e', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px', opacity: pBusy ? 0.6 : 1 }}>{p.paused ? 'Resume' : 'Pause'}</button>
                          <button onClick={() => delProp(p)} disabled={pBusy} title="Delete this address permanently" style={{ flex: 'none', background: 'none', border: 'none', color: '#c0492f', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '0 2px', opacity: pBusy ? 0.6 : 1 }}>Delete</button>
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
                        {logPid === p.id && (
                          <div style={{ margin: '6px 0 2px 18px', borderLeft: '2px solid #eef0ed', paddingLeft: 12 }}>
                            <div style={{ fontSize: 10.5, color: '#7c8a82', fontFamily: MONO, letterSpacing: '.06em', marginBottom: 6 }}>ADDRESS LOG — WHO DID WHAT</div>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, padding: '3px 0' }}>
                              <span style={{ fontWeight: 600, color: '#1a2420', minWidth: 96 }}>{p.created_at ? fmtDate(p.created_at) : '—'}</span>
                              <span style={{ color: '#5d6b63' }}>Added{p.created_by ? ` by ${p.created_by}` : ''}</span>
                            </div>
                            {logBusy ? (
                              <div style={{ fontSize: 12, color: '#9aa69e' }}>Loading…</div>
                            ) : (
                              logRows.map((r) => (
                                <div key={r.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, padding: '3px 0' }}>
                                  <span style={{ fontWeight: 600, color: '#1a2420', minWidth: 96 }}>{fmtDate(r.created_at)}</span>
                                  <span style={{ color: '#5d6b63', flex: 1, minWidth: 0 }}>{r.summary} <span style={{ color: '#9aa69e' }}>— {r.actor}</span></span>
                                </div>
                              ))
                            )}
                            {!logBusy && logRows.length === 0 && (
                              <div style={{ fontSize: 12, color: '#9aa69e' }}>No changes recorded yet (edits, skips and day changes will show here).</div>
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
                    )
                  })}
                </div>
              </div>
            )}

            <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700, fontSize: 14, flex: 'none' }}>Activity</div>
                <div style={{ position: 'relative', flex: 1, minWidth: 160 }}>
                  <input value={actSearch} onChange={(e) => setActSearch(e.target.value)} placeholder="Search activity — address, date, “completed”…" style={{ ...inp, fontSize: 13, padding: '7px 10px 7px 28px' }} />
                  <div style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e', fontSize: 13 }}>⌕</div>
                </div>
                {actSearch && <span style={{ flex: 'none', fontSize: 11.5, color: '#7c8a82' }}>{actFiltered.length} of {actEvents.length}</span>}
              </div>
              {actBusy ? (
                <div style={{ fontSize: 12.5, color: '#9aa69e' }}>Loading…</div>
              ) : actEvents.length === 0 ? (
                <div style={{ fontSize: 12.5, color: '#9aa69e' }}>No activity yet — portal requests, on-my-way texts, clock-ins, completions, and job photos will show here.</div>
              ) : actFiltered.length === 0 ? (
                <div style={{ fontSize: 12.5, color: '#9aa69e' }}>Nothing matches “{actSearch.trim()}”.</div>
              ) : (
                <div style={{ maxHeight: 320, overflowY: 'auto', margin: '0 -6px' }}>
                  {actFiltered.map((e) => (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 6px', borderTop: '1px solid #f1f3f0', fontSize: 12.5 }}>
                      <span style={{ flex: 'none', width: 20, textAlign: 'center' }}>{e.icon}</span>
                      <span style={{ flex: 'none', fontWeight: 600, width: 92 }}>{e.type}</span>
                      <span style={{ flex: 1, minWidth: 0, color: '#5d6b63', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.message || e.address}>
                        {e.message
                          ? <><span style={{ color: '#1f7a4d', fontWeight: 600 }}>{e.kindLabel}</span>{e.status === 'new' ? <span style={{ color: '#c0492f', fontWeight: 700 }}> (new)</span> : null} — {e.message}</>
                          : <>{e.address || '—'}{e.route ? <span style={{ color: '#9aa69e' }}> · Rt {e.route}</span> : null}</>}
                      </span>
                      <span style={{ flex: 'none', color: '#9aa69e', fontFamily: MONO, fontSize: 11 }}>{fmtDate(e.ts)} · {fmtTime(e.ts)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {paymentsOk && cur.invoice && cur.invoice.amount != null && (
              <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>Payment link</div>
                    <div style={{ fontSize: 12, color: '#7c8a82' }}>Charge ${Number(cur.invoice.amount).toFixed(2)} — send the link to your customer.</div>
                  </div>
                  <button onClick={makePayLink} disabled={payBusy} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: payBusy ? 0.6 : 1 }}>{payBusy ? 'Creating…' : 'Create link'}</button>
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
            <Field label="Contact Name"><input value={form.contactName} onChange={(e) => set({ contactName: e.target.value })} style={inp} /></Field>
            <Field label="Address"><input value={form.address} onChange={(e) => set({ address: e.target.value })} style={inp} placeholder="123 Main St" /></Field>
            <div style={twoCol}>
              <Field label="Phone"><input value={form.phone} onChange={(e) => set({ phone: e.target.value })} style={inp} /></Field>
              <Field label="Email"><input value={form.email} onChange={(e) => set({ email: e.target.value })} style={inp} type="email" /></Field>
            </div>

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
            <Field label="Billing type">
              <select value={form.billingType} onChange={(e) => set({ billingType: e.target.value })} style={inp}>
                <option value="subscription">Subscription — recurring service</option>
                <option value="one_time">Single payment — one-time / on-demand</option>
              </select>
            </Field>
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

            <Field label="Text on service">
              <select value={NOTIFY_TO_STR(form.notifyOnService)} onChange={(e) => set({ notifyOnService: NOTIFY_FROM_STR(e.target.value) })} style={inp}>
                <option value="auto">Auto — notify only if this is their only property</option>
                <option value="always">Always text when we arrive</option>
                <option value="never">Never text</option>
              </select>
              <div style={{ fontSize: 11.5, color: '#7c8a82', marginTop: 4 }}>
                On "Auto", contacts tied to more than one property (e.g. a property manager) are skipped so they aren't texted for every stop.
              </div>
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
/* ─────────────────────────────────────────────────────────────────────────────
   Edit & Merge — one duplicate address, start to finish.
   Column 1: which copy stays.  Column 2: what to carry over from the other(s).
   Column 3: live preview of the record you'll end up with.
   ───────────────────────────────────────────────────────────────────────────── */
const isEmptyVal = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)
const MERGE_PROP_FIELDS = [
  { key: 'address', label: 'Address' },
  { key: 'service', label: 'Service' },
  { key: 'price', label: 'Price', fmt: (v) => (isEmptyVal(v) ? '—' : `$${Number(v).toFixed(2)}`) },
  { key: 'tech_pay', label: 'Tech pay', fmt: (v) => (isEmptyVal(v) ? '—' : `$${Number(v).toFixed(2)}`) },
  { key: 'pickup_frequency', label: 'Frequency', fmt: (v) => (isEmptyVal(v) ? '—' : freqLabel(v)) },
  { key: 'code', label: 'Import code' },
  { key: 'notes', label: 'Address notes', long: true },
]
const MERGE_CLIENT_FIELDS = [
  { key: 'contactName', label: 'Contact name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'address', label: 'Billing address' },
  { key: 'notes', label: 'Client notes', long: true },
]
const BOTH = '__both'
const joinBoth = (vals) => [...new Set(vals.filter((v) => !isEmptyVal(v)).map(String))].join('\n')

function MergeDuplicates({ group, customers, isMobile, onClose, onDone }) {
  const [rows, setRows] = useState([])
  const [counts, setCounts] = useState({})
  const [keepId, setKeepId] = useState(null)
  const [sel, setSel] = useState({})
  const [days, setDays] = useState([])
  const [delIds, setDelIds] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const clientOf = (p) => (p && p.customer_id ? customers.find((c) => c.id === p.customer_id) : null) || null
  const clientName = (p) => (clientOf(p) || {}).name || '(no client)'

  useEffect(() => {
    let alive = true
    setLoading(true)
    const ids = (group.properties || []).map((p) => p.id)
    const custIds = [...new Set((group.properties || []).map((p) => p.customer_id).filter(Boolean))]
    Promise.all([loadPropertiesByIds(ids), countPropertiesByCustomer(custIds)])
      .then(([full, cnt]) => {
        if (!alive) return
        const byId = {}
        for (const r of full) byId[r.id] = r
        const ordered = ids.map((id) => byId[id]).filter(Boolean)
        setRows(ordered)
        setCounts(cnt)
        // Default survivor = the most complete record, oldest wins a tie.
        const score = (p) => (p.customer_id ? 4 : 0) + ((p.pickup_days || []).length ? 2 : 0) + (p.price != null ? 2 : 0) +
          (p.service ? 1 : 0) + (p.notes ? 1 : 0) + (p.code ? 1 : 0)
        const best = [...ordered].sort((a, b) => score(b) - score(a) || String(a.created_at || '').localeCompare(String(b.created_at || '')))[0]
        setKeepId(best ? best.id : null)
      })
      .catch((e) => alive && setErr(e.message || String(e)))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [group])

  // Picking a different survivor resets every choice to "keep its own value,
  // pull anything it's missing from the other copy".
  useEffect(() => {
    if (!rows.length || !keepId) return
    const keep = rows.find((r) => r.id === keepId)
    if (!keep) return
    const others = rows.filter((r) => r.id !== keepId)
    const next = {}
    for (const f of MERGE_PROP_FIELDS) {
      next[`p:${f.key}`] = keepId
      if (isEmptyVal(keep[f.key])) {
        const donor = others.find((o) => !isEmptyVal(o[f.key]))
        if (donor) next[`p:${f.key}`] = donor.id
      }
    }
    const kc = clientOf(keep)
    for (const f of MERGE_CLIENT_FIELDS) {
      next[`c:${f.key}`] = keepId
      if (isEmptyVal(kc && kc[f.key])) {
        const donor = others.find((o) => !isEmptyVal((clientOf(o) || {})[f.key]))
        if (donor) next[`c:${f.key}`] = donor.id
      }
    }
    setSel(next)
    setDays(orderDays([...new Set(rows.flatMap((r) => r.pickup_days || []))]))
    setDelIds([])
  }, [keepId, rows])

  const keep = rows.find((r) => r.id === keepId) || null
  const others = rows.filter((r) => r.id !== keepId)
  const propOf = (id, key) => (rows.find((r) => r.id === id) || {})[key]
  const custOf = (id, key) => (clientOf(rows.find((r) => r.id === id)) || {})[key]
  const resolve = (kind, key) => {
    const pick = sel[`${kind}:${key}`]
    const read = kind === 'p' ? propOf : custOf
    if (pick === BOTH) return joinBoth(rows.map((r) => read(r.id, key)))
    return read(pick || keepId, key)
  }

  // Only surface a field when the copies actually disagree about it.
  const differing = (kind, fields) => fields.filter((f) => {
    const read = kind === 'p' ? propOf : custOf
    const vals = rows.map((r) => (isEmptyVal(read(r.id, f.key)) ? '' : String(read(r.id, f.key))))
    return new Set(vals).size > 1
  })
  const propRows = keep ? differing('p', MERGE_PROP_FIELDS) : []
  const clientRows = keep ? differing('c', MERGE_CLIENT_FIELDS) : []

  // Clients that would be left with nothing to service once the merge lands.
  const emptied = !keep ? [] : [...new Set(others.map((o) => o.customer_id).filter(Boolean))]
    .filter((cid) => cid !== keep.customer_id)
    .map((cid) => ({
      id: cid,
      name: (customers.find((c) => c.id === cid) || {}).name || '(no client)',
      left: (counts[cid] || 0) - others.filter((o) => o.customer_id === cid).length,
    }))
    .filter((c) => c.left <= 0)

  async function apply() {
    if (!keep || busy) return
    const removeIds = others.map((o) => o.id)
    const dels = emptied.filter((c) => delIds.includes(c.id))
    const msg = `Merge ${rows.length} copies of "${resolve('p', 'address') || keep.address}" into one record under ${clientName(keep)}?` +
      (dels.length ? `\n\nThis also DELETES ${dels.map((d) => d.name).join(', ')} — ${dels.length === 1 ? 'that client is' : 'those clients are'} left with no addresses.` : '')
    if (!window.confirm(msg)) return
    setBusy(true); setErr(null)
    try {
      const propertyPatch = { needs_review: false, pickup_days: days }
      for (const f of MERGE_PROP_FIELDS) {
        const v = resolve('p', f.key)
        const cur = keep[f.key]
        if (isEmptyVal(v) && isEmptyVal(cur)) continue
        if (String(v ?? '') === String(cur ?? '')) continue
        propertyPatch[f.key] = isEmptyVal(v) ? null : v
      }
      const kc = clientOf(keep) || {}
      const customerPatch = {}
      for (const f of MERGE_CLIENT_FIELDS) {
        const v = resolve('c', f.key)
        if (isEmptyVal(v) && isEmptyVal(kc[f.key])) continue
        if (String(v ?? '') === String(kc[f.key] ?? '')) continue
        customerPatch[f.key] = isEmptyVal(v) ? null : v
      }
      await mergeDuplicateGroup({
        keepId: keep.id,
        removeIds,
        propertyPatch,
        customerId: keep.customer_id,
        customerPatch,
        deleteCustomers: dels,
      })
      onDone()
    } catch (e) {
      setErr(e.message || String(e))
      setBusy(false)
    }
  }

  const col = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: 13, minWidth: 0 }
  const colHead = { fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', marginBottom: 10 }
  const chip = (on) => ({
    border: `1px solid ${on ? '#1f7a4d' : '#dde2dd'}`, background: on ? '#eaf5ef' : '#fff', color: on ? '#1f7a4d' : '#55605a',
    borderRadius: 7, padding: '4px 9px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
  })

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(24,32,28,.45)', zIndex: 90, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: isMobile ? 0 : '28px 18px', overflowY: 'auto' }}>
      <div style={{ background: '#f7f9f7', borderRadius: isMobile ? 0 : 16, width: '100%', maxWidth: 1180, minHeight: isMobile ? '100%' : 0, boxShadow: '0 18px 60px rgba(0,0,0,.28)' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid #e6eae6', background: '#fff', borderRadius: isMobile ? 0 : '16px 16px 0 0' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{group.manual ? 'Edit & Merge clients' : 'Edit & Merge duplicate address'}</div>
            <div style={{ fontSize: 12.5, color: '#7c8a82', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {group.manual
                ? `Manual merge · ${group.count} clients — pick what stays, the rest is cleaned up`
                : `${(group.properties[0] && group.properties[0].address) || group.normalized} · ${group.count} copies`}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} style={{ flex: 'none', background: '#fff', border: '1px solid #dde2dd', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={apply} disabled={busy || loading || !keep} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 15px', fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy || loading || !keep ? .6 : 1 }}>
            {busy ? 'Merging…' : 'Edit & Merge'}
          </button>
        </div>

        {err && <div style={{ margin: '12px 18px 0', background: '#fdecea', border: '1px solid #f3c6c0', color: '#a3372a', borderRadius: 9, padding: '9px 12px', fontSize: 12.5 }}>{err}</div>}

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading both copies…</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1.15fr 1fr', gap: 14, padding: 18 }}>

            {/* 1 — which copy stays */}
            <div style={col}>
              <div style={colHead}>1 · WHICH ONE STAYS</div>
              {rows.map((p) => {
                const on = p.id === keepId
                return (
                  <label key={p.id} onClick={() => !busy && setKeepId(p.id)}
                    style={{ display: 'block', border: `1px solid ${on ? '#1f7a4d' : '#e6eae6'}`, background: on ? '#f2f9f5' : '#fff', borderRadius: 10, padding: '10px 12px', marginBottom: 9, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="radio" readOnly checked={on} style={{ accentColor: '#1f7a4d' }} />
                      <div style={{ fontSize: 13, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clientName(p)}</div>
                      {on && <span style={{ flex: 'none', fontSize: 10, fontWeight: 700, color: '#1f7a4d', letterSpacing: '.06em' }}>KEEPING</span>}
                    </div>
                    <div style={{ fontSize: 12, color: '#55605a', marginTop: 5 }}>{p.address || p.name}</div>
                    <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 3 }}>
                      {p.price != null ? `$${Number(p.price).toFixed(2)} · ` : ''}{daysLabel(p.pickup_days) || 'no pickup day'}{p.service ? ` · ${p.service}` : ''}
                    </div>
                    <div style={{ fontSize: 11, color: '#9aa69e', marginTop: 2 }}>{dupMeta(p)}{p.created_by ? ` · by ${p.created_by}` : ''}</div>
                  </label>
                )
              })}
              <div style={{ fontSize: 11.5, color: '#9aa69e', lineHeight: 1.45 }}>
                The other {others.length === 1 ? 'copy is' : 'copies are'} deleted. Any scheduled stops on {others.length === 1 ? 'it' : 'them'} move onto the copy you keep, so nothing falls off a route.
              </div>
            </div>

            {/* 2 — what to carry over */}
            <div style={col}>
              <div style={colHead}>2 · BRING OVER</div>

              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Pickup days</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                {DAYS.map((d) => {
                  const on = days.includes(d)
                  const from = rows.filter((r) => (r.pickup_days || []).includes(d)).map(clientName)
                  return (
                    <button key={d} type="button" disabled={busy}
                      onClick={() => setDays((cur) => orderDays(cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))}
                      title={from.length ? `On file from: ${from.join(', ')}` : 'Not on either copy — tick to add it'}
                      style={chip(on)}>{DAY_ABBR[d]}</button>
                  )
                })}
              </div>
              <div style={{ fontSize: 11, color: '#9aa69e', marginBottom: 14 }}>Both copies' days are ticked by default — untick anything that shouldn't be serviced.</div>

              {!propRows.length && !clientRows.length ? (
                <div style={{ fontSize: 12.5, color: '#9aa69e' }}>The copies match on everything else — nothing to choose.</div>
              ) : null}

              {propRows.length > 0 && <Divider>this address</Divider>}
              {propRows.map((f) => (
                <FieldPick key={`p-${f.key}`} field={f} rows={rows} keepId={keepId} value={sel[`p:${f.key}`]}
                  read={propOf} label={clientName} busy={busy}
                  onPick={(v) => setSel((s) => ({ ...s, [`p:${f.key}`]: v }))} />
              ))}

              {clientRows.length > 0 && <Divider>client record ({clientName(keep)})</Divider>}
              {clientRows.map((f) => (
                <FieldPick key={`c-${f.key}`} field={f} rows={rows} keepId={keepId} value={sel[`c:${f.key}`]}
                  read={custOf} label={clientName} busy={busy}
                  onPick={(v) => setSel((s) => ({ ...s, [`c:${f.key}`]: v }))} />
              ))}
            </div>

            {/* 3 — preview */}
            <div style={{ ...col, background: '#fbfdfb', border: '1px solid #cfe3d6' }}>
              <div style={colHead}>3 · YOU'LL END UP WITH</div>
              {!keep ? null : (
                <>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{clientName(keep)}</div>
                  <div style={{ fontSize: 12.5, color: '#55605a', marginTop: 2 }}>{resolve('p', 'address') || '—'}</div>
                  <div style={{ height: 10 }} />
                  {MERGE_CLIENT_FIELDS.map((f) => (
                    <PreviewRow key={`pc-${f.key}`} label={f.label} value={resolve('c', f.key)} fmt={f.fmt} />
                  ))}
                  <div style={{ borderTop: '1px solid #e6eae6', margin: '10px 0' }} />
                  <PreviewRow label="Pickup days" value={daysLabel(days)} />
                  {MERGE_PROP_FIELDS.filter((f) => f.key !== 'address').map((f) => (
                    <PreviewRow key={`pp-${f.key}`} label={f.label} value={resolve('p', f.key)} fmt={f.fmt} />
                  ))}
                  <PreviewRow label="Needs review" value="cleared" />
                  <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 10, lineHeight: 1.45 }}>
                    {others.length} {others.length === 1 ? 'copy' : 'copies'} deleted · stops moved onto this address · the duplicate warning clears.
                  </div>
                  {emptied.map((c) => (
                    <div key={c.id} style={{ marginTop: 10, background: '#fdf7f2', border: '1px solid #f0d9c8', borderRadius: 9, padding: '9px 11px' }}>
                      <div style={{ fontSize: 12, color: '#9a3412', fontWeight: 600 }}>{c.name} will have 0 addresses left.</div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, fontSize: 12, color: '#55605a', cursor: 'pointer' }}>
                        <input type="checkbox" disabled={busy} checked={delIds.includes(c.id)} style={{ accentColor: '#c0492f' }}
                          onChange={(e) => setDelIds((cur) => (e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id)))} />
                        Also delete this client
                      </label>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// One "which value wins" row: a button per copy, plus Both for free-text fields.
function FieldPick({ field, rows, keepId, value, read, label, busy, onPick }) {
  const fmt = (v) => (isEmptyVal(v) ? '—' : field.fmt ? field.fmt(v) : String(v))
  const filled = rows.filter((r) => !isEmptyVal(read(r.id, field.key)))
  const showBoth = field.long && new Set(filled.map((r) => String(read(r.id, field.key)))).size > 1
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: '#55605a', marginBottom: 4 }}>{field.label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {rows.map((r) => {
          const on = (value || keepId) === r.id
          return (
            <button key={r.id} type="button" disabled={busy} onClick={() => onPick(r.id)}
              style={{ textAlign: 'left', border: `1px solid ${on ? '#1f7a4d' : '#e6eae6'}`, background: on ? '#f2f9f5' : '#fff', borderRadius: 8, padding: '6px 9px', cursor: 'pointer' }}>
              <div style={{ fontSize: 12.5, color: '#22302a', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{fmt(read(r.id, field.key))}</div>
              <div style={{ fontSize: 10.5, color: '#9aa69e', marginTop: 1 }}>
                from {label(r)}{r.id === keepId ? ' · keeping' : ''}
              </div>
            </button>
          )
        })}
        {showBoth && (
          <button type="button" disabled={busy} onClick={() => onPick(BOTH)}
            style={{ textAlign: 'left', border: `1px solid ${value === BOTH ? '#1f7a4d' : '#e6eae6'}`, background: value === BOTH ? '#f2f9f5' : '#fff', borderRadius: 8, padding: '6px 9px', cursor: 'pointer', fontSize: 12, color: '#55605a' }}>
            Keep both (combined)
          </button>
        )}
      </div>
    </div>
  )
}

function PreviewRow({ label, value, fmt }) {
  const shown = isEmptyVal(value) ? '—' : fmt ? fmt(value) : String(value)
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '3px 0' }}>
      <div style={{ flex: 'none', width: 96, fontSize: 11.5, color: '#9aa69e' }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: shown === '—' ? '#c2cbc5' : '#22302a', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{shown}</div>
    </div>
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
