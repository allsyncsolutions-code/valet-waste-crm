import { useState } from 'react'
import { MONO, defaultSched, schedMatches } from '../data.js'

const DSHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DFULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export default function Schedule({ app }) {
  const isMobile = app.isMobile
  const [sc, setSc] = useState(defaultSched())
  const setSched = (patch) => setSc((cur) => ({ ...cur, ...patch }))

  const seg = (id, label) => {
    const on = sc.mode === id
    return { id, label, weight: on ? 600 : 500, bg: on ? '#fff' : 'transparent', color: on ? '#15281d' : '#7c8a82', shadow: on ? '0 1px 3px rgba(0,0,0,.1)' : 'none', select: () => setSched({ mode: id }) }
  }
  const schedModes = [seg('nth', 'Nth weekday'), seg('weekly', 'Weekly'), seg('interval', 'Alternating')]

  const weekdays = DSHORT.map((l, i) => {
    const on = !!sc.days[i]
    return {
      label: l, on, border: on ? '#1f7a4d' : '#dde2dd', bg: on ? '#1f7a4d' : '#fff', color: on ? '#fff' : '#5d6b63',
      toggle: () => {
        const d = { ...sc.days }
        if (d[i]) delete d[i]
        else d[i] = true
        if (Object.keys(d).length) setSched({ days: d })
      },
    }
  })

  const nthDefs = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], ['last', 'Last']]
  const nthChips = nthDefs.map(([k, label]) => {
    const on = !!sc.nths[k]
    return {
      label, border: on ? '#1f7a4d' : '#dde2dd', bg: on ? '#e7f1eb' : '#fff', color: on ? '#1f7a4d' : '#5d6b63',
      toggle: () => {
        const n = { ...sc.nths }
        if (n[k]) delete n[k]
        else n[k] = true
        setSched({ nths: n })
      },
    }
  })

  const intervalChips = [[1, 'Weekly'], [2, 'Every 2 wks'], [3, 'Every 3 wks'], [4, 'Every 4 wks']].map(([k, label]) => {
    const on = sc.interval === k
    return { label, border: on ? '#1f7a4d' : '#dde2dd', bg: on ? '#e7f1eb' : '#fff', color: on ? '#1f7a4d' : '#5d6b63', toggle: () => setSched({ interval: k }) }
  })

  const selDays = Object.keys(sc.days).map(Number).sort()
  const dayNames = selDays.map((d) => DFULL[d]).join(' & ')
  const dayNamesPl = selDays.map((d) => DFULL[d] + 's').join(' & ')
  let summary
  if (sc.mode === 'weekly') summary = 'Every ' + dayNamesPl
  else if (sc.mode === 'interval') summary = (sc.interval === 1 ? 'Every ' : sc.interval === 2 ? 'Every other ' : 'Every ' + sc.interval + ' weeks on ') + dayNames
  else {
    const order = ['1', '2', '3', '4', 'last']
    const labels = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', last: 'last' }
    const sel = order.filter((k) => sc.nths[k]).map((k) => labels[k])
    summary = 'Every ' + (sel.length ? sel.join(' & ') : '—') + ' ' + dayNames
  }

  // June 2026 calendar
  const Y = 2026, M = 5
  const first = new Date(Y, M, 1), startDow = first.getDay()
  const dim = new Date(Y, M + 1, 0).getDate()
  const hits = {}
  let hitCount = 0
  for (let d = 1; d <= dim; d++) { const dt = new Date(Y, M, d); if (schedMatches(dt, sc)) { hits[d] = true; hitCount++ } }
  const TODAY = 18
  const calCells = []
  for (let i = 0; i < 42; i++) {
    const dnum = i - startDow + 1
    if (dnum < 1 || dnum > dim) { calCells.push({ key: i, label: '', bg: 'transparent', color: 'transparent', border: 'none', weight: 400 }); continue }
    const hl = hits[dnum], today = dnum === TODAY
    calCells.push({ key: i, label: String(dnum), weight: hl ? 600 : 400, bg: hl ? '#1f7a4d' : 'transparent', color: hl ? '#fff' : dnum < TODAY ? '#bcc6bd' : '#3a463f', border: today ? '2px solid #1f7a4d' : '1px solid transparent' })
  }

  const start = new Date(Y, M, TODAY)
  const nextDates = []
  for (let i = 0; i < 120 && nextDates.length < 5; i++) {
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    if (schedMatches(dt, sc)) {
      const rel = i === 0 ? 'today' : 'in ' + i + 'd'
      nextDates.push({ mon: MON[dt.getMonth()], day: String(dt.getDate()), weekday: DFULL[dt.getDay()], rel })
    }
  }

  const weekdayLabel = sc.mode === 'weekly' ? 'PICKUP DAYS' : 'PICKUP DAY'
  const label = { fontFamily: MONO, fontSize: 10, letterSpacing: '.12em', color: '#7c8a82', margin: '18px 0 9px' }

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.15fr 1fr', gap: 18 }}>
      {/* editor */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, paddingBottom: 14, borderBottom: '1px solid #f0f2ef' }}>
          <div style={{ width: 36, height: 36, borderRadius: 9, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600 }}>NL</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Northgate Retail Park</div>
            <div style={{ fontSize: 12, color: '#7c8a82' }}>4yd dumpster ×4 · North Loop · $48 / stop</div>
          </div>
        </div>

        <div style={label}>CADENCE</div>
        <div style={{ display: 'flex', gap: 7, background: '#f4f5f3', borderRadius: 10, padding: 4 }}>
          {schedModes.map((m) => (
            <div key={m.id} onClick={m.select} style={{ flex: 1, textAlign: 'center', padding: '8px 6px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: m.weight, background: m.bg, color: m.color, boxShadow: m.shadow }}>{m.label}</div>
          ))}
        </div>

        <div style={label}>{weekdayLabel}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {weekdays.map((d, i) => (
            <div key={i} onClick={d.toggle} style={{ flex: 1, aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 600, border: `1px solid ${d.border}`, background: d.bg, color: d.color }}>{d.label}</div>
          ))}
        </div>

        {sc.mode === 'nth' && (
          <>
            <div style={label}>WHICH WEEKS OF THE MONTH</div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {nthChips.map((c) => (
                <div key={c.label} onClick={c.toggle} style={{ padding: '8px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 600, border: `1px solid ${c.border}`, background: c.bg, color: c.color }}>{c.label}</div>
              ))}
            </div>
          </>
        )}

        {sc.mode === 'interval' && (
          <>
            <div style={label}>REPEAT EVERY</div>
            <div style={{ display: 'flex', gap: 7 }}>
              {intervalChips.map((c) => (
                <div key={c.label} onClick={c.toggle} style={{ flex: 1, textAlign: 'center', padding: '9px 6px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, border: `1px solid ${c.border}`, background: c.bg, color: c.color }}>{c.label}</div>
              ))}
            </div>
          </>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 18 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.12em', color: '#7c8a82', marginBottom: 9 }}>ARRIVAL WINDOW</div>
            <div style={{ border: '1px solid #dde2dd', borderRadius: 9, padding: '9px 12px', fontSize: 13, fontFamily: MONO }}>7:00–8:00 AM</div>
          </div>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.12em', color: '#7c8a82', marginBottom: 9 }}>BILLING</div>
            <div style={{ border: '1px solid #dde2dd', borderRadius: 9, padding: '9px 12px', fontSize: 13 }}>Monthly batch</div>
          </div>
        </div>

        <div style={{ marginTop: 18, background: '#f3faf5', border: '1px solid #d6e7dd', borderRadius: 11, padding: '13px 15px' }}>
          <div style={{ fontSize: 11, color: '#1f7a4d', fontFamily: MONO, letterSpacing: '.08em', marginBottom: 6 }}>SUMMARY</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#15281d' }}>{summary}</div>
          <div style={{ fontSize: 12, color: '#5d6b63', marginTop: 5 }}>Billed monthly · est. {hitCount} pickups / mo · ${hitCount * 48}/mo</div>
        </div>

        <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
          <button style={{ flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: 11, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save schedule</button>
          <button onClick={() => app.askAi('Set up a recurring pickup for Northgate Retail Park every 1st & 3rd Monday')} style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '11px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>✦ Let AI set it</button>
        </div>
      </div>

      {/* preview */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>June 2026</div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: '#1f7a4d' }}>{hitCount} pickups</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 5, marginBottom: 6 }}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((h, i) => (
              <div key={i} style={{ textAlign: 'center', fontSize: 10, color: '#9aa69e', fontFamily: MONO }}>{h}</div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 5 }}>
            {calCells.map((c) => (
              <div key={c.key} style={{ aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, fontSize: 12, fontFamily: MONO, fontWeight: c.weight, background: c.bg, color: c.color, border: c.border }}>{c.label}</div>
            ))}
          </div>
        </div>

        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '16px 18px' }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 11 }}>Next pickups</div>
          {nextDates.map((n, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 0', borderTop: '1px solid #f0f2ef' }}>
              <div style={{ width: 34, height: 34, borderRadius: 8, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1, flex: 'none' }}>
                <div style={{ fontFamily: MONO, fontSize: 9 }}>{n.mon}</div>
                <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600 }}>{n.day}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{n.weekday}</div>
                <div style={{ fontSize: 11, color: '#7c8a82' }}>7:00–8:00 AM · $48</div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>{n.rel}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
