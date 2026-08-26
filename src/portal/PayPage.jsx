// Standalone invoice pay page — what an emailed/texted "pay link" opens.
// No portal tabs, no email sign-in: the slug + invoice id in the URL fetch
// exactly one invoice (portal fn `pay_info`) and render a Runner.js card
// form. The charge goes through the `payments` fn's charge_invoice, same as
// the in-portal Pay screen. A quiet link at the bottom leads to the full
// client portal for people who want the whole hub.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { loadRunner, tokenizeCard } from '../lib/runnerJs.js'
import { RichText } from '../components/RichText.jsx'

const GREEN = '#1f7a4d'
const money = (v) => `$${Number(v || 0).toFixed(2)}`
const fmtD = (ts) => { try { return new Date(ts + (String(ts).length === 10 ? 'T12:00:00' : '')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return ts } }

const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 14, padding: '16px 18px' }
const btnPrimary = { background: GREEN, color: '#fff', border: 'none', borderRadius: 9, padding: '12px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }

async function portalApi(body) {
  const { data, error } = await supabase.functions.invoke('portal', { body })
  if (error) {
    let msg = error.message || String(error)
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error } catch (e) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export default function PayPage({ slug, invoiceId }) {
  const [info, setInfo] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [paid, setPaid] = useState(null) // { saved } after a successful charge
  const [runnerReady, setRunnerReady] = useState(false)
  const [saveCard, setSaveCard] = useState(false)
  const runnerRef = useRef(null)
  const formRef = useRef(null)

  useEffect(() => {
    portalApi({ action: 'pay_info', slug, invoice_id: invoiceId })
      .then(setInfo)
      .catch((e) => setLoadErr(e.message || String(e)))
  }, [slug, invoiceId])

  const inv = info?.invoice
  const payment = info?.payment || {}
  const payable = inv && inv.status !== 'paid' && inv.status !== 'void' && payment.available

  useEffect(() => {
    if (!payable || !payment.publicKey || !formRef.current) return
    let cancelled = false
    loadRunner().then((Runner) => {
      if (cancelled || !formRef.current) return
      const r = new Runner()
      r.init({
        element: '#run-standalone-form',
        publicKey: payment.publicKey,
        mid: payment.mid,
        env: payment.env === 'uat' ? 'staging' : 'production',
        useExpiry: true,
        useCvv: true,
      })
      runnerRef.current = r
      setRunnerReady(true)
    }).catch((e) => setErr(e.message || String(e)))
    return () => { cancelled = true }
  }, [payable, payment.publicKey, payment.mid, payment.env])

  async function pay() {
    if (!runnerRef.current || !inv) return
    setBusy(true)
    setErr('')
    try {
      const t = await tokenizeCard(runnerRef.current)
      if (!t || (!t.account_token && !t.token)) { throw new Error(`Card entry incomplete.${t ? ` Card form said: ${JSON.stringify(t).slice(0, 300)}` : ' No response from the card form — hard-refresh the page and try again.'}`) }
      const { data, error } = await supabase.functions.invoke('payments', {
        body: {
          action: 'charge_invoice',
          invoice_id: String(inv.id),
          account_token: t.account_token || t.token,
          expiration: t.expiry,
          cvn: t.cvv,
          save_card: saveCard,
        },
      })
      if (error) {
        let msg = error.message || String(error)
        try { const j = await error.context?.json?.(); if (j?.error) msg = j.error } catch (_e) { /* keep msg */ }
        throw new Error(msg)
      }
      const res = data
      if (res && res.ok) {
        setPaid({ saved: !!res.saved })
      } else if (res && res.declined) {
        setErr(res.resp_text || 'Your card was declined. Please try another card.')
      } else {
        setErr((res && res.error) || 'Payment could not be completed.')
      }
    } catch (e) {
      setErr(e.message || String(e))
    }
    setBusy(false)
  }

  const shell = (inner) => (
    <div style={{ minHeight: '100vh', background: '#f2f5f1', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#1a2420' }}>
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '28px 14px 60px' }}>
        {inner}
        <div style={{ textAlign: 'center', marginTop: 22 }}>
          <a href={`/?portal=${encodeURIComponent(slug)}`} style={{ color: '#7c8a82', fontSize: 12.5, textDecoration: 'none' }}>
            View your full account (pickups, photos, invoices) →
          </a>
        </div>
      </div>
    </div>
  )

  if (loadErr) return shell(<div style={{ ...card, textAlign: 'center', color: '#c0492f', fontSize: 13.5 }}>{loadErr}</div>)
  if (!info) return shell(<div style={{ ...card, textAlign: 'center', color: '#9aa69e' }}>Loading…</div>)

  if (paid || inv.status === 'paid') {
    return shell(
      <div style={{ ...card, textAlign: 'center', padding: '28px 20px' }}>
        <div style={{ fontSize: 34 }}>✓</div>
        <div style={{ fontSize: 17, fontWeight: 800, color: GREEN, marginTop: 6 }}>Invoice {inv.number} is paid</div>
        <div style={{ fontSize: 13.5, color: '#5d6b63', marginTop: 8 }}>
          {paid ? <>Thank you! We've received your payment of <b>{money(inv.total)}</b>.{paid.saved ? ' Your card is saved for autopay.' : ''}</> : 'This invoice has already been paid — nothing else to do.'}
        </div>
      </div>,
    )
  }

  if (inv.status === 'void') {
    return shell(<div style={{ ...card, textAlign: 'center', color: '#9aa69e', fontSize: 13.5 }}>Invoice {inv.number} was voided — there's nothing to pay.</div>)
  }

  return shell(
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 9, padding: '9px 12px', fontSize: 13 }}>{err}</div>}

      {/* invoice document */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        {/* masthead: logo + business name (left) · contact info (right) */}
        <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
            {info?.company?.logo_url ? (
              <img src={info.company.logo_url} alt="logo" style={{ width: 46, height: 46, borderRadius: 10, objectFit: 'cover', border: '1px solid #e6eae6' }} />
            ) : (
              <div style={{ width: 46, height: 46, borderRadius: 10, background: GREEN, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 20, flex: 'none' }}>
                {(info?.company?.name || 'V')[0]}
              </div>
            )}
            <div style={{ fontWeight: 800, fontSize: 15.5, minWidth: 0 }}>{info?.company?.name || 'Valet Waste FL'}</div>
          </div>
          {(info?.company?.phone || info?.company?.email || info?.company?.address) && (
            <div style={{ textAlign: 'right', fontSize: 11, color: '#7c8a82', lineHeight: 1.55, flex: 'none' }}>
              {info.company.phone && <div>{info.company.phone}</div>}
              {info.company.email && <div>{info.company.email}</div>}
              {info.company.address && <div>{info.company.address}</div>}
            </div>
          )}
        </div>
        <div style={{ height: 4, background: `linear-gradient(90deg, ${GREEN}, #2ea56b)` }} />

        {/* title + number · bill to */}
        <div style={{ padding: '14px 18px 4px', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '.04em', color: '#15281d' }}>INVOICE</div>
            <div style={{ fontSize: 12.5, color: '#5d6b63', marginTop: 2 }}>{inv.number}</div>
            <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 5 }}>
              {inv.issue_date ? `Issued ${fmtD(inv.issue_date)}` : ''}{inv.due_date ? ` · Due ${fmtD(inv.due_date)}` : ''}
            </div>
          </div>
          <div style={{ minWidth: 150 }}>
            <div style={{ fontSize: 9.5, letterSpacing: '.1em', color: '#9aa69e', marginBottom: 3, fontWeight: 600 }}>BILL TO</div>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{info.customer_name}</div>
            {info.customer_email && <div style={{ fontSize: 11.5, color: '#5d6b63', marginTop: 2 }}>{info.customer_email}</div>}
            {info.customer_phone && <div style={{ fontSize: 11.5, color: '#5d6b63', marginTop: 2 }}>{info.customer_phone}</div>}
          </div>
        </div>

        {/* line items */}
        {(inv.items || []).length > 0 && (
          <div style={{ padding: '12px 18px 0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 34px 62px 68px', gap: 6, padding: '7px 8px', fontSize: 9.5, letterSpacing: '.08em', color: '#fff', background: GREEN, borderRadius: 8, fontWeight: 600 }}>
              <div>DESCRIPTION</div><div style={{ textAlign: 'center' }}>QTY</div><div style={{ textAlign: 'right' }}>PRICE</div><div style={{ textAlign: 'right' }}>AMOUNT</div>
            </div>
            {inv.items.map((it, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 34px 62px 68px', gap: 6, padding: '8px 8px', borderBottom: '1px solid #f5f6f4', alignItems: 'start' }}>
                <div style={{ fontSize: 12, color: '#1a2420' }}>
                  {it.title ? <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 1 }}>{it.title}</div> : null}
                  {it.description ? <RichText text={it.description} style={{ fontSize: 12, color: '#1a2420' }} /> : (it.title ? null : '—')}
                </div>
                <div style={{ textAlign: 'center', fontSize: 12, color: '#5d6b63', paddingTop: 1 }}>{it.quantity}</div>
                <div style={{ textAlign: 'right', fontSize: 12, color: '#5d6b63', paddingTop: 1 }}>{money(it.unit_price)}</div>
                <div style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, paddingTop: 1 }}>{money(it.amount)}</div>
              </div>
            ))}
            {Number(inv.discount) > 0 && (
              <div style={{ display: 'flex', gap: 10, padding: '6px 8px', fontSize: 12 }}>
                <div style={{ flex: 1, color: GREEN }}>Discount</div>
                <div style={{ color: GREEN }}>– {money(inv.discount)}</div>
              </div>
            )}
          </div>
        )}

        {/* total */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px 14px' }}>
          <div style={{ fontSize: 11, color: '#9aa69e' }}>Subtotal {money(inv.subtotal)}</div>
          <span style={{ flex: 1 }} />
          <div style={{ fontSize: 12.5, color: '#5d6b63' }}>Total due</div>
          <div style={{ fontWeight: 800, fontSize: 21 }}>{money(inv.total)}</div>
        </div>

        {/* notes + terms */}
        {(inv.notes || info.terms) && (
          <div style={{ margin: '0 18px', padding: '0 0 14px', borderTop: '1px solid #f0f2ef' }}>
            {inv.notes && (
              <>
                <div style={{ fontSize: 9.5, letterSpacing: '.1em', color: '#9aa69e', margin: '12px 0 4px', fontWeight: 600 }}>NOTES</div>
                <RichText text={inv.notes} style={{ fontSize: 12, color: '#5d6b63' }} />
              </>
            )}
            {info.terms && (
              <>
                <div style={{ fontSize: 9.5, letterSpacing: '.1em', color: '#9aa69e', margin: '12px 0 4px', fontWeight: 600 }}>TERMS &amp; CONDITIONS</div>
                <RichText text={info.terms} style={{ fontSize: 11, color: '#7c8a82' }} />
              </>
            )}
          </div>
        )}
      </div>

      {/* card form */}
      {!payment.available ? (
        <div style={{ ...card, background: '#faf3e2', border: '1px solid #ecd9a8', color: '#8a6414', fontSize: 13 }}>
          Online payment isn't available right now — please contact us to pay this invoice.
        </div>
      ) : (
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 10 }}>Pay with card</div>
          {/* Runner.js owns everything inside #run-standalone-form — React must
              never render children there, or Runner's iframe injection breaks
              React's reconciler (removeChild NotFoundError → blank page). The
              loading hint lives OUTSIDE the container as a sibling. */}
          <div ref={formRef}>
            <div id="run-standalone-form" style={{ minHeight: 64, marginBottom: 4 }} />
          </div>
          {!runnerReady && <div style={{ color: '#9aa69e', fontSize: 12.5, padding: '0 2px 8px' }}>Loading secure card form…</div>}
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, color: '#3c4a42', lineHeight: 1.5, cursor: 'pointer', marginTop: 8 }}>
            <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} style={{ marginTop: 3, width: 16, height: 16, accentColor: GREEN }} />
            <span>Save this card for autopay (charged automatically at the start of each month for open invoices).</span>
          </label>
          <button
            disabled={busy || !runnerReady}
            onClick={pay}
            style={{ ...btnPrimary, marginTop: 14, width: '100%', opacity: (busy || !runnerReady) ? 0.55 : 1 }}
          >{busy ? 'Processing…' : `Pay ${money(inv.total)}`}</button>
          <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 10, textAlign: 'center' }}>
            Card details are entered in a secure Run Payments form — we never see or store your card number.
          </div>
        </div>
      )}
    </div>,
  )
}
