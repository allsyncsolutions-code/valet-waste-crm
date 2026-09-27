import { useEffect, useState } from 'react'
import { MONO } from '../data.js'
import { STATUS_META, setRequestStatus, replyToRequestEmail, approveNewPropertyRequest, nextDateForDays } from '../lib/requestsData.js'
import { gmailStatus } from '../lib/gmailData.js'

// Open-ticket triage for client portal requests. Every request that isn't
// "done" shows here until a staff member marks it Scheduled (working on it)
// or Handled (closes the ticket). Reply by email sends from the connected
// company Gmail (Settings → Email).
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto' }
const modal = { maxWidth: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }
const inp = { width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '9px 11px', fontSize: 14, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }
const errorBox = { background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 12 }

const fmtWhen = (ts) => { try { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return String(ts || '') } }
const firstName = (name) => (name || '').split(/\s+/)[0] || 'there'
const daysOpen = (ts) => Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000))

export default function RequestTriage({ requests, onChanged, onClose, app }) {
  const [busyId, setBusyId] = useState(null)
  const [flash, setFlash] = useState('')
  const [gmail, setGmail] = useState(null) // null = checking
  const [replyFor, setReplyFor] = useState(null) // request id with the compose box open
  const [approveFor, setApproveFor] = useState(null) // request id with the approve panel open

  useEffect(() => { gmailStatus().then(setGmail).catch(() => setGmail({ connected: false })) }, [])

  function flashNote(msg) {
    setFlash(msg)
    setTimeout(() => setFlash((f) => (f === msg ? '' : f)), 3500)
  }

  async function mark(req, status) {
    setBusyId(req.id); setFlash('')
    try {
      await setRequestStatus(req, status)
      flashNote(status === 'done' ? `✓ Closed — ${req.name}'s request is handled.` : `📅 Marked scheduled — ${req.name}.`)
      await onChanged()
    } catch (e) { alert('Could not update the request: ' + (e.message || e)) }
    setBusyId(null)
  }

  return (
    <div onClick={() => !busyId && onClose()} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 620, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>📥 Open client requests</div>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: '#b3261e', background: '#fdecea', padding: '2px 8px', borderRadius: 6 }}>{requests.length} open</span>
        </div>
        <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 14, lineHeight: 1.5 }}>
          Every client request from the portal stays on this list until someone marks it <b>Handled</b> (closes it). Scheduled means it's on the books but not finished.
        </div>

        {flash && <div style={{ background: '#eef7f1', border: '1px solid #cfe7da', color: '#1f7a4d', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 12 }}>{flash}</div>}
        {gmail && !gmail.connected && (
          <div style={{ background: '#fdf2e0', border: '1px solid #f0dcb0', color: '#8a6320', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 12 }}>
            ✉️ To reply by email, connect the company Gmail in <b onClick={() => { onClose(); app.go('settings') }} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Settings → Email</b>. Until then you can still schedule / handle requests.
          </div>
        )}

        {requests.length === 0 && <div style={{ padding: '26px 10px', textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>All handled — nothing waiting. 🎉</div>}

        {requests.map((r) => {
          const st = STATUS_META[r.status] || STATUS_META.new
          const scheduled = r.status === 'scheduled'
          const d = daysOpen(r.createdAt)
          return (
            <div key={r.id} style={{ border: '1px solid #e6eae6', borderRadius: 12, padding: 14, marginBottom: 11 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: st.color, background: st.bg, padding: '2px 8px', borderRadius: 6 }}>{st.label.toUpperCase()}</span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{r.name}</span>
                <span style={{ fontSize: 11.5, color: '#9aa69e' }}>{r.kindLabel} · {fmtWhen(r.createdAt)}{d >= 1 ? ` · ${d}d old` : ''}</span>
                <span style={{ flex: 1 }} />
                {!r.notifiedAt && <span title="The staff email/push alert never went out for this one" style={{ fontSize: 11, color: '#b3261e', background: '#fdecea', borderRadius: 6, padding: '2px 7px' }}>⚠ never alerted</span>}
              </div>
              {r.addresses.length > 0 && (
                <div style={{ fontSize: 11.5, color: '#7c8a82', marginBottom: 5 }}>📍 {r.addresses.join('; ')}</div>
              )}
              {r.kind === 'new_property' && r.details && (
                <div style={{ background: '#f4f8f5', border: '1px solid #d9e8de', borderRadius: 10, padding: '10px 12px', marginBottom: 8, fontSize: 12.5, lineHeight: 1.6 }}>
                  <div><b>🏠 New address:</b> {r.details.address}</div>
                  <div><b>Service:</b> {(r.details.days || []).map((d) => d.slice(0, 3)).join(' & ')} · {FREQ_LABELS[r.details.frequency] || r.details.frequency || 'weekly'}</div>
                  {r.details.notes && <div style={{ whiteSpace: 'pre-wrap' }}><b>Access notes:</b> {r.details.notes}</div>}
                </div>
              )}
              {!(r.kind === 'new_property' && r.details) && (
                <div style={{ fontSize: 13, color: '#1a2420', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>
                  {r.message || (r.photoUrls?.length ? '(no description — photos only)' : '(no message — just the request)')}
                </div>
              )}
              {r.photoUrls?.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {r.photoUrls.map((u, i) => (
                    <a key={i} href={u} target="_blank" rel="noreferrer" title="Open full size">
                      <img src={u} alt={`request photo ${i + 1}`} style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: 9, border: '1px solid #e6eae6' }} />
                    </a>
                  ))}
                </div>
              )}
              {r.repliedAt && (
                <div style={{ fontSize: 11.5, color: '#1f7a4d', marginTop: 6 }}>✉️ Replied by email{r.repliedBy ? ` (${r.repliedBy})` : ''} — {fmtWhen(r.repliedAt)}</div>
              )}

              <div style={{ display: 'flex', gap: 7, marginTop: 11, flexWrap: 'wrap' }}>
                {r.kind === 'new_property' ? (
                  <button onClick={() => setApproveFor((id) => (id === r.id ? null : r.id))} disabled={busyId === r.id} style={{ ...primaryBtn }}>✅ Approve & schedule</button>
                ) : (
                  <button onClick={() => mark(r, 'scheduled')} disabled={busyId === r.id || scheduled} style={{ ...ghostBtn, color: scheduled ? '#9aa69e' : '#155e9c', borderColor: scheduled ? '#e6eae6' : '#155e9c55' }}>{scheduled ? '📅 Scheduled ✓' : '📅 Scheduled'}</button>
                )}
                <button onClick={() => mark(r, 'done')} disabled={busyId === r.id} style={r.kind === 'new_property' ? ghostBtn : primaryBtn}>{busyId === r.id ? 'Saving…' : '✓ Handled — close'}</button>
                <button onClick={() => setReplyFor((id) => (id === r.id ? null : r.id))} disabled={busyId === r.id} style={ghostBtn}>✉️ Reply by email</button>
                <span style={{ flex: 1 }} />
                <button onClick={() => { onClose(); app.openClient(r.customerId) }} style={{ ...ghostBtn, color: '#1f7a4d', borderColor: '#1f7a4d55' }}>Client →</button>
              </div>

              {approveFor === r.id && (
                <ApprovePanel req={r} busy={busyId === r.id} onBusy={(b) => setBusyId(b ? r.id : null)} onDone={async (msg) => { setApproveFor(null); flashNote(msg); await onChanged() }} onCancel={() => setApproveFor(null)} />
              )}

              {replyFor === r.id && (
                <ReplyBox req={r} gmail={gmail} onSent={async () => { setReplyFor(null); flashNote(`✉️ Reply sent to ${r.email}.`); await onChanged() }} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const ghostBtn = { background: '#fff', color: '#5d6b63', border: '1px solid #e6eae6', borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }
const primaryBtn = { background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }

const FREQ_LABELS = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', '1st_3rd': '1st & 3rd week', '2nd_4th': '2nd & 4th week' }
const DOW = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

// Inline approval panel for a new_property request (mig 0060): prefilled with
// the client's requested days/frequency/notes, staff can adjust, set price +
// start date, then one click creates the property and closes the ticket. The
// property lands on the Routes board via pickup_days and carries the NEW
// badge for 30 days.
function ApprovePanel({ req, busy, onBusy, onDone, onCancel }) {
  const d = req.details || {}
  const [days, setDays] = useState(d.days || [])
  const [frequency, setFrequency] = useState(d.frequency || 'weekly')
  const [startDate, setStartDate] = useState(nextDateForDays(d.days || []) || '')
  const [price, setPrice] = useState('')
  const [notes, setNotes] = useState(d.notes || '')
  const [err, setErr] = useState('')

  function toggleDay(day) {
    setDays((prev) => (prev.includes(day) ? prev.filter((x) => x !== day) : [...prev, day]))
  }

  async function approve() {
    if (!days.length) { setErr('Pick at least one service day.'); return }
    const p = price.trim()
    if (p && !Number.isFinite(Number(p))) { setErr('Price must be a number (or leave blank).'); return }
    setErr('')
    onBusy(true)
    try {
      await approveNewPropertyRequest(req, {
        days, frequency,
        startDate: startDate || undefined,
        price: p === '' ? undefined : Number(p),
        notes: notes.trim() || null,
      })
      onDone(`✅ Added to the schedule — ${d.address} starts ${startDate || nextDateForDays(days)}.`)
    } catch (e) {
      setErr(e.message || String(e))
      onBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 11, border: '1px solid #cfe0d5', borderRadius: 10, padding: 12, background: '#f8fbf9' }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Approve — goes straight onto the schedule</div>
      {err && <div style={errorBox}>{err}</div>}
      <div style={{ fontSize: 11.5, color: '#7c8a82', marginBottom: 5 }}>Service days</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
        {DOW.map((day) => {
          const on = days.includes(day)
          return (
            <button key={day} type="button" onClick={() => toggleDay(day)} style={{ background: on ? '#1f7a4d' : '#fff', color: on ? '#fff' : '#5d6b63', border: `1px solid ${on ? '#1f7a4d' : '#dde2dd'}`, borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{day.slice(0, 3)}</button>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 11.5, color: '#7c8a82', display: 'flex', alignItems: 'center', gap: 6 }}>
          Frequency
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)} style={{ ...inp, width: 'auto', padding: '7px 9px', fontSize: 13 }}>
            {Object.entries(FREQ_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 11.5, color: '#7c8a82', display: 'flex', alignItems: 'center', gap: 6 }}>
          First service
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ ...inp, width: 'auto', padding: '7px 9px', fontSize: 13 }} />
        </label>
        <label style={{ fontSize: 11.5, color: '#7c8a82', display: 'flex', alignItems: 'center', gap: 6 }}>
          Price $
          <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="optional" inputMode="decimal" style={{ ...inp, width: 90, padding: '7px 9px', fontSize: 13 }} />
        </label>
      </div>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Access notes — gate code, bin location…" style={{ ...inp, fontSize: 13, lineHeight: 1.5, resize: 'vertical', marginBottom: 10 }} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} disabled={busy} style={ghostBtn}>Cancel</button>
        <button onClick={approve} disabled={busy} style={primaryBtn}>{busy ? 'Adding…' : '✅ Approve & add'}</button>
      </div>
    </div>
  )
}

// Inline composer for one request. Sends through the connected company Gmail;
// the client's original message is quoted under whatever the staff member
// writes.
function ReplyBox({ req, gmail, onSent }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const subject = `Re: your ${req.kindLabel.toLowerCase()} request`
  const quote = `----- your request (${fmtWhen(req.createdAt)}) -----\n${req.message || '(no message)'}`

  async function send() {
    if (!text.trim()) { setErr('Write a short reply first.'); return }
    setBusy(true); setErr('')
    try {
      await replyToRequestEmail({
        requestId: req.id,
        customerId: req.customerId,
        customerName: req.name,
        to: req.email,
        subject,
        text: `${text.trim()}\n\n${quote}`,
      })
      onSent && onSent()
    } catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  if (!req.email) {
    return <div style={{ marginTop: 11, background: '#f7f9f7', border: '1px solid #e6eae6', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: '#7c8a82' }}>No email on file for this client — add one on their Client page to reply by email.</div>
  }

  return (
    <div style={{ marginTop: 11, border: '1px solid #cfe0d5', borderRadius: 10, padding: 12, background: '#f8fbf9' }}>
      <div style={{ fontSize: 11.5, color: '#7c8a82', marginBottom: 7 }}>
        To: <b style={{ color: '#1a2420' }}>{req.email}</b> · Subject: <b style={{ color: '#1a2420' }}>{subject}</b>
        {gmail?.connected && gmail?.email ? ` · from ${gmail.email}` : ''}
      </div>
      {err && <div style={errorBox}>{err}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        autoFocus
        placeholder={`Hi ${firstName(req.name)},\n\n…your reply…`}
        style={{ ...inp, fontSize: 13, lineHeight: 1.55, resize: 'vertical' }}
      />
      <div style={{ fontSize: 11, color: '#9aa69e', margin: '7px 0 10px', whiteSpace: 'pre-wrap' }}>Their original message is quoted under your reply automatically.</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={send} disabled={busy || !gmail?.connected} style={primaryBtn}>{busy ? 'Sending…' : 'Send email'}</button>
      </div>
    </div>
  )
}
