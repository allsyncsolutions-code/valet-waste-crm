// Standalone estimate page — what an emailed/texted "review & accept" link
// opens. The twin of the invoice pay page: no portal chrome, no sign-in; the
// slug + estimate id in the URL act as the bearer capability. Renders the
// estimate exactly like an invoice document, except instead of paying, the
// customer accepts or declines — with an optional note back (why they're
// declining, changes they want, …).
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import EstimateDoc from '../components/EstimateDoc.jsx'
import { printInvoiceDoc } from '../lib/printInvoice.js'

const GREEN = '#1f7a4d'
const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 14, padding: '16px 18px' }
const btnPrimary = { background: GREEN, color: '#fff', border: 'none', borderRadius: 9, padding: '12px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }
const btnDecline = { background: '#fff', color: '#c0492f', border: '1px solid #eccfc7', borderRadius: 9, padding: '12px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }
const inputStyle = { width: '100%', border: '1px solid #e6eae6', borderRadius: 9, padding: '11px 12px', fontSize: 14.5, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }

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

export default function EstimatePage({ slug, quoteId }) {
  const [info, setInfo] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [done, setDone] = useState(null) // 'approved' | 'declined'

  useEffect(() => {
    portalApi({ action: 'estimate_info', slug, quote_id: quoteId })
      .then(setInfo)
      .catch((e) => setLoadErr(e.message || String(e)))
  }, [slug, quoteId])

  async function respond(response) {
    setBusy(true)
    setErr('')
    try {
      await portalApi({ action: 'estimate_respond', slug, quote_id: quoteId, response, note: note.trim() })
      setDone(response)
    } catch (e) {
      setErr(e.message || String(e))
      // The estimate may have been answered already — reload the fresh state.
      portalApi({ action: 'estimate_info', slug, quote_id: quoteId }).then(setInfo).catch(() => {})
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

  const est = info.estimate
  const answered = done || est.status === 'approved' || est.status === 'declined'
  const canRespond = !done && est.status === 'sent'

  const doc = (
    <EstimateDoc
      estimate={{
        number: est.number,
        title: est.title,
        status: done || est.status,
        lineItems: (est.line_items || []).map((li) => ({
          title: li.title || '',
          description: li.description || '',
          quantity: Number(li.quantity || 1),
          unitPrice: Number(li.unit_price || 0),
          amount: Number(li.amount ?? Number(li.quantity || 1) * Number(li.unit_price || 0)),
        })),
        subtotal: est.subtotal,
        total: est.total,
        notes: est.notes,
        sentAt: est.sent_at,
        createdAt: est.created_at,
        respondedAt: est.responded_at,
        responseNote: est.response_note,
      }}
      customer={info.customer}
      company={{ ...info.company, terms: info.terms }}
    >
      {canRespond && (
        <>
          {noteOpen && (
            <div style={{ flexBasis: '100%' }}>
              <textarea
                value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                placeholder="Optional note back to us — especially handy if you're declining…"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </div>
          )}
          <button disabled={busy} onClick={() => respond('approved')} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Working…' : '✓ Accept estimate'}
          </button>
          <button disabled={busy} onClick={() => respond('declined')} style={{ ...btnDecline, opacity: busy ? 0.6 : 1 }}>
            Decline
          </button>
          {noteOpen || <button onClick={() => setNoteOpen(true)} style={{ background: 'none', border: 'none', color: '#7c8a82', fontSize: 13, cursor: 'pointer' }}>+ add a note</button>}
        </>
      )}
      {answered && !canRespond && (
        <button onClick={() => printInvoiceDoc(est.number, 'Estimate')} style={{ background: '#fff', border: '1px solid #cfe0d5', color: GREEN, borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>⬇ Download PDF</button>
      )}
    </EstimateDoc>
  )

  if (done === 'approved') {
    return shell(
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="print-hide" style={{ ...card, textAlign: 'center', padding: '22px 20px' }}>
          <div style={{ fontSize: 34 }}>✓</div>
          <div style={{ fontSize: 17, fontWeight: 800, color: GREEN, marginTop: 6 }}>Estimate {est.number} accepted</div>
          <div style={{ fontSize: 13.5, color: '#5d6b63', marginTop: 8 }}>Thank you! We've let the office know{note.trim() ? ` (with your note: “${note.trim()}”)` : ''} and they'll be in touch to get started.</div>
        </div>
        {doc}
      </div>,
    )
  }
  if (done === 'declined') {
    return shell(
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="print-hide" style={{ ...card, textAlign: 'center', padding: '22px 20px' }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: '#c0492f' }}>Estimate {est.number} declined</div>
          <div style={{ fontSize: 13.5, color: '#5d6b63', marginTop: 8 }}>
            No problem — thanks for letting us know.{note.trim() ? <> Your note: “{note.trim()}”</> : ''}
          </div>
        </div>
        {doc}
      </div>,
    )
  }

  return shell(
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 9, padding: '9px 12px', fontSize: 13 }}>{err}</div>}
      {est.status === 'void' && (
        <div style={{ ...card, background: '#faf3e2', border: '1px solid #ecd9a8', color: '#8a6414', fontSize: 13 }}>
          This estimate was voided by the office — nothing to accept.
        </div>
      )}
      {doc}
    </div>,
  )
}
