import { useState } from 'react'
import { MONO, teamData, TEAM_LINE_DEFS } from '../data.js'

function statusStyle(s) {
  if (s === 'Active') return ['#1f7a4d', '#e7f1eb']
  if (s === 'Off today') return ['#9aa69e', '#eef0ed']
  return ['#c08a2e', '#fdf2e0']
}

export default function Team({ app }) {
  const isMobile = app.isMobile
  const [assign, setAssign] = useState({})

  const members = teamData()
  const assignFor = (m) => assign[m.id] || { waste: m.lines.includes('waste'), junk: m.lines.includes('junk'), lawn: m.lines.includes('lawn') }
  const toggle = (m, lineId) => {
    const cur = { ...assignFor(m) }
    cur[lineId] = !cur[lineId]
    setAssign((a) => ({ ...a, [m.id]: cur }))
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: '#5d6b63' }}>Toggle the business lines each member works. Drivers and crews only see routes for their assigned lines.</div>
        </div>
        <button onClick={() => app.askAi('Add a new team member and assign them to a business line')} style={{ display: 'flex', alignItems: 'center', gap: 7, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>+</span> {isMobile ? 'Add' : 'Add member'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14 }}>
        {members.map((m) => {
          const a = assignFor(m)
          const [sc, sb] = statusStyle(m.status)
          const initials = m.name.split(' ').map((w) => w[0]).join('').slice(0, 2)
          return (
            <div key={m.id} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: '50%', background: m.avatar, color: '#dff0e6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 14, flex: 'none' }}>{initials}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: '#7c8a82' }}>{m.role}</div>
                </div>
                <div style={{ flex: 'none', fontSize: 10.5, fontWeight: 600, fontFamily: MONO, color: sc, background: sb, padding: '3px 9px', borderRadius: 20 }}>{m.status}</div>
              </div>
              <div style={{ fontSize: 11.5, color: '#9aa69e', fontFamily: MONO, margin: '10px 0 14px' }}>{m.contact}</div>
              <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '.12em', color: '#7c8a82', marginBottom: 8 }}>ASSIGNED BUSINESS LINES</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {TEAM_LINE_DEFS.map((ld) => {
                  const on = !!a[ld.id]
                  return (
                    <div key={ld.id} onClick={() => toggle(m, ld.id)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px 8px', borderRadius: 9, cursor: 'pointer', border: `1px solid ${on ? ld.border : '#e3e6e2'}`, background: on ? ld.bg : '#fff', color: on ? ld.color : '#9aa69e', fontSize: 12.5, fontWeight: 600 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? ld.color : '#c2ccc3', flex: 'none' }} />{ld.label}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
