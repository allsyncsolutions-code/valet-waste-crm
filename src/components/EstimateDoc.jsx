// The estimate document — laid out exactly like an invoice (masthead, green
// bar, title + number, BILL TO, line-item table, totals, notes/terms), shared
// by three surfaces: the staff Invoices → Estimates detail, the client
// portal's Estimates tab, and the standalone accept page (/?portal=…&estimate=…).
// What's deliberately different from an invoice: no payment anything — the
// footer slot carries Accept / Decline (with an optional decline note)
// wherever customers can respond.
//
// Props:
//   estimate  { number, title?, status, lineItems, subtotal, total, notes?,
//               sentAt?, respondedAt?, responseNote? }
//             lineItems: [{ title?, description?, quantity, unitPrice, amount }]
//   customer  { name, email?, phone?, address? }
//   company   { name, logoUrl?, phone?, email?, address?, terms? }
//   children  — footer actions (rendered inside the card, hidden when printing)
import { RichText } from './RichText.jsx'

const GREEN = '#1f7a4d'
const MONO = "'IBM Plex Mono', monospace"
const money = (v) => `$${Number(v || 0).toFixed(2)}`
const fmtD = (ts) => { try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return ts } }

export const ESTIMATE_STATUS = {
  draft: { label: 'Draft', color: '#7c8a82', bg: '#eef0ed' },
  sent: { label: 'Awaiting approval', color: '#8a6414', bg: '#fdf2e0' },
  approved: { label: 'Accepted', color: '#1f7a4d', bg: '#e7f1eb' },
  declined: { label: 'Declined', color: '#c0492f', bg: '#fbeae6' },
  void: { label: 'Void', color: '#9a2c1e', bg: '#fdecea' },
}

