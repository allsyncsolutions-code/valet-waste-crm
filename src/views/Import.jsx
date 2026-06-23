import { useEffect, useState } from 'react'
import { MONO } from '../data.js'
import { parseRows, loadClients, bulkImport, geocodeAll, pendingGeocodeCount } from '../lib/importData.js'
import { findDuplicateProperties } from '../lib/customersData.js'

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const FREQS = ['weekly', 'biweekly', 'monthly', 'on_call']

export default function Import({ app }) {
  const isMobile = app.isMobile

  const [clients, setClients] = useState([])
  const [clientName, setClientName] = useState('')
  const [service, setService] = useState('Trash / Recycle')
  const [price, setPrice] = useState('11')
  const [createSchedule, setCreateSchedule] = useState(true)
  const [pickupDay, setPickupDay] = useState('monday')
  const [pickupFreq, setPickupFreq] = useState('weekly')
  const [markReview, setMarkReview] = useState(false)
  const [text, setText] = useState('')

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState(null) // {inserted, duplicates}
  const [geo, setGeo] = useState(null) // {updated, remaining}
  const [pending, setPending] = useState(0)
  const [dupBusy, setDupBusy] = useState(false)
  const [dupGroups, setDupGroups] = useState(null) // null = not scanned yet; [] = none

  const rows = parseRows(text)

  async function refreshPending() {
    try { setPending(await pendingGeocodeCount()) } catch (e) {}
  }
  useEffect(() => {
    loadClients().then(setClients).catch(() => {})
    refreshPending()
  }, [])

  function onFile(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setText(String(reader.result || ''))
    reader.readAsText(file)
  }

  async function runImport() {
    if (busy) return
    setErr(''); setResult(null); setGeo(null)
    if (!clientName.trim()) { setErr('Enter the client name these properties belong to.'); return }
    if (!rows.length) { setErr('No property rows found — paste at least one address.'); return }
    setBusy(true)
    try {
      const res = await bulkImport({
        customer_name: clientName.trim(),
        default_service: service || null,
        price: price === '' ? null : Number(price),
        create_schedule: createSchedule,
        pickup_day: pickupDay,
        pickup_freq: pickupFreq,
        needs_review: markReview,
        properties: rows,
      })
      setResult({ inserted: res?.inserted ?? 0, duplicates: res?.duplicates ?? 0 })
      setText('')
      loadClients().then(setClients).catch(() => {})
      // Fill in coordinates in the background, throttled.
      setGeo({ updated: 0, remaining: null })
      await geocodeAll((p) => setGeo(p))
      refreshPending()
    } catch (e) {
      setErr((e && e.message) || String(e))
    }
    setBusy(false)
  }

  async function geocodeMissing() {
    if (busy) return
    setBusy(true); setErr(''); setGeo({ updated: 0, remaining: null })
    try { await geocodeAll((p) => setGeo(p)); refreshPending() }
    catch (e) { setErr((e && e.message) || String(e)) }
    setBusy(false)
  }

  async function scanDuplicates() {
    if (dupBusy) return
    setDupBusy(true); setErr('')
    try { setDupGroups(await findDuplicateProperties()) }
    catch (e) { setErr((e && e.message) || String(e)) }
    setDupBusy(false)
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ fontSize: 13, color: '#5d6b63', marginBottom: 16 }}>
        Paste a property list (or upload a file) to add many service locations to one client at once. Coordinates are filled in automatically after import.
        <div style={{ marginTop: 6 }}>
          The pickup day you choose below is applied to every property in this batch. For a client with addresses on different days (e.g. some Monday, some Thursday), import each day as a separate batch.
        </div>
      </div>

      {err && <div style={banner('#c0492f', '#fbeae6')}>{err}</div>}
      {result && (
        <div style={banner('#1f7a4d', '#e7f1eb')}>
          <b>Imported {result.inserted} {result.inserted === 1 ? 'property' : 'properties'}.</b>{' '}
          {geo && (geo.remaining == null
            ? 'Geocoding addresses…'
            : `Geocoded ${geo.updated}; ${geo.remaining} still without coordinates.`)}
          {result.duplicates > 0 && (
            <div style={{ marginTop: 8, color: '#9a3412' }}>
              ⚠ {result.duplicates} of these {result.duplicates === 1 ? 'address' : 'addresses'} already existed elsewhere. They were still imported — use <b>Scan for duplicates</b> below to review.
            </div>
          )}
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>Client</label>
            <input list="vw-clients" value={clientName} onChange={(e) => setClientName(e.target.value)} style={inp} placeholder="Ancient City Hideaways" />
            <datalist id="vw-clients">{clients.map((c) => <option key={c.id} value={c.name} />)}</datalist>
            <div style={hint}>Existing client name attaches to it; a new name creates the client.</div>
          </div>
          <div>
            <label style={lbl}>Default service</label>
            <input value={service} onChange={(e) => setService(e.target.value)} style={inp} placeholder="Trash / Recycle" />
          </div>
          <div>
            <label style={lbl}>Price per property</label>
            <input value={price} onChange={(e) => setPrice(e.target.value)} style={inp} placeholder="11" inputMode="decimal" />
          </div>
          <div>
            <label style={lbl}>Pickup schedule</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={createSchedule} onChange={(e) => setCreateSchedule(e.target.checked)} />
              <select value={pickupFreq} onChange={(e) => setPickupFreq(e.target.value)} disabled={!createSchedule} style={{ ...inp, flex: 1 }}>
                {FREQS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <select value={pickupDay} onChange={(e) => setPickupDay(e.target.value)} disabled={!createSchedule || pickupFreq === 'on_call'} style={{ ...inp, flex: 1 }}>
                {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={markReview} onChange={(e) => setMarkReview(e.target.checked)} style={{ marginTop: 2 }} />
          <span style={{ fontSize: 13, color: '#5d6b63' }}>
            <b style={{ color: '#c0492f' }}>Mark all as “Needs review.”</b> Use this for messy data — every property in this batch comes in flagged so the owner can go over the pricing/schedule. You (or Trashy Randy) clear the flag once each is correct.
          </span>
        </label>

        <div style={{ marginTop: 14 }}>
          <label style={lbl}>Properties</label>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={10}
            style={{ ...inp, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.5, resize: 'vertical' }}
            placeholder={'One per line:  CODE | Address, City Zip | Service | Bin location\n(only the address is required)\n\nTW | 302 Twelfth St, St. Augustine 32084 | Trash | West side behind gate\nLC | 402 Twelfth St, St. Augustine 32084 | Trash/Recycle | Under carport'}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            <label style={{ ...btnGhost, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Upload file
              <input type="file" accept=".txt,.csv,.tsv" onChange={(e) => onFile(e.target.files && e.target.files[0])} style={{ display: 'none' }} />
            </label>
            <div style={{ fontSize: 12.5, color: '#7c8a82' }}>
              {rows.length} {rows.length === 1 ? 'row' : 'rows'} detected
            </div>
          </div>
        </div>

        {rows.length > 0 && (
          <div style={{ marginTop: 14, border: '1px solid #eef0ed', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#7c8a82', padding: '8px 12px', background: '#f7f9f7' }}>PREVIEW (first 8)</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <tbody>
                {rows.slice(0, 8).map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f0f2ef' }}>
                    <td style={td}>{r.code || '—'}</td>
                    <td style={td}>{r.address}</td>
                    <td style={td}>{r.service || service}</td>
                    <td style={{ ...td, color: '#7c8a82' }}>{r.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 8 && <div style={{ fontSize: 12, color: '#7c8a82', padding: '8px 12px' }}>+ {rows.length - 8} more</div>}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={runImport} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.7 : 1 }}>
            {busy ? 'Working…' : `Import ${rows.length || ''} ${rows.length === 1 ? 'property' : 'properties'}`}
          </button>
          {pending > 0 && (
            <button onClick={geocodeMissing} disabled={busy} style={btnGhost}>Geocode missing ({pending})</button>
          )}
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 18, marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Duplicate addresses</div>
            <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 2 }}>Find the same address entered more than once — across all clients (ignores St/Street, punctuation, “, USA”).</div>
          </div>
          <button onClick={scanDuplicates} disabled={dupBusy} style={{ ...btnGhost, opacity: dupBusy ? 0.7 : 1 }}>{dupBusy ? 'Scanning…' : 'Scan for duplicates'}</button>
        </div>

        {dupGroups != null && (
          dupGroups.length === 0 ? (
            <div style={{ ...banner('#1f7a4d', '#e7f1eb'), marginTop: 14, marginBottom: 0 }}>No duplicate addresses found. 🎉</div>
          ) : (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#9a3412', marginBottom: 10 }}>
                {dupGroups.length} duplicate {dupGroups.length === 1 ? 'address' : 'addresses'} found.
              </div>
              <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {dupGroups.map((g) => (
                  <div key={g.normalized} style={{ border: '1px solid #f0d9c8', borderRadius: 10, padding: '10px 12px', background: '#fdf7f2' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>{(g.properties[0] && g.properties[0].address) || g.normalized} <span style={{ color: '#9a3412', fontWeight: 600 }}>· {g.count}×</span></div>
                    {g.properties.map((p) => (
                      <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '3px 0', color: '#5d6b63' }}>
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.customer_name || '(no client)'} — {p.address}
                        </span>
                        <span style={{ flex: 'none', display: 'flex', gap: 8, alignItems: 'center' }}>
                          {p.price != null && <span>${Number(p.price).toFixed(2)}</span>}
                          {p.needs_review && <span style={{ color: '#c0492f', fontWeight: 700 }}>⚠</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 10 }}>Open the client in the Clients tab to merge or delete the extra copy.</div>
            </div>
          )
        )}
      </div>
    </div>
  )
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#5d6b63', marginBottom: 6 }
const hint = { fontSize: 11.5, color: '#9aa69e', marginTop: 4 }
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '10px 12px', fontSize: 15, color: '#1a2420', outline: 'none' }
const td = { padding: '8px 12px', textAlign: 'left', verticalAlign: 'top' }
const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '11px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }
const btnGhost = { background: '#fff', color: '#1a2420', border: '1px solid #dde2dd', borderRadius: 9, padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const banner = (color, bg) => ({ background: bg, color, border: `1px solid ${color}33`, borderRadius: 10, padding: '12px 14px', fontSize: 13, marginBottom: 14 })
