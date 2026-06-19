import { useState } from 'react'
import { MONO, clientData, generateProperties, CLIENT_STOPS } from '../data.js'
import PropertyDrawer from './PropertyDrawer.jsx'

export default function Clients({ app }) {
  const isMobile = app.isMobile
  const cd = clientData()
  const [selClient, setSelClient] = useState('sp')
  const [propSearch, setPropSearch] = useState('')
  const [selProp, setSelProp] = useState(null)
  const [propTab, setPropTab] = useState('invoices')
  const [propEdits, setPropEdits] = useState({})

  const cur = cd.find((c) => c.id === selClient) || cd[0]
  const q = propSearch.toLowerCase().trim()
  const allProps = cur.pm ? generateProperties(cur.propCount) : []
  const props = q ? allProps.filter((p) => (p.name + ' ' + p.addr).toLowerCase().includes(q)) : allProps

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1.25fr', gap: 18 }}>
      {/* list */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 8 }}>
        <div style={{ position: 'relative', margin: '6px 6px 8px' }}>
          <input placeholder="Search 142 clients…" style={searchInput} />
          <div style={searchIcon}>⌕</div>
        </div>
        {cd.map((c) => {
          const on = c.id === cur.id
          return (
            <div key={c.id} onClick={() => { setSelClient(c.id); setPropSearch('') }} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 10px', borderRadius: 10, cursor: 'pointer', marginBottom: 2, background: on ? '#f3faf5' : '#fff', border: `1px solid ${on ? '#cfe0d5' : 'transparent'}` }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: c.tint, color: c.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 12, flex: 'none' }}>{c.initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                  {c.pm && <span style={{ flex: 'none', fontFamily: MONO, fontSize: 9, letterSpacing: '.05em', color: '#1f7a4d', background: '#e7f1eb', border: '1px solid #cfe0d5', padding: '1px 5px', borderRadius: 5 }}>PM</span>}
                </div>
                <div style={{ fontSize: 11, color: '#7c8a82' }}>{c.cadence}</div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#5d6b63' }}>{c.mrr}</div>
            </div>
          )
        })}
      </div>

      {/* detail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <div style={{ width: 48, height: 48, borderRadius: 11, background: cur.tint, color: cur.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 15, flex: 'none' }}>{cur.initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{cur.name}</div>
              <div style={{ fontSize: 12.5, color: '#7c8a82' }}>{cur.address}</div>
            </div>
            <button onClick={app.openAssistant} style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>✦ Ask AI</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginTop: 16 }}>
            <Stat label="Cadence" value={cur.cadence} />
            <Stat label="Billing" value="Monthly batch" />
            <Stat label="Lifetime" value={cur.ltv} mono />
          </div>
        </div>

        {/* PM properties */}
        {cur.pm && (
          <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Managed properties</div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#1f7a4d' }}>{props.length} of {cur.propCount}</div>
            </div>
            <div style={{ position: 'relative', marginBottom: 10 }}>
              <input value={propSearch} onChange={(e) => setPropSearch(e.target.value)} placeholder="Search properties by name or address…" style={searchInput} />
              <div style={searchIcon}>⌕</div>
            </div>
            <div style={{ maxHeight: 420, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
              {props.map((p) => (
                <div key={p.id} onClick={() => { setSelProp(p.id); setPropTab('invoices') }} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 8px', borderRadius: 9, borderBottom: '1px solid #f3f5f2', cursor: 'pointer' }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: '#eef2ef', color: '#5d6b63', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 11, flex: 'none' }}>{p.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: '#9aa69e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.addr}</div>
                  </div>
                  {!isMobile && (
                    <div style={{ textAlign: 'right', flex: 'none' }}>
                      <div style={{ fontSize: 11.5, fontWeight: 500, color: '#5d6b63' }}>{p.cadence}</div>
                      <div style={{ fontSize: 10, color: '#9aa69e', fontFamily: MONO }}>{p.service}</div>
                    </div>
                  )}
                  <div style={{ flex: 'none', fontSize: 9.5, fontWeight: 600, fontFamily: MONO, color: p.statusColor, background: p.statusBg, padding: '2px 7px', borderRadius: 5, width: 52, textAlign: 'center' }}>{p.status}</div>
                  <div style={{ flex: 'none', color: '#c2ccc3', fontSize: 14 }}>›</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* recent pickups for single-site clients */}
        {!cur.pm && (
          <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Recent pickups</div>
            {CLIENT_STOPS.map((cs, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid #f0f2ef' }}>
                <div style={{ width: 36, height: 36, borderRadius: 7, background: 'repeating-linear-gradient(45deg,#e4ebe5,#e4ebe5 5px,#dbe4dc 5px,#dbe4dc 10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#9aa69e', flex: 'none' }}>▦</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{cs.date} · {cs.service}</div>
                  <div style={{ fontSize: 11, color: '#7c8a82', fontFamily: MONO }}>in {cs.in} · out {cs.out} · {cs.driver}</div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, fontFamily: MONO, color: '#1f7a4d' }}>DONE</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selProp && (
        <PropertyDrawer
          isMobile={isMobile}
          base={allProps.find((p) => p.id === selProp)}
          edits={propEdits[selProp] || {}}
          setField={(patch) => setPropEdits((all) => ({ ...all, [selProp]: { ...(all[selProp] || {}), ...patch } }))}
          pmName={cur.name}
          tab={propTab}
          setTab={setPropTab}
          onClose={() => setSelProp(null)}
        />
      )}
    </div>
  )
}

function Stat({ label, value, mono }) {
  return (
    <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '11px 13px' }}>
      <div style={{ fontSize: 11, color: '#7c8a82' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13, marginTop: 3, fontFamily: mono ? MONO : 'inherit' }}>{value}</div>
    </div>
  )
}

export const searchInput = { width: '100%', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '9px 12px 9px 32px', fontSize: 16, outline: 'none' }
export const searchIcon = { position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e' }
