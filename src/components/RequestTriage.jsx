import { useEffect, useState } from 'react'
import { MONO } from '../data.js'
import { STATUS_META, setRequestStatus, replyToRequestEmail } from '../lib/requestsData.js'
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
              <div style={{ fontSize: 13, color: '#1a2420', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>{r.message || '(no message — just the request)'}</div>
              {r.repliedAt && (
                <div style={{ fontSize: 11.5, color: '#1f7a4d', marginTop: 6 }}>✉️ Replied by email{r.repliedBy ? ` (${r.repliedBy})` : ''} — {fmtWhen(r.repliedAt)}</div>
              )}

              <div style={{ display: 'flex', gap: 7, marginTop: 11, flexWrap: 'wrap' }}>
                <button onClick={() => mark(r, 'scheduled')} disabled={busyId === r.id || scheduled} style={{ ...ghostBtn, color: scheduled ? '#9aa69e' : '#155e9c', borderColor: scheduled ? '#e6eae6' : '#155e9c55' }}>{scheduled ? '📅 Scheduled ✓' : '📅 Scheduled'}</button>
                <button onClick={() => mark(r, 'done')} disabled={busyId === r.id} style={primaryBtn}>{busyId === r.id ? 'Saving…' : '✓ Handled — close'}</button>
                <button onClick={() => setReplyFor((id) => (id === r.id ? null : r.id))} disabled={busyId === r.id} style={ghostBtn}>✉️ Reply by email</button>
                <span style={{ flex: 1 }} />
                <button onClick={() => { onClose(); app.openClient(r.customerId) }} style={{ ...ghostBtn, color: '#1f7a4d', borderColor: '#1f7a4d55' }}>Client →</button>
              </div>

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
