import { MONO, ROUTE_NAMES } from '../data.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']

export default function PropertyDrawer({ isMobile, base, edits, setField, pmName, tab, setTab, onClose }) {
  if (!base) return null
  const cur = { ...base, ...edits }
  const i = base.idx

  const routeOpts = ['A', 'B', 'C'].map((code) => {
    const active = cur.route === code
    return { code, name: ROUTE_NAMES[code], active, border: active ? '#1f7a4d' : '#dde2dd', bg: active ? '#e7f1eb' : '#fff', color: active ? '#1f7a4d' : '#5d6b63', select: () => setField({ route: code, routeName: ROUTE_NAMES[code] }) }
  })
  const planOpts = [['stop', 'Per stop'], ['monthly', 'Monthly batch']].map(([id, label]) => {
    const active = cur.plan === id
    return { id, label, active, border: active ? '#1f7a4d' : '#dde2dd', bg: active ? '#e7f1eb' : '#fff', color: active ? '#1f7a4d' : '#5d6b63', select: () => setField({ plan: id }) }
  })

  const invoices = [5, 4, 3, 2].map((m, k) => {
    const stops = 4 + ((i + k) % 4)
    const amt = stops * cur.rate * 1.07
    const st = k === 0 ? (cur.plan === 'stop' ? 'OPEN' : 'DRAFT') : k === 1 ? 'SENT' : 'PAID'
    const sc = { OPEN: '#c08a2e', DRAFT: '#7c8a82', SENT: '#2f6db0', PAID: '#1f7a4d' }[st]
    return { period: MONTHS[m] + ' 2026', number: 'INV-2026-0' + (m + 1) + (100 + i), stops: stops + ' stops', amount: '$' + amt.toFixed(2), status: st, statusColor: sc }
  })
  const drivers = ['Marcus T.', 'Dana R.', 'Luis G.']
  const checkins = [15, 11, 8, 4, 1].map((d, k) => ({
    date: 'Jun ' + d, win: 7 + (i % 3) + ':' + (k % 6) + '4a', out: 7 + (i % 3) + ':' + ((k % 6) + 1) + '2a',
    driver: drivers[(i + k) % 3], gps: '44.8' + ((i + k) % 9) + ',-93.1' + (k % 9),
  }))
  const photos = [15, 15, 11, 11, 8, 4].map((d, k) => ({ label: 'Jun ' + d, sub: k % 2 ? 'after' : 'before' }))

  const statusColor = cur.statusColor || (cur.status === 'Active' ? '#1f7a4d' : '#9aa69e')
  const statusBg = cur.statusBg || (cur.status === 'Active' ? '#e7f1eb' : '#eef0ed')

  const tabDef = (id, label) => ({ id, label, weight: tab === id ? 600 : 500, color: tab === id ? '#15281d' : '#7c8a82', bd: tab === id ? '2px solid #1f7a4d' : '2px solid transparent' })
  const tabs = [tabDef('invoices', 'Invoices'), tabDef('checkins', 'Check-ins'), tabDef('photos', 'Photos')]

  const cap = { fontFamily: MONO, fontSize: 10, letterSpacing: '.12em', color: '#7c8a82', marginBottom: 9 }
  const proofTile = { width: 38, height: 38, borderRadius: 7, background: 'repeating-linear-gradient(45deg,#e4ebe5,#e4ebe5 5px,#dbe4dc 5px,#dbe4dc 10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#9aa69e' }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.34)', zIndex: 200 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 560, maxWidth: '92vw', background: '#f4f5f3', zIndex: 210, display: 'flex', flexDirection: 'column', boxShadow: '-24px 0 60px rgba(15,30,20,.22)', animation: 'slideIn .18s ease' }}>
        {/* header */}
        <div style={{ flex: 'none', background: '#fff', borderBottom: '1px solid #e6eae6', padding: '16px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 13 }}>
            <div onClick={onClose} style={{ fontSize: 13, color: '#7c8a82', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>‹ {pmName}</div>
            <div style={{ flex: 1 }} />
            <div onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#7c8a82', fontSize: 16 }}>✕</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 15, flex: 'none' }}>{cur.initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{cur.name}</div>
              <div style={{ fontSize: 12.5, color: '#7c8a82' }}>{cur.addr}</div>
            </div>
            <div onClick={() => setField({ status: cur.status === 'Active' ? 'Paused' : 'Active', statusColor: cur.status === 'Active' ? '#9aa69e' : '#1f7a4d', statusBg: cur.status === 'Active' ? '#eef0ed' : '#e7f1eb' })} style={{ flex: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: MONO, color: statusColor, background: statusBg, padding: '5px 11px', borderRadius: 20 }}>{cur.status} ⇄</div>
          </div>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px 28px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 18 }}>
            <Mini label="Route" value={cur.routeName || ROUTE_NAMES[cur.route]} />
            <Mini label="Cadence" value={cur.cadence} />
            <Mini label="Rate" value={'$' + cur.rate + (cur.plan === 'stop' ? ' / stop' : ' / pickup')} mono />
          </div>

          <div style={cap}>ROUTE ASSIGNMENT</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            {routeOpts.map((r) => (
              <div key={r.code} onClick={r.select} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${r.border}`, background: r.bg }}>
                <div style={{ width: 22, height: 22, borderRadius: 6, background: r.bg, border: `1px solid ${r.border}`, color: r.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 11, flex: 'none' }}>{r.code}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: r.color }}>{r.name}</div>
              </div>
            ))}
          </div>

          <div style={cap}>PAYMENT PLAN</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            {planOpts.map((pl) => (
              <div key={pl.id} onClick={pl.select} style={{ flex: 1, textAlign: 'center', padding: 11, borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 600, border: `1px solid ${pl.border}`, background: pl.bg, color: pl.color }}>{pl.label}</div>
            ))}
          </div>

          <div style={cap}>NOTES</div>
          <textarea value={cur.notes || ''} onChange={(e) => setField({ notes: e.target.value })} placeholder="Access instructions, gate codes, bin location, contacts…" style={{ width: '100%', minHeight: 74, resize: 'vertical', border: '1px solid #dde2dd', borderRadius: 10, padding: '11px 13px', fontSize: 16, lineHeight: 1.5, outline: 'none', background: '#fff', marginBottom: 20 }} />

          {/* tabs */}
          <div style={{ display: 'flex', gap: 18, borderBottom: '1px solid #e6eae6', marginBottom: 14 }}>
            {tabs.map((t) => (
              <div key={t.id} onClick={() => setTab(t.id)} style={{ padding: '8px 0', cursor: 'pointer', fontSize: 13, fontWeight: t.weight, color: t.color, borderBottom: t.bd, marginBottom: -1 }}>{t.label}</div>
            ))}
          </div>

          {tab === 'invoices' && invoices.map((iv, k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1px solid #e6eae6', borderRadius: 11, padding: '12px 14px', marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{iv.period}</div>
                <div style={{ fontSize: 11, color: '#9aa69e', fontFamily: MONO }}>{iv.number} · {iv.stops}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{iv.amount}</div>
                <div style={{ fontSize: 10, fontWeight: 600, fontFamily: MONO, color: iv.statusColor }}>{iv.status}</div>
              </div>
            </div>
          ))}

          {tab === 'checkins' && checkins.map((ci, k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1px solid #e6eae6', borderRadius: 11, padding: '12px 14px', marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 5, flex: 'none' }}>
                <div style={proofTile}>▦</div>
                <div style={proofTile}>▦</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{ci.date} · {ci.driver}</div>
                <div style={{ fontSize: 11, color: '#9aa69e', fontFamily: MONO }}>in {ci.win} · out {ci.out} · ⌖ {ci.gps}</div>
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, fontFamily: MONO, color: '#1f7a4d' }}>DONE</div>
            </div>
          ))}

          {tab === 'photos' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
              {photos.map((ph, k) => (
                <div key={k} style={{ aspectRatio: '1', borderRadius: 10, background: 'repeating-linear-gradient(45deg,#e4ebe5,#e4ebe5 7px,#dbe4dc 7px,#dbe4dc 14px)', position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'flex-end' }}>
                  <div style={{ width: '100%', background: 'linear-gradient(transparent,rgba(15,30,20,.6))', padding: '7px 9px', color: '#fff' }}>
                    <div style={{ fontSize: 11, fontWeight: 600 }}>{ph.label}</div>
                    <div style={{ fontSize: 9.5, fontFamily: MONO, color: '#cfe6d8' }}>{ph.sub}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{ flex: 'none', background: '#fff', borderTop: '1px solid #e6eae6', padding: '13px 20px calc(13px + env(safe-area-inset-bottom))', display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 10, padding: 12, fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>Save changes</button>
          <button onClick={onClose} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 10, padding: '12px 18px', fontSize: 13.5, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </>
  )
}

function Mini({ label, value, mono }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 10, padding: '11px 13px' }}>
      <div style={{ fontSize: 11, color: '#7c8a82' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13, marginTop: 3, fontFamily: mono ? MONO : 'inherit' }}>{value}</div>
    </div>
  )
}
