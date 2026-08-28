import { useEffect, useRef, useState } from 'react'
import { MONO } from '../data.js'
import { loadAutomations, setAutomationStatus, deleteAutomation, runAutomationsNow, saveAutomationConfig, testNewRequestAlerts } from '../lib/automationsData.js'

const fmt = (ts) => { try { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return ts } }

const STATUS_STYLE = {
  enabled: { label: 'ACTIVE', color: '#1f7a4d', bg: '#e7f1eb' },
  suggested: { label: 'SUGGESTED', color: '#b07d18', bg: '#faf3e2' },
  paused: { label: 'PAUSED', color: '#8a8f8a', bg: '#eef0ee' },
}

// shared styles for the reminder editor (match the Invoices page inputs)
const inp = { width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '9px 11px', fontSize: 15, outline: 'none', boxSizing: 'border-box' }
const empty = { padding: '22px 14px', textAlign: 'center', color: '#9aa69e', fontSize: 12.5 }
const errorBox = { marginBottom: 14, background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5 }
const ghostBtn = { background: '#fff', color: '#5d6b63', border: '1px solid #e6eae6', borderRadius: 9, padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const primaryBtn = { flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const cancelBtn = { flex: 'none', background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto' }
const modal = { maxWidth: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }

export default function Automations({ app }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [runMsg, setRunMsg] = useState('')
  const [cfgOpen, setCfgOpen] = useState(false)
  const [alertCfgOpen, setAlertCfgOpen] = useState(false)

  async function refresh() {
    setLoading(true)
    try { setItems(await loadAutomations()) }
    catch (e) { setErr(e.message || String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])

  async function setStatus(a, status) {
    setBusyId(a.id); setErr('')
    try { await setAutomationStatus(a.id, status, a.name); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    finally { setBusyId(null) }
  }

  async function remove(a) {
    if (!window.confirm(`Delete "${a.name}"?`)) return
    setBusyId(a.id); setErr('')
    try { await deleteAutomation(a.id, a.name); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    finally { setBusyId(null) }
  }

  async function runNow(a) {
    setBusyId(a.id); setErr(''); setRunMsg('')
    try {
      const r = await runAutomationsNow(a.kind)
      const res = r?.ran?.find((x) => x.kind === a.kind)
      setRunMsg(res ? `${a.name}: ${res.result}` : r?.note || 'Ran.')
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    finally { setBusyId(null) }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ fontSize: 13, color: '#5d6b63', marginBottom: 14 }}>
        Scheduled jobs Trashy Randy runs for you, plus automations he's suggested from your requests. Approve a suggestion to put it on the schedule — nothing suggested runs until a staff member enables it.
      </div>

      {err && <div style={{ background: '#fbeae6', color: '#c0492f', border: '1px solid #c0492f33', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {runMsg && <div style={{ background: '#e7f1eb', color: '#1f7a4d', border: '1px solid #1f7a4d33', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{runMsg}</div>}

      {loading ? (
        <div style={{ padding: 28, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading…</div>
      ) : !items.length ? (
        <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '40px 24px', textAlign: 'center', color: '#7c8a82', fontSize: 13 }}>
          No automations yet. Ask Trashy Randy to automate something recurring and it'll show up here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((a) => {
            const st = STATUS_STYLE[a.status] || STATUS_STYLE.paused
            return (
              <div key={a.id} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '13px 15px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', color: st.color, background: st.bg, padding: '2px 7px', borderRadius: 5 }}>{st.label}</span>
                  <span style={{ fontSize: 14.5, fontWeight: 700, color: '#1a2420' }}>{a.name}</span>
                  <span style={{ flex: 1 }} />
                  {a.requested_by && <span style={{ fontSize: 11.5, color: '#9aa69e' }}>requested by {a.requested_by}</span>}
                </div>
                {a.description && <div style={{ fontSize: 13, color: '#5d6b63', whiteSpace: 'pre-wrap', marginBottom: 8 }}>{a.description}</div>}
                {(a.last_run_at || a.last_result) && (
                  <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 4 }}>
                    {a.last_run_at ? `Last run ${fmt(a.last_run_at)}` : 'Never run'}{a.last_result ? ` — ${a.last_result}` : ''}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {a.kind === 'new_request_alerts' && (
                    <button onClick={() => setAlertCfgOpen(true)} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #1f7a4d55', color: '#1f7a4d', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>⚙️ Edit alerts</button>
                  )}
                  {a.kind === 'auto_invoice_reminders' && (
                    <button onClick={() => setCfgOpen(true)} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #1f7a4d55', color: '#1f7a4d', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>⚙️ Edit reminders</button>
                  )}
                  {a.status === 'enabled' && (
                    <button onClick={() => runNow(a)} disabled={busyId === a.id} style={{ background: '#1f7a4d', border: '1px solid #1f7a4d', color: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Run now</button>
                  )}
                  {a.status !== 'enabled' && (
                    <button onClick={() => setStatus(a, 'enabled')} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #1f7a4d55', color: '#1f7a4d', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>{a.status === 'suggested' ? 'Approve & enable' : 'Resume'}</button>
                  )}
                  {a.status === 'enabled' && (
                    <button onClick={() => setStatus(a, 'paused')} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #b07d1855', color: '#b07d18', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Pause</button>
                  )}
                  <button onClick={() => remove(a)} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #c0492f55', color: '#c0492f', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {cfgOpen && (
        <ReminderScheduleModal onClose={() => setCfgOpen(false)} onSaved={refresh} />
      )}
      {alertCfgOpen && (
        <RequestAlertsModal onClose={() => setAlertCfgOpen(false)} onSaved={refresh} />
      )}
    </div>
  )
}

// ---- Reminder schedule editor ---------------------------------------------------
// Edits the auto_invoice_reminders automation: up to 5 reminders, each with a
// trigger (days after sent / before due / after due), channel picks (SMS /
// Email / Push) and a message template with merge fields. Saved to the
// automations row's config; the runner checks daily ~7:30 AM ET and sends at
// most one reminder per invoice per day (the most escalated stage that's due).
const REMINDER_FIELDS = ['customer name', 'invoice number', 'amount', 'due date', 'issue date', 'service date', 'invoice link', 'company name']
const TRIGGER_TYPES = [
  ['after_sent', 'days after the invoice is sent'],
  ['before_due', 'days before the due date'],
  ['after_due', 'days after the due date'],
]
const defaultReminders = () => [
  { key: 'r1', label: 'Heads-up before due', type: 'before_due', days: 2, sms: true, email: true, push: false, template: 'Hi [customer name], a friendly reminder that invoice [invoice number] for [amount] is due on [due date]. You can pay securely here anytime: [invoice link]. Thank you! — [company name]' },
  { key: 'r2', label: 'After due date', type: 'after_due', days: 3, sms: true, email: true, push: false, template: 'Hi [customer name], invoice [invoice number] for [amount] was due on [due date] (service on [service date]). You can pay securely in about a minute here: [invoice link]. Thanks! — [company name]' },
]
const blankReminder = (i) => ({ key: 'r' + (i + 1), label: '', type: 'after_due', days: 3, sms: false, email: true, push: false, template: '' })

function ReminderScheduleModal({ onClose, onSaved }) {
  const [rows, setRows] = useState(null) // null = loading
  const [enabled, setEnabled] = useState(false)
  const [autoRow, setAutoRow] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const areaRefs = useRef({})

  useEffect(() => {
    loadAutomations().then((all) => {
      const row = all.find((a) => a.kind === 'auto_invoice_reminders')
      if (row) {
        setAutoRow(row)
        setEnabled(row.status === 'enabled')
        const cfgRows = (row.config?.reminders || []).filter((r) => r && r.template)
        setRows(cfgRows.length ? cfgRows.map((r, i) => ({ ...r, key: r.key || 'r' + (i + 1) })) : defaultReminders())
      } else {
        setRows(defaultReminders())
      }
    }).catch((e) => { setErr(e.message || String(e)); setRows(defaultReminders()) })
  }, [])

  const setRow = (i, patch) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows((rs) => (rs.length >= 5 ? rs : [...rs, blankReminder(rs.length)]))
  const removeRow = (i) => setRows((rs) => (rs.length > 1 ? rs.filter((_, k) => k !== i) : rs))

  function insertField(i, field) {
    const token = `[${field}]`
    const area = areaRefs.current[i]
    const cur = rows[i].template || ''
    if (!area) { setRow(i, { template: (cur + ' ' + token).trim() }); return }
    const s = area.selectionStart ?? cur.length
    const e = area.selectionEnd ?? cur.length
    setRow(i, { template: cur.slice(0, s) + token + cur.slice(e) })
    requestAnimationFrame(() => { try { area.focus(); area.setSelectionRange(s + token.length, s + token.length) } catch (_e) { /* best effort */ } })
  }

  async function save() {
    if (!autoRow) { setErr('Automation row not found in the database.'); return }
    const clean = rows.filter((r) => String(r.template || '').trim() && r.days !== '' && r.days != null)
      .map((r) => ({ ...r, days: Number(r.days) }))
    if (!clean.length) { setErr('Give at least one reminder a message.'); return }
    setSaving(true); setErr(''); setMsg('')
    try {
      await saveAutomationConfig(autoRow.id, { reminders: clean }, enabled ? 'enabled' : 'paused', 'Auto-remind overdue invoices')
      setMsg(`Saved ✓ — reminders are ${enabled ? 'ON and will send daily ~7:30 AM ET' : 'paused'}.`)
      onSaved && onSaved()
    } catch (e) { setErr(e.message || String(e)) }
    setSaving(false)
  }

  async function runNow() {
    if (!window.confirm('Run the reminder check now? This sends any reminders that are already due — real messages to real customers.')) return
    setErr(''); setMsg('Running…')
    try {
      const d = await runAutomationsNow('auto_invoice_reminders')
      setMsg(`Run: ${d?.ran?.[0]?.result || 'no result'}`)
      onSaved && onSaved()
    } catch (e) { setErr(e.message || String(e)) }
  }

  const chip = (active) => ({
    border: '1px solid #dde2dd', background: active ? '#e7f1eb' : '#fff', color: active ? '#1f7a4d' : '#5d6b63',
    borderRadius: 7, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
  })

  return (
    <div onClick={() => !saving && onClose()} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 640, maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>⏰ Automatic invoice reminders</div>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => setEnabled((v) => !v)}
            style={{ background: enabled ? '#1f7a4d' : '#eef1ee', color: enabled ? '#fff' : '#5d6b63', border: 'none', borderRadius: 20, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
          >{enabled ? 'ON' : 'OFF'}</button>
        </div>
        <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 14, lineHeight: 1.5 }}>
          Up to 5 reminders for every open invoice. Checked daily ~7:30 AM ET — a customer gets at most one reminder message per day (the furthest stage they've reached). Each reminder fires once per invoice.
        </div>

        {err && <div style={errorBox}>{err}</div>}
        {msg && <div style={{ marginBottom: 12, background: '#eef7f1', border: '1px solid #cfe7da', color: '#1f7a4d', borderRadius: 11, padding: '9px 13px', fontSize: 12.5 }}>{msg}</div>}

        {rows === null ? <div style={empty}>Loading…</div> : rows.map((r, i) => (
          <div key={i} style={{ border: '1px solid #e6eae6', borderRadius: 12, padding: 13, marginBottom: 11 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
              <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: '#1f7a4d', background: '#e7f1eb', borderRadius: 6, padding: '2px 7px' }}>#{i + 1}</span>
              <input value={r.label || ''} onChange={(e) => setRow(i, { label: e.target.value })} placeholder="Label (e.g. First nudge) — just for you" style={{ ...inp, flex: 1, fontSize: 12.5, padding: '6px 10px' }} />
              {rows.length > 1 && (
                <button onClick={() => removeRow(i)} title="Remove this reminder" style={{ background: 'none', border: 'none', color: '#c0492f', fontSize: 15, cursor: 'pointer', padding: '2px 6px' }}>✕</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 9 }}>
              <select value={r.type} onChange={(e) => setRow(i, { type: e.target.value })} style={{ ...inp, width: 'auto', fontSize: 12.5, padding: '7px 9px' }}>
                {TRIGGER_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <input type="number" min="0" max="365" value={r.days} onChange={(e) => setRow(i, { days: e.target.value })} style={{ ...inp, width: 74, fontSize: 12.5, padding: '7px 9px' }} />
              <span style={{ fontSize: 11.5, color: '#9aa69e' }}>days</span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 9, flexWrap: 'wrap' }}>
              <button onClick={() => setRow(i, { sms: !r.sms })} style={chip(r.sms)}>📱 SMS</button>
              <button onClick={() => setRow(i, { email: !r.email })} style={chip(r.email)}>✉️ Email</button>
              <button onClick={() => setRow(i, { push: !r.push })} style={chip(r.push)}>🔔 Push (app)</button>
              <span style={{ fontSize: 10.5, color: '#9aa69e', alignSelf: 'center' }}>SMS falls back to email while texting is paused</span>
            </div>
            <textarea
              ref={(el) => { areaRefs.current[i] = el }}
              value={r.template || ''}
              onChange={(e) => setRow(i, { template: e.target.value })}
              rows={4}
              placeholder={`Hello [customer name], this is a reminder about invoice [invoice number]…`}
              style={{ ...inp, fontSize: 12.5, lineHeight: 1.55, resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 7 }}>
              {REMINDER_FIELDS.map((f) => (
                <button key={f} onClick={() => insertField(i, f)} title={`Insert [${f}]`} style={{ background: '#f3f5f2', border: '1px solid #e3e7e3', borderRadius: 6, padding: '2px 7px', fontSize: 10.5, color: '#5d6b63', cursor: 'pointer' }}>[{f}]</button>
              ))}
            </div>
          </div>
        ))}

        {rows !== null && rows.length < 5 && (
          <button onClick={addRow} disabled={saving} style={{ ...ghostBtn, width: '100%', borderStyle: 'dashed', marginBottom: 14 }}>+ Add reminder ({rows.length}/5)</button>
        )}

        <div style={{ fontSize: 11, color: '#9aa69e', marginBottom: 14, lineHeight: 1.55 }}>
          Push notifications need the customer to have signed into the app — no clients have app push yet, so Push is dormant until then (selecting it is harmless).
        </div>

        <div style={{ display: 'flex', gap: 9 }}>
          <button onClick={onClose} disabled={saving} style={cancelBtn}>Close</button>
          <button onClick={runNow} disabled={saving || !autoRow} style={ghostBtn}>Run check now</button>
          <button onClick={save} disabled={saving || !autoRow} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

// ---- New-request alert editor ---------------------------------------------------
// Edits the new_request_alerts automation: who gets emailed and which channels
// fire. The portal fn alerts instantly when a client submits a request; this
// row's ON/OFF status is the kill switch for BOTH that instant path and the
// every-5-minute retry poll. "Send test" delivers a real labeled test email +
// push so David can confirm his phone is wired up.
const DEFAULT_ALERT_EMAILS = ['david@allsynccrm.com', 'valetwastefl@gmail.com']

function RequestAlertsModal({ onClose, onSaved }) {
  const [emails, setEmails] = useState(null) // null = loading
  const [useEmail, setUseEmail] = useState(true)
  const [usePush, setUsePush] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [autoRow, setAutoRow] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    loadAutomations().then((all) => {
      const row = all.find((a) => a.kind === 'new_request_alerts')
      if (!row) { setErr('Automation row not found in the database.'); setEmails([]); return }
      setAutoRow(row)
      setEnabled(row.status === 'enabled')
      const c = row.config || {}
      const list = Array.isArray(c.emails) && c.emails.length ? c.emails : DEFAULT_ALERT_EMAILS
      setEmails(list.map(String))
      setUseEmail(c.email !== false)
      setUsePush(c.push !== false)
    }).catch((e) => { setErr(e.message || String(e)); setEmails([]) })
  }, [])

  const setEmail = (i, v) => setEmails((es) => es.map((x, k) => (k === i ? v : x)))
  const addEmail = () => setEmails((es) => (es.length >= 6 ? es : [...es, '']))
  const removeEmail = (i) => setEmails((es) => (es.length > 1 ? es.filter((_, k) => k !== i) : es))

  const cleanEmails = () => (emails || []).map((e) => e.trim()).filter(Boolean)

  async function save() {
    const clean = cleanEmails()
    if (!clean.length) { setErr('Keep at least one email address.'); return }
    if (!useEmail && !usePush) { setErr('Pick at least one channel (Email or Push).'); return }
    setSaving(true); setErr(''); setMsg('')
    try {
      await saveAutomationConfig(autoRow.id, { emails: clean, email: useEmail, push: usePush }, enabled ? 'enabled' : 'paused', 'New request alerts')
      setMsg(`Saved ✓ — alerts are ${enabled ? 'ON' : 'paused'}.`)
      onSaved && onSaved()
    } catch (e) { setErr(e.message || String(e)) }
    setSaving(false)
  }

  async function sendTest() {
    if (!cleanEmails().length) { setErr('Add at least one email address before testing.'); return }
    setTesting(true); setErr(''); setMsg('Sending test…')
    try {
      if (autoRow) { // save what's on screen first so the test uses it
        await saveAutomationConfig(autoRow.id, { emails: cleanEmails(), email: useEmail, push: usePush }, enabled ? 'enabled' : 'paused', 'New request alerts')
        onSaved && onSaved()
      }
      const d = await testNewRequestAlerts()
      setMsg(`Test: ${d?.result || 'sent'}`)
    } catch (e) { setErr(e.message || String(e)) }
    setTesting(false)
  }

  const chipBtn = (active) => ({
    border: '1px solid #dde2dd', background: active ? '#e7f1eb' : '#fff', color: active ? '#1f7a4d' : '#5d6b63',
    borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  })

  return (
    <div onClick={() => !saving && !testing && onClose()} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 520, maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>📥 New request alerts</div>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => setEnabled((v) => !v)}
            style={{ background: enabled ? '#1f7a4d' : '#eef1ee', color: enabled ? '#fff' : '#5d6b63', border: 'none', borderRadius: 20, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
          >{enabled ? 'ON' : 'OFF'}</button>
        </div>
        <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 14, lineHeight: 1.5 }}>
          The moment a client submits a request in their portal, staff get an email and an app push. Texting is paused, so these are the channels that carry it. A safety poll re-sends anything that failed, every 5 minutes.
        </div>

        {err && <div style={errorBox}>{err}</div>}
        {msg && <div style={{ marginBottom: 12, background: '#eef7f1', border: '1px solid #cfe7da', color: '#1f7a4d', borderRadius: 11, padding: '9px 13px', fontSize: 12.5 }}>{msg}</div>}

        <div style={{ fontSize: 12, fontWeight: 700, color: '#5d6b63', marginBottom: 7 }}>Alert these emails</div>
        {emails === null ? <div style={empty}>Loading…</div> : emails.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 7, marginBottom: 7, alignItems: 'center' }}>
            <input value={e} onChange={(ev) => setEmail(i, ev.target.value)} placeholder="name@email.com" style={{ ...inp, flex: 1 }} />
            {emails.length > 1 && (
              <button onClick={() => removeEmail(i)} title="Remove" style={{ background: 'none', border: 'none', color: '#c0492f', fontSize: 15, cursor: 'pointer', padding: '2px 6px' }}>✕</button>
            )}
          </div>
        ))}
        {emails !== null && emails.length < 6 && (
          <button onClick={addEmail} disabled={saving} style={{ ...ghostBtn, borderStyle: 'dashed', marginBottom: 14 }}>+ Add email ({emails.length}/6)</button>
        )}

        <div style={{ fontSize: 12, fontWeight: 700, color: '#5d6b63', marginBottom: 7 }}>Channels</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setUseEmail((v) => !v)} style={chipBtn(useEmail)}>✉️ Email</button>
          <button onClick={() => setUsePush((v) => !v)} style={chipBtn(usePush)}>🔔 Push (app)</button>
        </div>
        <div style={{ fontSize: 11, color: '#9aa69e', marginBottom: 14, lineHeight: 1.55 }}>
          Push goes to phones signed into the staff app — make sure the app is signed in and notifications are allowed for it. Emails come from Trashy Randy via SendGrid.
        </div>

        <div style={{ display: 'flex', gap: 9 }}>
          <button onClick={onClose} disabled={saving || testing} style={cancelBtn}>Close</button>
          <button onClick={sendTest} disabled={saving || testing || !autoRow} style={ghostBtn}>{testing ? 'Testing…' : 'Send test now'}</button>
          <button onClick={save} disabled={saving || testing || !autoRow} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