export default function EstimateDoc({ estimate, customer, company, children }) {
  const est = estimate || {}
  const meta = ESTIMATE_STATUS[est.status] || ESTIMATE_STATUS.sent
  const items = est.lineItems || []
  const responded = est.status === 'approved' || est.status === 'declined'

  return (
    <div className="print-doc" style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, overflow: 'hidden' }}>
      {/* masthead: logo + business name (left) · contact info (right) · status */}
      <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          {company.logoUrl ? (
            <img src={company.logoUrl} alt="logo" style={{ width: 46, height: 46, borderRadius: 10, objectFit: 'cover', border: '1px solid #e6eae6' }} />
          ) : (
            <div style={{ width: 46, height: 46, borderRadius: 10, background: GREEN, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 20, flex: 'none' }}>
              {(company.name || 'V')[0]}
            </div>
          )}
          <div style={{ fontWeight: 800, fontSize: 15.5, minWidth: 0 }}>{company.name || 'Valet Waste FL'}</div>
        </div>
        {(company.phone || company.email || company.address) && (
          <div style={{ textAlign: 'right', fontSize: 11, color: '#7c8a82', lineHeight: 1.55, flex: 'none' }}>
            {company.phone && <div>{company.phone}</div>}
            {company.email && <div>{company.email}</div>}
            {company.address && <div>{company.address}</div>}
          </div>
        )}
        <span style={{ flex: 'none', fontFamily: MONO, fontSize: 10, letterSpacing: '.06em', color: meta.color, background: meta.bg, padding: '4px 10px', borderRadius: 7, fontWeight: 700 }}>
          {meta.label.toUpperCase()}
        </span>
      </div>
      <div style={{ height: 4, background: `linear-gradient(90deg, ${GREEN}, #2ea56b)` }} />

      {/* title + number · bill to */}
      <div style={{ padding: '14px 18px 4px', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '.04em', color: '#15281d' }}>
            ESTIMATE
            {est.status === 'approved' && <span style={{ fontSize: 10.5, letterSpacing: '.08em', color: '#fff', background: GREEN, borderRadius: 6, padding: '3px 8px', marginLeft: 9, verticalAlign: '3px' }}>ACCEPTED ✓</span>}
          </div>
          <div style={{ fontSize: 12.5, color: '#5d6b63', marginTop: 2 }}>{est.number}</div>
          {est.title && <div style={{ fontSize: 13, color: '#3d4a43', marginTop: 4, fontWeight: 600 }}>{est.title}</div>}
          <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 5 }}>
            {est.sentAt ? `Sent ${fmtD(est.sentAt)}` : `Created ${fmtD(est.createdAt)}`}
            {est.respondedAt ? ` · ${est.status === 'approved' ? 'accepted' : est.status === 'declined' ? 'declined' : 'responded'} ${fmtD(est.respondedAt)}` : ''}
          </div>
        </div>
        <div style={{ minWidth: 150 }}>
          <div style={{ fontSize: 9.5, letterSpacing: '.1em', color: '#9aa69e', marginBottom: 3, fontWeight: 600 }}>BILL TO</div>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{customer.name || 'Unknown customer'}</div>
          {customer.email && <div style={{ fontSize: 11.5, color: '#5d6b63', marginTop: 2 }}>{customer.email}</div>}
          {customer.phone && <div style={{ fontSize: 11.5, color: '#5d6b63', marginTop: 2 }}>{customer.phone}</div>}
          {customer.address && <div style={{ fontSize: 11.5, color: '#5d6b63', marginTop: 2 }}>{customer.address}</div>}
        </div>
      </div>

      {/* line items — same table as the invoice (QTY / PRICE / AMOUNT) */}
      <div style={{ padding: '12px 18px 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 44px 70px 76px', gap: 6, padding: '7px 9px', fontSize: 9.5, letterSpacing: '.08em', color: '#fff', background: GREEN, borderRadius: 8, fontWeight: 600 }}>
          <div>DESCRIPTION</div><div style={{ textAlign: 'center' }}>QTY</div><div style={{ textAlign: 'right' }}>PRICE</div><div style={{ textAlign: 'right' }}>AMOUNT</div>
        </div>
        {items.length === 0 && <div style={{ padding: '12px 0', color: '#9aa69e', fontSize: 12.5 }}>No line items.</div>}
        {items.map((it, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 44px 70px 76px', gap: 6, padding: '9px 9px', borderBottom: '1px solid #f5f6f4', alignItems: 'start' }}>
            <div style={{ fontSize: 12, color: '#1a2420' }}>
              {it.title ? <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 1 }}>{it.title}</div> : null}
              {it.description ? <RichText text={it.description} style={{ fontSize: 12, color: '#1a2420' }} /> : (it.title ? null : '—')}
            </div>
            <div style={{ textAlign: 'center', fontSize: 12, color: '#5d6b63', paddingTop: 1 }}>{it.quantity}</div>
            <div style={{ textAlign: 'right', fontSize: 12, color: '#5d6b63', paddingTop: 1 }}>{money(it.unitPrice)}</div>
            <div style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, paddingTop: 1 }}>{money(it.amount)}</div>
          </div>
        ))}
      </div>

      {/* totals */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px 14px' }}>
        <div style={{ fontSize: 11, color: '#9aa69e' }}>Subtotal {money(est.subtotal)}</div>
        <span style={{ flex: 1 }} />
        <div style={{ fontSize: 12.5, color: '#5d6b63' }}>Estimate total</div>
        <div style={{ fontWeight: 800, fontSize: 21 }}>{money(est.total)}</div>
      </div>

      {/* the customer's answer — where an invoice shows how it was paid */}
      {responded && (
        <div style={{ margin: '0 18px', background: est.status === 'approved' ? '#e7f1eb' : '#fbeae6', border: `1px solid ${est.status === 'approved' ? '#cfe7da' : '#f0cfc8'}`, borderRadius: 9, padding: '9px 12px', fontSize: 12.5 }}>
          <b style={{ color: est.status === 'approved' ? '#1f7a4d' : '#c0492f' }}>
            {est.status === 'approved' ? 'Accepted' : 'Declined'}{est.respondedAt ? ` ${fmtD(est.respondedAt)}` : ''}
          </b>
          {est.responseNote && <div style={{ marginTop: 2, color: '#5d6b63' }}>Their note: “{est.responseNote}”</div>}
        </div>
      )}

      {/* notes + terms (same sections as an invoice) */}
      {(est.notes || company.terms) && (
        <div style={{ margin: '0 18px', padding: '0 0 14px', borderTop: '1px solid #f0f2ef', marginTop: 14 }}>
          {est.notes && (
            <>
              <div style={{ fontSize: 9.5, letterSpacing: '.1em', color: '#9aa69e', margin: '12px 0 4px', fontWeight: 600 }}>NOTES</div>
              <RichText text={est.notes} style={{ fontSize: 12, color: '#5d6b63' }} />
            </>
          )}
          {company.terms && (
            <>
              <div style={{ fontSize: 9.5, letterSpacing: '.1em', color: '#9aa69e', margin: '12px 0 4px', fontWeight: 600 }}>TERMS &amp; CONDITIONS</div>
              <RichText text={company.terms} style={{ fontSize: 11, color: '#7c8a82' }} />
            </>
          )}
        </div>
      )}

      {/* footer actions (Accept / Decline on customer surfaces, staff actions
          in the CRM) — .print-hide keeps them off the printed/PDF document */}
      {children && <div className="print-hide" style={{ borderTop: '1px solid #f0f2ef', padding: '14px 18px', display: 'flex', gap: 9, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  )
}
