import { useEffect, useState } from 'react'
import { MONO } from '../data.js'
import { listTags, createTag, updateTag, deleteTag, tagUsageCounts, subscribeTags, TAG_COLORS } from '../lib/tagsData.js'
import { loadSettings, saveDepot, geocodeAddress, subscribeSettings } from '../lib/settingsData.js'

export default function Settings({ app }) {
  const isMobile = app.isMobile
  const [tags, setTags] = useState([])
  const [counts, setCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(TAG_COLORS[0])
  const [confirmId, setConfirmId] = useState(null)
  const [paletteFor, setPaletteFor] = useState(null)
  const [depot, setDepot] = useState({ name: '', address: '', lat: '', lng: '' })
  const [depotMsg, setDepotMsg] = useState(null)
  const [geoBusy, setGeoBusy] = useState(false)
  const [depotSaving, setDepotSaving] = useState(false)

  async function refresh() {
    const [t, c] = await Promise.all([listTags(), tagUsageCounts()])
    setTags(t)
    setCounts(c)
  }
  useEffect(() => {
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    const unsub = subscribeTags(() => refresh().catch(() => {}))
    return unsub
  }, [])

  useEffect(() => {
    const load = () => loadSettings().then((s) => {
      if (s) setDepot({ name: s.depot_name || '', address: s.depot_address || '', lat: s.depot_lat ?? '', lng: s.depot_lng ?? '' })
    }).catch(() => {})
    load()
    const unsub = subscribeSettings(load)
    return unsub
  }, [])

  async function geocode() {
    const q = depot.address.trim()
    if (!q) return
    setGeoBusy(true)
    setDepotMsg(null)
    try {
      const r = await geocodeAddress(q)
      setDepot((d) => ({ ...d, lat: r.lat.toFixed(6), lng: r.lng.toFixed(6) }))
      setDepotMsg({ type: 'ok', text: 'Found: ' + r.display })
    } catch (e) {
      setDepotMsg({ type: 'err', text: e.message || String(e) })
    } finally {
      setGeoBusy(false)
    }
  }
  async function saveLoc(e) {
    e.preventDefault()
    const lat = parseFloat(depot.lat)
    const lng = parseFloat(depot.lng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setDepotMsg({ type: 'err', text: 'Enter a valid latitude and longitude (use Look up, or type them in).' })
      return
    }
    setDepotSaving(true)
    setDepotMsg(null)
    try {
      await saveDepot({ name: depot.name.trim(), address: depot.address.trim(), lat, lng })
      setDepotMsg({ type: 'ok', text: 'Saved — the route map will start here.' })
    } catch (e) {
      setDepotMsg({ type: 'err', text: e.message || String(e) })
    } finally {
      setDepotSaving(false)
    }
  }

  async function addTag(e) {
    e.preventDefault()
    const n = newName.trim()
    if (!n) return
    try {
      await createTag(n, newColor)
      setNewName('')
      setNewColor(TAG_COLORS[0])
      await refresh()
    } catch (e2) {
      setErr(e2.message || String(e2))
    }
  }
  async function rename(id, name) {
    const n = (name || '').trim()
    if (!n) return refresh()
    try { await updateTag(id, { name: n }) } catch (e) { setErr(e.message || String(e)); refresh() }
  }
  async function recolor(id, color) {
    setPaletteFor(null)
    setTags((ts) => ts.map((t) => (t.id === id ? { ...t, color } : t)))
    try { await updateTag(id, { color }) } catch (e) { setErr(e.message || String(e)) }
  }
  async function remove(id) {
    if (confirmId !== id) { setConfirmId(id); return }
    setConfirmId(null)
    try { await deleteTag(id); await refresh() } catch (e) { setErr(e.message || String(e)) }
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      {/* starting location */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Starting location</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 16 }}>
          Your yard or depot. The route map centers here, and the optimizer starts every route from this point.
        </div>
        {depotMsg && (
          <div style={{ background: depotMsg.type === 'ok' ? '#eef7f1' : '#fdecea', border: '1px solid ' + (depotMsg.type === 'ok' ? '#cfe7da' : '#f3b7b0'), color: depotMsg.type === 'ok' ? '#1f7a4d' : '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 14 }}>{depotMsg.text}</div>
        )}
        <form onSubmit={saveLoc}>
          <SField label="Name"><input value={depot.name} onChange={(e) => setDepot((d) => ({ ...d, name: e.target.value }))} style={inp} placeholder="Main Yard" /></SField>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}><SField label="Address"><input value={depot.address} onChange={(e) => setDepot((d) => ({ ...d, address: e.target.value }))} style={inp} placeholder="123 Depot Rd, City, ST" /></SField></div>
            <button type="button" onClick={geocode} disabled={geoBusy || !depot.address.trim()} style={{ flex: 'none', marginBottom: 11, background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: geoBusy || !depot.address.trim() ? 0.6 : 1 }}>{geoBusy ? 'Looking…' : 'Look up'}</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
            <SField label="Latitude"><input value={depot.lat} onChange={(e) => setDepot((d) => ({ ...d, lat: e.target.value }))} style={inp} placeholder="44.804" /></SField>
            <SField label="Longitude"><input value={depot.lng} onChange={(e) => setDepot((d) => ({ ...d, lng: e.target.value }))} style={inp} placeholder="-93.278" /></SField>
          </div>
          <button type="submit" disabled={depotSaving} style={{ marginTop: 6, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: depotSaving ? 0.6 : 1 }}>{depotSaving ? 'Saving…' : 'Save location'}</button>
        </form>
      </div>

      {/* tags */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px' }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Tags</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 16 }}>
          Manage the shared tag list. Renaming or recoloring a tag updates it on every client that uses it.
        </div>

        {err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 14 }}>{err}</div>}

        {/* add new */}
        <form onSubmit={addTag} style={{ display: 'flex', gap: 8, marginBottom: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <button type="button" onClick={() => setPaletteFor(paletteFor === 'new' ? null : 'new')} title="Pick color" style={{ width: 34, height: 38, borderRadius: 9, border: '1px solid #dde2dd', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ width: 16, height: 16, borderRadius: '50%', background: newColor }} />
            </button>
            {paletteFor === 'new' && <Palette onPick={(c) => { setNewColor(c); setPaletteFor(null) }} />}
          </div>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New tag name…" style={{ ...inp, flex: 1, minWidth: 180 }} />
          <button type="submit" disabled={!newName.trim()} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: newName.trim() ? 1 : 0.6 }}>Add tag</button>
        </form>

        {loading && <div style={{ color: '#9aa69e', fontSize: 13 }}>Loading…</div>}
        {!loading && !tags.length && <div style={{ color: '#9aa69e', fontSize: 13 }}>No tags yet. Create one above.</div>}

        {tags.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 4px', borderTop: '1px solid #f0f2ef' }}>
            <div style={{ position: 'relative', flex: 'none' }}>
              <button onClick={() => setPaletteFor(paletteFor === t.id ? null : t.id)} title="Change color" style={{ width: 26, height: 26, borderRadius: '50%', background: t.color, border: '2px solid #fff', boxShadow: '0 0 0 1px #dde2dd', cursor: 'pointer' }} />
              {paletteFor === t.id && <Palette onPick={(c) => recolor(t.id, c)} />}
            </div>
            <input
              value={t.name}
              onChange={(e) => setTags((ts) => ts.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))}
              onBlur={() => rename(t.id, t.name)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              style={{ flex: 1, minWidth: 0, border: '1px solid transparent', borderRadius: 7, padding: '7px 9px', fontSize: 14, outline: 'none', background: '#f7f9f7' }}
            />
            {!isMobile && <div style={{ flex: 'none', fontFamily: MONO, fontSize: 11, color: '#9aa69e', width: 70, textAlign: 'right' }}>{counts[t.id] || 0} client{(counts[t.id] || 0) === 1 ? '' : 's'}</div>}
            <button onClick={() => remove(t.id)} style={{ flex: 'none', background: confirmId === t.id ? '#c0492f' : '#fff', color: confirmId === t.id ? '#fff' : '#c0492f', border: '1px solid #f0c9c2', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {confirmId === t.id ? 'Confirm' : 'Delete'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function Palette({ onPick }) {
  return (
    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 60, background: '#fff', border: '1px solid #e3e6e2', borderRadius: 10, padding: 8, display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 7, boxShadow: '0 10px 26px rgba(0,0,0,.16)' }}>
      {TAG_COLORS.map((c) => (
        <button key={c} onClick={() => onPick(c)} title={c} style={{ width: 24, height: 24, borderRadius: '50%', background: c, border: '2px solid #fff', boxShadow: '0 0 0 1px #dde2dd', cursor: 'pointer' }} />
      ))}
    </div>
  )
}

function SField({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 11 }}>
      <div style={{ fontSize: 11.5, color: '#5d6b63', marginBottom: 5, fontWeight: 500 }}>{label}</div>
      {children}
    </label>
  )
}

const inp = { width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '10px 12px', fontSize: 15, outline: 'none', boxSizing: 'border-box' }
