import { MONO, PORTAL_FEATURES } from '../data.js'

export default function Portal({ app }) {
  const isMobile = app.isMobile
  const proofRow = { width: 38, height: 38, borderRadius: 8, background: 'repeating-linear-gradient(45deg,#e4ebe5,#e4ebe5 5px,#dbe4dc 5px,#dbe4dc 10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#9aa69e' }
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'auto 1fr', gap: isMobile ? 24 : 32, alignItems: 'start', justifyItems: isMobile ? 'center' : 'stretch' }}>
      <div style={{ flex: 'none' }}>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#7c8a82', marginBottom: 10, textAlign: 'center' }}>CLIENT VIEW — NORTHGATE RETAIL</div>
        <div style={{ width: 330, maxWidth: '90vw', background: '#0c130f', borderRadius: 42, padding: 11, boxShadow: '0 24px 60px rgba(15,30,20,.28)' }}>
          <div style={{ background: '#f4f6f3', borderRadius: 32, overflow: 'hidden' }}>
            <div style={{ height: 34, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', color: '#15281d', fontSize: 12, fontFamily: MONO }}>
              <span>9:42</span><span>▰▰▰ ⌁ ▮</span>
            </div>
            <div style={{ padding: '16px 16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16 }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 11, height: 11, border: '2.5px solid #eafff2', borderRadius: '50%', borderRightColor: 'transparent' }} />
                </div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Northgate Retail</div>
                <div style={{ marginLeft: 'auto', fontSize: 11, color: '#7c8a82' }}>Hi, Sam</div>
              </div>
              <div style={{ background: 'linear-gradient(150deg,#1f7a4d,#155e3a)', borderRadius: 15, padding: '15px 16px', color: '#fff', marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: '#bfe6d0' }}>NEXT PICKUP</div>
                <div style={{ fontSize: 17, fontWeight: 700, marginTop: 3 }}>Monday, Jul 6 · 7–8 AM</div>
                <div style={{ fontSize: 12, color: '#cfe6d8', marginTop: 2 }}>4yd dumpster ×4 · 1st & 3rd Monday</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: 12 }}>
                  <div style={{ fontSize: 11, color: '#7c8a82' }}>Balance due</div>
                  <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 600, marginTop: 3 }}>$462.42</div>
                </div>
                <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: 12 }}>
                  <div style={{ fontSize: 11, color: '#7c8a82' }}>YTD spend</div>
                  <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 600, marginTop: 3 }}>$3,108</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#7c8a82', fontFamily: MONO, letterSpacing: '.06em', marginBottom: 8 }}>RECENT PICKUPS</div>
              <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
                {[['Jun 15 · completed', '7:12a · 2 photos · GPS verified'], ['Jun 1 · completed', '7:05a · 2 photos · GPS verified']].map(([t, s], i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', borderTop: i ? '1px solid #f0f2ef' : 'none' }}>
                    <div style={proofRow}>▦</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t}</div>
                      <div style={{ fontSize: 10.5, color: '#9aa69e', fontFamily: MONO }}>{s}</div>
                    </div>
                    <div style={{ color: '#1f7a4d', fontSize: 13 }}>›</div>
                  </div>
                ))}
              </div>
              <button style={{ width: '100%', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 13, padding: 14, fontSize: 14, fontWeight: 700, cursor: 'pointer', marginBottom: 9 }}>+ Request extra pickup</button>
              <button style={{ width: '100%', background: '#fff', border: '1px solid #dde2dd', color: '#15281d', borderRadius: 13, padding: 13, fontSize: 13.5, fontWeight: 600 }}>View &amp; pay invoices</button>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: isMobile ? 0 : 30 }}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>Every client gets a self-serve portal</div>
        <div style={{ fontSize: 13.5, color: '#5d6b63', lineHeight: 1.6, maxWidth: 440 }}>Clients log in to see upcoming pickups, their recurring schedule, GPS-verified check-in history with photos, and invoices — and can request an extra pickup that flows straight into your dispatch queue.</div>
        {PORTAL_FEATURES.map((p, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, background: '#fff', border: '1px solid #e6eae6', borderRadius: 11, padding: '13px 15px' }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flex: 'none' }}>{p.glyph}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{p.title}</div>
              <div style={{ fontSize: 11.5, color: '#7c8a82' }}>{p.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
