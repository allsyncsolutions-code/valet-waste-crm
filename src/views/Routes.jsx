import { useState } from 'react'
import { MONO, ROUTE_TABS_RAW, decorateStops } from '../data.js'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const TODAY_KEY = '2026-6-18'

function Proof() {
  const tile = { width: 42, height: 42, borderRadius: 7, background: 'repeating-linear-gradient(45deg,#e4ebe5,#e4ebe5 5px,#dbe4dc 5px,#dbe4dc 10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }
  return (
    <div style={{ display: 'flex', gap: 5 }}>
      <div style={tile}>▦</div>
      <div style={tile}>▦</div>
    </div>
  )
}

export default function RoutesView({ app }) {
  const isMobile = app.isMobile
  const [routeSel, setRouteSel] = useState(TODAY_KEY)
  const [weekOffset, setWeekOffset] = useState(0)
  const [activeTab, setActiveTab] = useState('B')

  const weekStart = new Date(2026, 5, 15 + weekOffset * 7) // Mon Jun 15 2026
  const days = []
  for (let i = 0; i < 7; i++) {
    const dt = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i)
    const key = dt.getFullYear() + '-' + (dt.getMonth() + 1) + '-' + dt.getDate()
    const selected = key === routeSel
    const isToday = key === TODAY_KEY
    const hasStops = dt.getDay() >= 1 && dt.getDay() <= 6
    days.push({
      key,
      dow: DOW[dt.getDay()], day: String(dt.getDate()),
      selected, hasStops, stopDot: selected ? '#1f7a4d' : '#9fc7b1',
      border: selected ? '#1f7a4d' : isToday ? '#cfe0d5' : '#e6eae6',
      bg: selected ? '#e7f1eb' : '#fff',
      dowColor: selected ? '#1f7a4d' : '#9aa69e',
      dayColor: selected ? '#15281d' : isToday ? '#1f7a4d' : '#3a463f',
    })
  }
  const monthLabel = MON[weekStart.getMonth()] + ' ' + weekStart.getFullYear()

  const routeTabs = ROUTE_TABS_RAW.map((t) => {
    const active = t.code === activeTab
    return { ...t, active, color: active ? '#fff' : '#1f7a4d', tint: active ? '#1f7a4d' : '#e7f1eb', border: active ? '#1f7a4d' : '#e6eae6', bg: active ? '#f3faf5' : '#fff', nameColor: '#1a2420' }
  })

  const stops = decorateStops()

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      {/* day picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '9px 11px' }}>
        <div onClick={() => setWeekOffset((o) => o - 1)} style={navBtn}>‹</div>
        {!isMobile && <div style={{ width: 78, flex: 'none', fontFamily: MONO, fontSize: 12, color: '#5d6b63', textAlign: 'center' }}>{monthLabel}</div>}
        <div style={{ flex: 1, display: 'flex', gap: 6 }}>
          {days.map((d) => (
            <div key={d.key} onClick={() => setRouteSel(d.key)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '7px 4px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${d.border}`, background: d.bg }}>
              <div style={{ fontSize: 10, fontFamily: MONO, color: d.dowColor }}>{d.dow}</div>
              <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color: d.dayColor }}>{d.day}</div>
              <div style={{ height: 5, display: 'flex', alignItems: 'center' }}>{d.hasStops && <div style={{ width: 5, height: 5, borderRadius: '50%', background: d.stopDot }} />}</div>
            </div>
          ))}
        </div>
        <div onClick={() => setWeekOffset((o) => o + 1)} style={navBtn}>›</div>
        {!isMobile && <div onClick={() => { setWeekOffset(0); setRouteSel(TODAY_KEY) }} style={{ flex: 'none', fontSize: 12, fontWeight: 600, color: '#1f7a4d', border: '1px solid #cfe0d5', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>Today</div>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {routeTabs.map((t) => (
          <div key={t.code} onClick={() => setActiveTab(t.code)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 13px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${t.border}`, background: t.bg }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: t.tint, color: t.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 12 }}>{t.code}</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: t.nameColor }}>{t.name}</div>
              <div style={{ fontSize: 10.5, color: '#7c8a82' }}>{t.driver}</div>
            </div>
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => app.askAi('Optimize Route B and fit in the new Cedar Industrial pickup')} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(135deg,#1f7a4d,#155e3a)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <span>✦</span> Optimize with AI
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.4fr 1fr', gap: 16 }}>
        {/* MAP */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, overflow: 'hidden' }}>
          <div style={{ position: 'relative' }}>
            <svg viewBox="0 0 640 460" style={{ width: '100%', height: 'auto', display: 'block', background: '#e9eee9' }}>
              <rect width="640" height="460" fill="#e9eee9" />
              <g stroke="#dbe2db" strokeWidth="2.5">
                <line x1="0" y1="70" x2="640" y2="70" /><line x1="0" y1="160" x2="640" y2="160" /><line x1="0" y1="250" x2="640" y2="250" /><line x1="0" y1="340" x2="640" y2="340" /><line x1="0" y1="410" x2="640" y2="410" />
                <line x1="90" y1="0" x2="90" y2="460" /><line x1="210" y1="0" x2="210" y2="460" /><line x1="330" y1="0" x2="330" y2="460" /><line x1="450" y1="0" x2="450" y2="460" /><line x1="560" y1="0" x2="560" y2="460" />
              </g>
              <g stroke="#cfd8cf" strokeWidth="6" fill="none" opacity=".55">
                <line x1="0" y1="250" x2="640" y2="250" /><line x1="330" y1="0" x2="330" y2="460" />
              </g>
              <path d="M-20,200 C140,180 220,300 360,290 C520,278 560,360 660,330" stroke="#bcd3e6" strokeWidth="14" fill="none" opacity=".6" />
              <text x="500" y="320" fontFamily="IBM Plex Mono" fontSize="11" fill="#8aa7bd">Cedar River</text>
              <polyline points="80,400 90,250 210,200 250,90 330,140 450,160 540,250 560,350" fill="none" stroke="#1f7a4d" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points="540,250 560,350 600,410" fill="none" stroke="#c08a2e" strokeWidth="3.5" strokeDasharray="7 6" strokeLinecap="round" />
              <g fontFamily="IBM Plex Mono" fontSize="12" fontWeight="600">
                {[['90', '250', '1'], ['210', '200', '2'], ['250', '90', '3'], ['330', '140', '4']].map(([x, y, n]) => (
                  <g key={n}><circle cx={x} cy={y} r="13" fill="#1f7a4d" /><text x={x} y={Number(y) + 4} fill="#fff" textAnchor="middle">{n}</text></g>
                ))}
                <g>
                  <circle cx="450" cy="160" r="14" fill="#173d2a" stroke="#46c585" strokeWidth="2" /><text x="450" y="164" fill="#fff" textAnchor="middle">5</text>
                  <circle cx="450" cy="160" r="14" fill="none" stroke="#46c585" strokeWidth="2">
                    <animate attributeName="r" values="14;24" dur="1.8s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values=".7;0" dur="1.8s" repeatCount="indefinite" />
                  </circle>
                </g>
                <g><circle cx="540" cy="250" r="13" fill="#9aa69e" /><text x="540" y="254" fill="#fff" textAnchor="middle">6</text></g>
                <g><circle cx="560" cy="350" r="13" fill="#9aa69e" /><text x="560" y="354" fill="#fff" textAnchor="middle">7</text></g>
                <g><rect x="586" y="396" width="28" height="28" rx="6" fill="#c08a2e" /><text x="600" y="414" fill="#fff" textAnchor="middle" fontSize="11">+</text></g>
              </g>
            </svg>
            <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(255,255,255,.94)', borderRadius: 9, padding: '8px 11px', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}>
              <div style={legendRow}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#1f7a4d' }} />Completed (4)</div>
              <div style={legendRow}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#173d2a', border: '2px solid #46c585' }} />Truck 7 — here now</div>
              <div style={legendRow}><span style={{ width: 9, height: 9, borderRadius: '50%', background: '#9aa69e' }} />Upcoming (3)</div>
              <div style={legendRow}><span style={{ width: 11, height: 11, borderRadius: 3, background: '#c08a2e' }} />New — Cedar Industrial</div>
            </div>
            <div style={{ position: 'absolute', bottom: 12, right: 12, background: 'rgba(21,40,29,.92)', color: '#dff0e6', borderRadius: 9, padding: '9px 12px', fontFamily: MONO, fontSize: 11 }}>
              <div>Route B · 18.4 mi · 6h 10m</div>
              <div style={{ color: '#7fb89a' }}>Truck 7 · Dana R. · +22 min</div>
            </div>
          </div>
        </div>

        {/* STOP TIMELINE */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '6px 4px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px 8px' }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Stop sequence</div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: '#7c8a82' }}>8 stops</div>
          </div>
          <div style={{ maxHeight: isMobile ? 'none' : 560, overflowY: 'auto', padding: '0 6px' }}>
            {stops.map((st, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 11, padding: '4px 8px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none', width: 26 }}>
                  <div style={{ width: 24, height: 24, borderRadius: '50%', background: st.numBg, color: st.numFg, border: st.numBorder, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 11, fontWeight: 600 }}>{st.num}</div>
                  <div style={{ flex: 1, width: 2, background: '#edf0ec', margin: '3px 0' }} />
                </div>
                <div style={{ flex: 1, paddingBottom: 13, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{st.client}</div>
                      <div style={{ fontSize: 11.5, color: '#7c8a82' }}>{st.detail}</div>
                    </div>
                    <div style={{ textAlign: 'right', flex: 'none' }}>
                      <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: st.statusColor }}>{st.statusLabel}</div>
                      <div style={{ fontSize: 10.5, color: '#9aa69e' }}>{st.window}</div>
                    </div>
                  </div>
                  {st.showProof && (
                    <div style={{ marginTop: 9, display: 'flex', gap: 7, alignItems: 'center' }}>
                      <Proof />
                      <div style={{ fontSize: 10.5, color: '#5d6b63', lineHeight: 1.45, fontFamily: MONO }}>
                        <div>in {st.checkIn} · out {st.checkOut}</div>
                        <div style={{ color: '#9aa69e' }}>⌖ {st.gps}</div>
                      </div>
                    </div>
                  )}
                  {st.isCurrent && (
                    <div style={{ marginTop: 9, display: 'flex', gap: 7 }}>
                      <button style={{ flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 7, padding: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Driver checking in…</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const navBtn = { width: 30, height: 30, flex: 'none', borderRadius: 8, border: '1px solid #e6eae6', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5d6b63', fontSize: 15 }
const legendRow = { display: 'flex', alignItems: 'center', gap: 7 }
