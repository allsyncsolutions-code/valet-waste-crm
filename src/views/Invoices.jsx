import { useState } from 'react'
import { MONO, invoiceData } from '../data.js'

export default function Invoices({ app }) {
  const isMobile = app.isMobile
  const data = invoiceData()
  const [selInvoice, setSelInvoice] = useState('ng')
  const [billMode, setBillMode] = useState('monthly')
  const [invFilter, setInvFilter] = useState('all')

  const cur = data.find((d) => d.id === selInvoice) || data[0]

  const seg = (id, label) => {
    const on = billMode === id
    return { id, label, weight: on ? 600 : 500, bg: on ? '#fff' : 'transparent', color: on ? '#15281d' : '#7c8a82', shadow: on ? '0 1px 3px rgba(0,0,0,.1)' : 'none' }
  }
  const fil = (id, label) => {
    const on = invFilter === id
    return { id, label, weight: on ? 600 : 500, bg: on ? '#15281d' : 'transparent', color: on ? '#fff' : '#7c8a82' }
  }
  const billModes = [seg('stop', 'Per stop'), seg('monthly', 'Monthly batch')]
  const invFilters = [fil('all', 'All'), fil('draft', 'Draft'), fil('sent', 'Sent'), fil('overdue', 'Overdue')]

  const lineItemAmt = cur.items.length ? (parseFloat(cur.subtotal.replace(/[$,]/g, '')) / cur.items.length).toFixed(2) : '0'

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3,1fr) auto', gap: 14, alignItems: 'center', marginBottom: 18 }}>
        <Kpi label="Outstanding" value="$31,480" sub="4 invoices overdue" subColor="#c0492f" />
        <Kpi label="June batch ready" value="$52,720" sub="142 clients · 1,084 stops" subColor="#7c8a82" />
        <Kpi label="Paid MTD" value="$84,200" valueColor="#1f7a4d" sub="▲ 8.4% vs May" subColor="#1f7a4d" />
        <button onClick={() => app.askAi('Generate the June monthly batch invoices for all waste clients')} style={{ gridColumn: isMobile ? 'span 2' : 'auto', height: 'fit-content', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'linear-gradient(135deg,#1f7a4d,#155e3a)', color: '#fff', border: 'none', borderRadius: 11, padding: '14px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>✦ Run June batch</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '.9fr 1.1fr', gap: 18 }}>
        {/* list */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 6 }}>
          <div style={{ display: 'flex', gap: 6, padding: '8px 8px 10px' }}>
            {invFilters.map((f) => (
              <div key={f.id} onClick={() => setInvFilter(f.id)} style={{ fontSize: 12, padding: '5px 12px', borderRadius: 7, cursor: 'pointer', fontWeight: f.weight, background: f.bg, color: f.color }}>{f.label}</div>
            ))}
          </div>
          {data.map((d) => {
            const on = d.id === cur.id
            return (
              <div key={d.id} onClick={() => setSelInvoice(d.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 12px', borderRadius: 10, cursor: 'pointer', marginBottom: 2, background: on ? '#f3faf5' : '#fff', border: `1px solid ${on ? '#cfe0d5' : 'transparent'}` }}>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: '#eef2ef', color: '#5d6b63', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 12, flex: 'none' }}>{d.initials}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.client}</div>
                  <div style={{ fontSize: 11, color: '#7c8a82', fontFamily: MONO }}>{d.number} · {d.stops} stops</div>
                </div>
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{d.amount}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, fontFamily: MONO, color: d.statusColor }}>{d.status}</div>
                </div>
              </div>
            )
          })}
        </div>

        {/* detail */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 5, gap: 12 }}>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#7c8a82' }}>{cur.number}</div>
              <div style={{ fontWeight: 700, fontSize: 18, marginTop: 3 }}>{cur.client}</div>
              <div style={{ fontSize: 12.5, color: '#7c8a82' }}>{cur.period} · monthly batch statement</div>
            </div>
            <div style={{ textAlign: 'right', flex: 'none' }}>
              <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600 }}>{cur.amount}</div>
              <div style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 600, fontFamily: MONO, color: cur.statusColor, background: cur.statusBg, padding: '2px 9px', borderRadius: 20, marginTop: 4 }}>{cur.status}</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 7, background: '#f4f5f3', borderRadius: 9, padding: 3, margin: '16px 0', width: 'fit-content' }}>
            {billModes.map((b) => (
              <div key={b.id} onClick={() => setBillMode(b.id)} style={{ padding: '6px 14px', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: b.weight, background: b.bg, color: b.color, boxShadow: b.shadow }}>{b.label}</div>
            ))}
          </div>

          <div style={{ border: '1px solid #eef0ed', borderRadius: 11, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr auto', gap: 10, padding: '9px 14px', background: '#f7f9f7', fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#7c8a82' }}>
              <div>DATE</div><div>SERVICE</div><div>AMOUNT</div>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {cur.items.map(([date, service, note], i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '64px 1fr auto', gap: 10, padding: '10px 14px', borderTop: '1px solid #f2f4f1', alignItems: 'center' }}>
                  <div style={{ fontFamily: MONO, fontSize: 11.5, color: '#5d6b63' }}>{date}</div>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{service}</div>
                    <div style={{ fontSize: 10.5, color: '#9aa69e' }}>{note}</div>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, textAlign: 'right' }}>${lineItemAmt}</div>
                </div>
              ))}
            </div>
            <div style={{ borderTop: '1px solid #eef0ed', padding: '11px 14px', background: '#fafdfb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#5d6b63', marginBottom: 5 }}><span>Subtotal ({cur.stops} stops)</span><span style={{ fontFamily: MONO }}>{cur.subtotal}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#5d6b63', marginBottom: 8 }}><span>Tax (7.0%)</span><span style={{ fontFamily: MONO }}>{cur.tax}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, paddingTop: 8, borderTop: '1px solid #eef0ed' }}><span>Total due</span><span style={{ fontFamily: MONO }}>{cur.amount}</span></div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
            <button style={{ flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: 11, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Send statement</button>
            <button style={{ background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '11px 15px', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Download PDF</button>
            <button onClick={() => app.askAi('Add the extra Cedar Industrial pickup to their June batch invoice')} style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '11px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>✦</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, valueColor = '#15281d', sub, subColor }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '14px 16px' }}>
      <div style={{ fontSize: 11.5, color: '#7c8a82', marginBottom: 7 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 23, fontWeight: 600, color: valueColor }}>{value}</div>
      <div style={{ fontSize: 11, color: subColor, marginTop: 5 }}>{sub}</div>
    </div>
  )
}
