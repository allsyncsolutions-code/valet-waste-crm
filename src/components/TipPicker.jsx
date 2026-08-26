// Tip selector for customer invoice payments (PayPage + portal pay tab).
// Percent presets are computed from the invoice's pre-tip total; "Other"
// flips to a freeform dollar input. The parent only holds the resulting
// dollar amount (`tip`) — choice state lives here.
import { useState } from 'react'

const money = (v) => `$${Number(v || 0).toFixed(2)}`
const round2 = (v) => Math.round(Number(v) * 100) / 100
const PRESETS = [10, 15, 20]

export function TipPicker({ total, tip, setTip, green = '#1f7a4d' }) {
  const [mode, setMode] = useState('none') // 'none' | 10 | 15 | 20 | 'custom'
  const [custom, setCustom] = useState('')

  function choose(m) {
    setMode(m)
    if (m === 'none') { setTip(0); return }
    if (m === 'custom') return
    setTip(round2(Number(total || 0) * m / 100))
  }

  function onCustom(v) {
    setCustom(v)
    const n = parseFloat(v)
    setTip(isFinite(n) && n > 0 ? round2(Math.min(n, 1000)) : 0)
  }

  const chip = (active) => ({
    flex: 1, minWidth: 64, textAlign: 'center', borderRadius: 9, padding: '7px 4px 6px',
    background: active ? green : '#fff', color: active ? '#fff' : '#5d6b63',
    border: `1px solid ${active ? green : '#dde2dd'}`, cursor: 'pointer',
    fontSize: 12.5, fontWeight: 700, lineHeight: 1.3,
  })

  return (
    <div style={{ marginTop: 14, padding: '12px 12px 13px', background: '#f7faf8', border: '1px solid #e3ece6', borderRadius: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Add a tip <span style={{ fontWeight: 500, color: '#9aa69e' }}>(optional)</span></div>
      <div style={{ fontSize: 11.5, color: '#9aa69e', marginBottom: 9 }}>A little extra for the crew — always appreciated, never required.</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <div onClick={() => choose('none')} style={chip(mode === 'none')}>No tip</div>
        {PRESETS.map((p) => (
          <div key={p} onClick={() => choose(p)} style={chip(mode === p)}>
            <div>{p}%</div>
            <div style={{ fontSize: 10.5, fontWeight: 500, opacity: 0.85 }}>{money(round2(Number(total || 0) * p / 100))}</div>
          </div>
        ))}
        <div onClick={() => choose('custom')} style={chip(mode === 'custom')}>Other</div>
      </div>
      {mode === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
          <span style={{ fontSize: 12.5, color: '#5d6b63' }}>Tip amount</span>
          <div style={{ display: 'flex', alignItems: 'center', border: '1px solid #dde2dd', borderRadius: 8, background: '#fff' }}>
            <span style={{ padding: '0 0 0 9px', color: '#7c8a82', fontSize: 13 }}>$</span>
            <input
              value={custom}
              onChange={(e) => onCustom(e.target.value)}
              inputMode="decimal" type="number" min="0" max="1000" step="0.01" placeholder="0.00"
              style={{ border: 'none', outline: 'none', borderRadius: 8, padding: '7px 9px 7px 3px', fontSize: 13.5, width: 84, background: 'transparent' }}
            />
          </div>
        </div>
      )}
      {Number(tip) > 0 && (
        <div style={{ marginTop: 9, fontSize: 12, color: green, fontWeight: 600 }}>
          Tip {money(tip)} · new total {money(Number(total || 0) + Number(tip))}
        </div>
      )}
    </div>
  )
}
