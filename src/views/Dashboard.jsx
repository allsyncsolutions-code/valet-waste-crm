import { MONO, KPIS, DASH_ROUTES, ALERTS } from '../data.js'

export default function Dashboard({ app }) {
  const { isMobile, go } = { isMobile: app.isMobile, go: app.go }
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(5,1fr)', gap: isMobile ? 10 : 14, marginBottom: 18 }}>
        {KPIS.map((k) => (
          <div key={k.label} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '15px 16px' }}>
            <div style={{ fontSize: 11.5, color: '#7c8a82', marginBottom: 9, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: k.dot }} />
              {k.label}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 25, fontWeight: 600, color: '#15281d', lineHeight: 1 }}>{k.value}</div>
            <div style={{ fontSize: 11, color: k.deltaColor, marginTop: 7 }}>{k.delta}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.55fr 1fr', gap: 18 }}>
        {/* routes */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '4px 4px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px' }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Today's routes</div>
            <div onClick={() => go('routes')} style={{ fontSize: 12, color: '#1f7a4d', cursor: 'pointer', fontWeight: 500 }}>Open dispatch →</div>
          </div>
          {DASH_ROUTES.map((r) => (
            <div key={r.code} onClick={() => go('routes')} style={{ margin: '0 8px 8px', border: '1px solid #edf0ec', borderRadius: 11, padding: '13px 14px', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <div style={{ width: 38, height: 38, borderRadius: 9, background: r.tint, color: r.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 13, flex: 'none' }}>{r.code}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.name}</div>
                  <div style={{ fontSize: 11.5, color: '#7c8a82' }}>{r.driver} · {r.truck}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: r.statusColor }}>{r.statusLabel}</div>
                  <div style={{ fontSize: 11, color: '#7c8a82' }}>{r.etaText}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 11 }}>
                <div style={{ flex: 1, height: 6, borderRadius: 4, background: '#edf0ec', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: r.pct, background: r.color, borderRadius: 4 }} />
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: '#5d6b63' }}>{r.progress}</div>
              </div>
            </div>
          ))}
        </div>

        {/* right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* AI insight */}
          <div style={{ background: 'linear-gradient(150deg,#173d2a,#0f2a1d)', borderRadius: 13, padding: 16, color: '#dff0e6', position: 'relative', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ width: 22, height: 22, borderRadius: 7, background: 'rgba(255,255,255,.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>✦</div>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#fff' }}>AI insight</div>
              <div style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 9, letterSpacing: '.1em', color: '#7fb89a' }}>LIVE</div>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: '#cfe6d8' }}>
              Truck 7 is 22 min behind on Route B. Re-sequencing saves <b style={{ color: '#fff' }}>~14 min</b> and fits the new Cedar Industrial pickup without overtime.
            </div>
            <button onClick={app.openAssistant} style={{ marginTop: 13, background: '#46c585', color: '#08120c', border: 'none', borderRadius: 8, padding: '8px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Review with AI →</button>
          </div>

          {/* mini map */}
          <div onClick={() => go('routes')} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '14px 16px', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Live map</div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#1f7a4d' }}>3 trucks active</div>
            </div>
            <svg viewBox="0 0 360 200" style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 9, background: '#eef2ee' }}>
              <rect width="360" height="200" fill="#eef2ee" />
              <g stroke="#dde3dd" strokeWidth="2">
                <line x1="0" y1="46" x2="360" y2="46" /><line x1="0" y1="104" x2="360" y2="104" /><line x1="0" y1="158" x2="360" y2="158" />
                <line x1="66" y1="0" x2="66" y2="200" /><line x1="156" y1="0" x2="156" y2="200" /><line x1="248" y1="0" x2="248" y2="200" /><line x1="312" y1="0" x2="312" y2="200" />
              </g>
              <path d="M0,128 C70,120 120,150 360,138" stroke="#bcd3e6" strokeWidth="9" fill="none" opacity=".7" />
              <polyline points="40,168 66,104 156,90 200,46 248,104 312,150" fill="none" stroke="#1f7a4d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <g fill="#1f7a4d">
                <circle cx="66" cy="104" r="5" /><circle cx="156" cy="90" r="5" /><circle cx="200" cy="46" r="5" /><circle cx="248" cy="104" r="5" /><circle cx="312" cy="150" r="5" />
              </g>
              <g>
                <circle cx="40" cy="168" r="9" fill="#173d2a" />
                <circle cx="40" cy="168" r="9" fill="none" stroke="#46c585" strokeWidth="2">
                  <animate attributeName="r" values="9;15" dur="1.6s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values=".6;0" dur="1.6s" repeatCount="indefinite" />
                </circle>
              </g>
              <circle cx="156" cy="90" r="9" fill="#2f6db0" />
              <circle cx="248" cy="104" r="9" fill="#c08a2e" />
            </svg>
          </div>

          {/* alerts */}
          <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '14px 16px' }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 11 }}>Needs attention</div>
            {ALERTS.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '9px 0', borderTop: '1px solid #f0f2ef' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: a.color, marginTop: 5, flex: 'none' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{a.title}</div>
                  <div style={{ fontSize: 11.5, color: '#7c8a82' }}>{a.meta}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
