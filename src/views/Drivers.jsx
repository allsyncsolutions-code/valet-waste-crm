import { MONO, DRIVERS, FIELD_FEED } from '../data.js'

export default function Drivers({ app }) {
  const isMobile = app.isMobile
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr auto', gap: 24, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, order: isMobile ? 2 : 1 }}>
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 14, padding: '10px 12px 8px' }}>Active crews</div>
          {DRIVERS.map((d) => (
            <div key={d.initials} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 10, marginBottom: 2, border: '1px solid #f0f2ef' }}>
              <div style={{ position: 'relative' }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#3a5246', color: '#dff0e6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 13 }}>{d.initials}</div>
                <div style={{ position: 'absolute', bottom: -1, right: -1, width: 12, height: 12, borderRadius: '50%', background: d.dot, border: '2px solid #fff' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{d.name} · {d.truck}</div>
                <div style={{ fontSize: 11.5, color: '#7c8a82' }}>{d.status}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{d.done}</div>
                <div style={{ fontSize: 10.5, color: '#9aa69e' }}>stops done</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Field activity</div>
          <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 12 }}>Every stop is verified with check-in / check-out, GPS and photos.</div>
          {FIELD_FEED.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 11, padding: '10px 0', borderTop: '1px solid #f0f2ef' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: f.dot, marginTop: 5, flex: 'none' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13 }}><b>{f.who}</b> {f.action} <b>{f.where}</b></div>
                <div style={{ fontSize: 11, color: '#9aa69e', fontFamily: MONO }}>{f.time} · ⌖ {f.gps}</div>
              </div>
              {f.photo && <div style={{ width: 34, height: 34, borderRadius: 6, background: 'repeating-linear-gradient(45deg,#e4ebe5,#e4ebe5 5px,#dbe4dc 5px,#dbe4dc 10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9aa69e', flex: 'none' }}>▦</div>}
            </div>
          ))}
        </div>
      </div>

      {/* driver phone */}
      <div style={{ flex: 'none', order: isMobile ? 1 : 2, alignSelf: isMobile ? 'center' : 'start', marginBottom: isMobile ? 8 : 0 }}>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#7c8a82', marginBottom: 10, textAlign: 'center' }}>DRIVER APP — TRUCK 7</div>
        <div style={{ width: 312, maxWidth: '88vw', background: '#0c130f', borderRadius: 40, padding: 11, boxShadow: '0 24px 60px rgba(15,30,20,.28)' }}>
          <div style={{ background: '#f4f6f3', borderRadius: 30, overflow: 'hidden', position: 'relative' }}>
            <div style={{ height: 36, background: '#15201b', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', color: '#dfe9e3', fontSize: 12, fontFamily: MONO }}>
              <span>9:42</span><span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>▰▰▰ ⌁ ▮</span>
            </div>
            <div style={{ background: '#15201b', color: '#fff', padding: '0 18px 16px' }}>
              <div style={{ fontSize: 11, color: '#7fb89a', fontFamily: MONO }}>ROUTE B · STOP 5 OF 12</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 3 }}>Sunrise Medical Center</div>
              <div style={{ fontSize: 12, color: '#9fb3a8' }}>1840 Cedar Pkwy · gate code 4417</div>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#e7f1eb', border: '1px solid #cfe0d5', borderRadius: 11, padding: '11px 13px', marginBottom: 14 }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#1f7a4d', flex: 'none' }} />
                <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: '#15281d' }}>Checked in · 9:38 AM</div>
                <div style={{ fontSize: 11, color: '#1f7a4d', fontFamily: MONO }}>⌖ 4m</div>
              </div>
              <div style={{ fontSize: 11, color: '#7c8a82', marginBottom: 8, fontFamily: MONO, letterSpacing: '.06em' }}>PICKUP PHOTOS · 2 REQUIRED</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <div style={photoTile}>▦</div>
                <div style={photoTile}>▦</div>
                <div style={{ flex: 1, aspectRatio: '1', borderRadius: 11, border: '1.5px dashed #c2ccc3', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9aa69e', fontSize: 22 }}>+</div>
              </div>
              <button style={{ width: '100%', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 13, padding: 15, fontSize: 15, fontWeight: 700, cursor: 'pointer', marginBottom: 9 }}>Check out &amp; complete</button>
              <div style={{ display: 'flex', gap: 9 }}>
                <button style={{ flex: 1, background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 11, padding: 11, fontSize: 12.5, fontWeight: 600 }}>Add note</button>
                <button style={{ flex: 1, background: '#fff', border: '1px solid #f0d6d0', color: '#c0492f', borderRadius: 11, padding: 11, fontSize: 12.5, fontWeight: 600 }}>Report issue</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const photoTile = { flex: 1, aspectRatio: '1', borderRadius: 11, background: 'repeating-linear-gradient(45deg,#e4ebe5,#e4ebe5 6px,#dbe4dc 6px,#dbe4dc 12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9aa69e', fontSize: 18 }
