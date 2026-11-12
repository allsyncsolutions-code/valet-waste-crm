/* =====================================================================
 * Valet Waste — Workflow studio (ported from AllSync Automations.jsx,
 * 2026-11-11; workflow-builder half only — the AllSync standard catalog,
 * real-estate catalog, canvassing and Property Meld panels were dropped,
 * and the trigger/action menus were re-cut for Valet Waste).
 *
 * Storage: automation_rules / automation_sends / automation_folders
 * (migration 0073); writes go through save_automation_rule /
 * set_automation_enabled / set_automation_rule_folder (admin-gated RPCs).
 * Single-tenant: the AllSync workspace_id is a fixed sentinel here.
 * ===================================================================== */
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'

const SENTINEL_WS = '00000000-0000-0000-0000-000000000001'

/* ---------- icons (AllSync Ic subset used by this screen) ---------- */
const Ic = {
  schedule: <><rect x="3" y="4" width="18" height="18" rx="2.5"/><path d="M16 2v4M8 2v4M3 10h18"/></>,
  estimates: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></>,
  chev: <><path d="m6 9 6 6 6-6"/></>,
  money: <><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5a2.5 2 0 0 1 2.5-1.5c1.4 0 2.5.7 2.5 1.6 0 2.3-5 1.4-5 3.8 0 1 1.1 1.6 2.5 1.6a2.5 2 0 0 0 2.5-1.5"/></>,
  check: <><path d="M20 6 9 17l-5-5"/></>,
  warn: <><path d="M10.3 3.8 1.8 18.5a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></>,
  phone: <><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></>,
  x: <><path d="M18 6 6 18M6 6l12 12"/></>,
  mail: <><rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="m2 7 10 6 10-6"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  layers: <><path d="M12 2 2 7l10 5 10-5z"/><path d="m2 12 10 5 10-5M2 17l10 5 10-5"/></>,
  chevL: <><path d="m15 18-6-6 6-6"/></>,
  users2: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
  bolt: <><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></>,
  automations: <><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M8 6h4a4 4 0 0 1 4 4M8 18h4a4 4 0 0 0 4-4"/></>,
  edit: <><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></>,
}
function Svg({ d, fill, ...rest }) {
  return <svg viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...rest}>{d}</svg>
}

/* ---------- merge fields (tokens the VW executor resolves — KEEP IN SYNC
 * with fillTemplate in the automations-run worker) ---------- */
const F_VW = [
  ['Customer First Name', 'customer_first_name'], ['Customer Full Name', 'customer_full_name'],
  ['Customer Phone', 'customer_phone'],
  ['Invoice Number', 'invoice_number'], ['Invoice Amount', 'invoice_amount'],
  ['Payment Link', 'payment_link'], ['Receipt Link', 'receipt_link'],
  ['Decline Reason', 'decline_reason'],
  ['Estimate Number', 'estimate_number'], ['Estimate Amount', 'estimate_amount'],
  ['Estimate Link', 'estimate_link'],
  ['Company Name', 'company_name'], ['Company Phone', 'company_phone'],
]
const SAMPLE = {
  customer_first_name: 'John', customer_full_name: 'John Smith', customer_phone: '(904) 555-0177',
  invoice_number: 'INV-1042', invoice_amount: '$150.00', payment_link: '[Pay Now]', receipt_link: '[View Receipt]',
  decline_reason: 'ZIP mismatch (code 104)',
  estimate_number: 'EST-001', estimate_amount: '$350.00', estimate_link: '[View Estimate]',
}
const renderAutomationPreview = (template, workspace) => {
  const map = {
    ...SAMPLE,
    company_name: workspace?.name || 'Valet Waste FL',
    company_phone: workspace?.business_phone || '(904) 555-1234',
  }
  return String(template || '').replace(/\[([a-z0-9_]+)\]/g, (m, k) => (map[k] != null ? map[k] : m))
}

/* ---------- small pieces ---------- */
function Toggle({ on, onChange, disabled }) {
  return (
    <button type="button" className={'auto-toggle' + (on ? ' on' : '')} disabled={disabled}
      onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="auto-knob" />
    </button>
  )
}
function ChecklineGroup({ label, icon, options, value, onChange, disabled }) {
  return (
    <div className="auto-channels">
      <span className="auto-channels-label">{icon && <Svg d={icon} />}{label}</span>
      <div className="auto-checks">
        {options.map(([k, lab, ic]) => {
          const on = !!value[k]
          return (
            <button key={k} type="button" className={'auto-check' + (on ? ' on' : '')} disabled={disabled}
              onClick={() => onChange({ ...value, [k]: !on })}>
              <span className={'auto-checkbox' + (on ? ' on' : '')}>{on && <Svg d={Ic.check} />}</span>
              {ic && <Svg d={ic} />}{lab}
            </button>
          )
        })}
      </div>
    </div>
  )
}
/* Message editor: template textarea + insert-merge-field chips + live preview. */
function MessageEditor({ label, value, onChange, fields, workspace, disabled }) {
  const [showFields, setShowFields] = useState(false)
  const taRef = useRef(null)
  const insert = (token) => {
    const tag = `[${token}]`
    const ta = taRef.current
    if (ta && typeof ta.selectionStart === 'number') {
      const s = ta.selectionStart, e = ta.selectionEnd
      onChange(value.slice(0, s) + tag + value.slice(e))
      requestAnimationFrame(() => { try { ta.focus(); ta.setSelectionRange(s + tag.length, s + tag.length) } catch { /* noop */ } })
    } else {
      onChange((value || '') + (value && !value.endsWith(' ') ? ' ' : '') + tag)
    }
  }
  return (
    <div className="auto-msg">
      <span className="auto-msg-label">{label}</span>
      <textarea ref={taRef} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="auto-fields-head" onClick={() => setShowFields((o) => !o)}>
        <Svg d={Ic.plus} /> Insert Merge Field
        <span className={'auto-fields-chev' + (showFields ? ' open' : '')}><Svg d={Ic.chev} /></span>
      </button>
      {showFields && (
        <div className="auto-fields">
          <p className="auto-fields-hint">Click a field to insert it into your message:</p>
          <div className="auto-fields-chips">
            {fields.map(([lab, token]) => (
              <button key={token} type="button" className="auto-field-chip" disabled={disabled} onClick={() => insert(token)}>[{lab}]</button>
            ))}
          </div>
        </div>
      )}
      <div className="auto-preview">
        <span className="auto-preview-label"><b>Preview:</b> Merge fields will be replaced with actual customer data when sent.</span>
        <div className="auto-preview-body">
          {renderAutomationPreview(value, workspace).split('\n').map((l, i) => <p key={i}>{l || ' '}</p>)}
        </div>
      </div>
    </div>
  )
}

/* ---------- one-line labels (list rows + composer preview) ---------- */
const ruleTriggerLabel = (t) => {
  if (!t) return '—'
  if (t.type === 'invoice_unpaid_for') return `Invoice unpaid ${t.days} days`
  if (t.type === 'invoice_declined') return 'A card payment is declined'
  if (t.type === 'chargeback_detected') return 'A chargeback is detected'
  if (t.type === 'payment_received') return 'A payment is received'
  if (t.type === 'estimate_sent') return 'An estimate is sent'
  if (t.type === 'estimate_accepted') return 'An estimate is accepted'
  if (t.type === 'estimate_unanswered_for') return `Estimate unanswered ${t.days} days`
  return t.type
}
const ruleResultLabel = (r) => {
  if (!r) return '—'
  if (r.type === 'notify_members') {
    const who = r.audience === 'managers' ? 'owners & admins' : r.audience === 'selected' ? `${(r.member_ids || []).length || 'some'} selected` : 'everyone'
    const ch = []
    if (r.channels?.sms) ch.push('text')
    if (r.channels?.email) ch.push('email')
    return `Notify ${who}${ch.length ? ` via ${ch.join(' + ')}` : ''}`
  }
  if (r.type === 'notify_team') return 'Notify the team (admins)'
  if (r.type === 'text_customer') return 'Text customer'
  if (r.type === 'email_customer') return 'Email customer'
  return r.type
}

/* ---------- the FIXED menus (mirror migration 0074's RPC — KEEP IN SYNC) ---------- */
const WORKFLOW_TRIGGERS = [
  ['invoice_unpaid_for', 'An invoice goes unpaid'],
  ['invoice_declined', 'A card payment is declined'],
  ['chargeback_detected', 'A chargeback hits our account'],
  ['payment_received', 'A payment is received'],
  ['estimate_sent', 'An estimate is sent'],
  ['estimate_accepted', 'An estimate is accepted'],
  ['estimate_unanswered_for', 'An estimate goes unanswered'],
]
const ACTION_MENU = [
  ['notify_team', 'Notify the team (admins)'],
  ['notify_members', 'Notify people…'],
  ['text_customer', 'Text the customer'],
  ['email_customer', 'Email the customer'],
]
const AUDIENCES = [
  ['everyone', 'Everyone'],
  ['managers', 'Owners & admins'],
  ['selected', 'Selected people'],
]
const TRIGGER_ICON = {
  invoice_unpaid_for: Ic.money, invoice_declined: Ic.warn, chargeback_detected: Ic.warn,
  payment_received: Ic.money, estimate_sent: Ic.mail,
  estimate_accepted: Ic.check, estimate_unanswered_for: Ic.estimates,
}
const ACTION_ICON = {
  notify_team: Ic.users2, notify_members: Ic.users2,
  text_customer: Ic.phone, email_customer: Ic.mail,
}
const NOTIFY_CHANNELS = [['sms', 'Text', Ic.phone], ['email', 'Email', Ic.mail]]

/* Workflow templates — the Create-workflow menu's "Start from a template"
 * section. Each seeds the builder exactly like a hand-built draft. */
const WORKFLOW_TEMPLATES = [
  {
    key: 'declined_alert', title: 'Declined Card Alert',
    blurb: 'Texts and emails the admins the moment a saved card declines, with the reason — so someone can follow up the same day.',
    draft: {
      name: 'Declined Card Alert',
      trigger: { type: 'invoice_declined' },
      actions: [{ type: 'notify_team', channels: { sms: true, email: true },
        message_template: 'Card declined on invoice #[invoice_number] ([invoice_amount]) for [customer_full_name] — [decline_reason]. Follow up: [payment_link]' }],
    },
  },
  {
    key: 'chargeback_alert', title: 'Chargeback Alert',
    blurb: 'Alerts the admins the moment Run reports a chargeback, with the customer and amount.',
    draft: {
      name: 'Chargeback Alert',
      trigger: { type: 'chargeback_detected' },
      actions: [{ type: 'notify_team', channels: { sms: true, email: true },
        message_template: 'CHARGEBACK: [invoice_amount] from [customer_full_name] (invoice #[invoice_number]). Review in Run and the Payments tab.' }],
    },
  },
  {
    key: 'inv_reminder', title: 'Invoice Payment Reminder',
    blurb: 'Texts the customer when an invoice is 7 days overdue, with the pay-online link.',
    draft: {
      name: 'Invoice Payment Reminder',
      trigger: { type: 'invoice_unpaid_for', days: 7 },
      actions: [{ type: 'text_customer',
        message_template: 'Hi [customer_first_name], this is a friendly reminder that your invoice #[invoice_number] for [invoice_amount] is due. Please click here to pay: [payment_link]\n\nThank you!\n[company_name]' }],
    },
  },
  {
    key: 'payment_thanks', title: 'Payment Received Thank-You',
    blurb: 'Texts the customer a thank-you with the receipt link the moment a payment lands.',
    draft: {
      name: 'Payment Thank-You',
      trigger: { type: 'payment_received' },
      actions: [{ type: 'text_customer',
        message_template: 'Hi [customer_first_name], we\'ve received your payment of [invoice_amount] for invoice #[invoice_number]. Thank you! Your receipt is here: [receipt_link]\n\nWe appreciate your business!\n[company_name]' }],
    },
  },
  {
    key: 'est_followup', title: 'Estimate Follow-Up',
    blurb: 'Texts the customer 3 days after an estimate goes unanswered, with the view link.',
    draft: {
      name: 'Estimate Follow-Up',
      trigger: { type: 'estimate_unanswered_for', days: 3 },
      actions: [{ type: 'text_customer',
        message_template: 'Hi [customer_first_name], your estimate [estimate_number] for [estimate_amount] is still open. View and approve it here: [estimate_link]\n\nThank you!\n[company_name]' }],
    },
  },
  {
    key: 'est_sent_notice', title: 'Estimate Sent Notification',
    blurb: 'Texts the customer the moment an estimate is sent, with a link to view it online.',
    draft: {
      name: 'Estimate Sent Notification',
      trigger: { type: 'estimate_sent' },
      actions: [{ type: 'text_customer',
        message_template: 'Hi [customer_first_name], your estimate [estimate_number] for [estimate_amount] is ready. View and approve it online here: [estimate_link]\n\nThank you!\n[company_name]' }],
    },
  },
]

const triggerLine = (t) => ruleTriggerLabel(t)
const actionLine = (a) => ruleResultLabel(a)

/* The node editor — controlled: value is the trigger/action object. */
function WorkflowNodeEditor({ kind, value, onChange, crewActive, workspace, disabled }) {
  const set = (patch) => onChange({ ...value, ...patch })
  const type = value?.type || ''

  return (
    <div className="wf-editor">
      <label className="auto-select" style={{ maxWidth: '100%' }}>
        <span>{kind === 'trigger' ? 'When this happens…' : 'Then do this…'}</span>
        <select value={type} disabled={disabled} onChange={(e) => onChange({ type: e.target.value })}>
          {(kind === 'trigger' ? WORKFLOW_TRIGGERS : ACTION_MENU).map(([k, lab]) => (
            <option key={k} value={k}>{lab}</option>
          ))}
        </select>
      </label>

      {kind === 'trigger' && type === 'invoice_unpaid_for' && (
        <label className="auto-select">
          <span>Days unpaid</span>
          <input type="number" min="1" style={{ width: 110 }} disabled={disabled}
            value={value.days ?? 7} onChange={(e) => set({ days: Number(e.target.value) || 1 })} />
        </label>
      )}

      {kind === 'trigger' && type === 'estimate_unanswered_for' && (
        <label className="auto-select">
          <span>Days without a response</span>
          <input type="number" min="1" style={{ width: 110 }} disabled={disabled}
            value={value.days ?? 3} onChange={(e) => set({ days: Number(e.target.value) || 1 })} />
        </label>
      )}

      {/* ---------- action params ---------- */}
      {kind === 'action' && ['notify_team', 'notify_members'].includes(type) && (
        <>
          {type === 'notify_members' && (
            <div className="auto-channels">
              <span className="auto-channels-label">Who</span>
              <div className="auto-checks">
                {AUDIENCES.map(([k, lab]) => (
                  <button key={k} type="button" className={'auto-check' + (value.audience === k ? ' on' : '')} disabled={disabled}
                    onClick={() => set({ audience: k })}>{lab}</button>
                ))}
              </div>
            </div>
          )}
          {type === 'notify_members' && value.audience === 'selected' && (
            <div className="auto-channels">
              <span className="auto-channels-label">People</span>
              <div className="auto-checks">
                {crewActive.map((m) => {
                  const on = (value.member_ids || []).map(String).includes(String(m.id))
                  return (
                    <button key={m.id} type="button" className={'auto-check' + (on ? ' on' : '')} disabled={disabled}
                      onClick={() => set({ member_ids: on ? (value.member_ids || []).filter((x) => String(x) !== String(m.id)) : [...(value.member_ids || []), m.id] })}>
                      <span className={'auto-checkbox' + (on ? ' on' : '')}>{on && <Svg d={Ic.check} />}</span>
                      {m.name || 'Teammate'}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <ChecklineGroup label="How" options={NOTIFY_CHANNELS}
            value={{ sms: !!value.channels?.sms, email: !!value.channels?.email }}
            onChange={(v) => set({ channels: { sms: v.sms, email: v.email } })} disabled={disabled} />
          <MessageEditor label="Message (optional — a plain default is sent if left blank)" value={value.message_template || ''}
            onChange={(v) => set({ message_template: v })} fields={F_VW} workspace={workspace} disabled={disabled} />
        </>
      )}

      {kind === 'action' && type === 'text_customer' && (
        <MessageEditor label="Text message" value={value.message_template || ''}
          onChange={(v) => set({ message_template: v })} fields={F_VW} workspace={workspace} disabled={disabled} />
      )}

      {kind === 'action' && type === 'email_customer' && (
        <>
          <label className="auto-select" style={{ maxWidth: '100%' }}>
            <span>Subject</span>
            <input type="text" disabled={disabled} value={value.subject || ''}
              onChange={(e) => set({ subject: e.target.value })} />
          </label>
          <MessageEditor label="Email body" value={value.body_template || ''}
            onChange={(v) => set({ body_template: v })} fields={F_VW} workspace={workspace} disabled={disabled} />
        </>
      )}
    </div>
  )
}

/* The builder — canvas on the right, node editor on the left. */
function WorkflowBuilder({ workspace, rule, draft, onClose, onSaved }) {
  const [name, setName] = useState(rule?.name || draft?.name || 'New workflow')
  const [trigger, setTrigger] = useState(rule?.trigger || draft?.trigger || { type: 'invoice_unpaid_for', days: 7 })
  const [actions, setActions] = useState(() => {
    if (rule) return [rule.result, ...(rule.actions || [])]
    if (draft?.actions?.length) return draft.actions
    return [{ type: 'notify_team', channels: { sms: true } }]
  })
  const [enabled, setEnabled] = useState(rule ? rule.enabled !== false : false)
  const [sel, setSel] = useState(null)   // {kind:'trigger'} | {kind:'action', idx}
  const [addAt, setAddAt] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const canvasRef = useRef(null)

  const touch = () => setDirty(true)

  const insertAction = (idx, type = 'notify_team') => {
    const next = [...actions]
    next.splice(idx, 0, { type })
    setActions(next)
    setSel({ kind: 'action', idx })
    setAddAt(null)
    touch()
  }
  const removeAction = (idx) => {
    setActions((cur) => cur.filter((_, i) => i !== idx))
    setSel(null)
    touch()
  }
  const moveAction = (idx, dir) => {
    const j = idx + dir
    if (j < 0 || j >= actions.length) return
    const next = [...actions]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setActions(next)
    setSel({ kind: 'action', idx: j })
    touch()
  }

  const validate = () => {
    if (!name.trim()) return 'Give the workflow a name.'
    if (!trigger?.type) return 'Pick what starts the workflow.'
    if (trigger.type === 'invoice_unpaid_for' && !trigger.days) return 'Set the days-unpaid threshold.'
    if (trigger.type === 'estimate_unanswered_for' && !trigger.days) return 'Set the days-without-response threshold.'
    if (!actions.length) return 'Add at least one action.'
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]
      if (a.type === 'text_customer' && !String(a.message_template || '').trim()) return `Action ${i + 1}: write the text message.`
      if (a.type === 'email_customer' && !String(a.body_template || '').trim()) return `Action ${i + 1}: write the email body.`
      if (a.type === 'notify_members') {
        if (!a.audience) return `Action ${i + 1}: pick who gets notified.`
        if (a.audience === 'selected' && !(a.member_ids || []).length) return `Action ${i + 1}: pick at least one person.`
      }
    }
    return ''
  }

  const save = async () => {
    const v = validate()
    if (v) { setErr(v); return }
    setErr(''); setBusy(true)
    const { error } = await supabase.rpc('save_automation_rule', {
      p_workspace_id: SENTINEL_WS,
      p_id: rule?.id || null,
      p_name: name.trim(),
      p_trigger: trigger,
      p_result: actions[0],
      p_enabled: enabled,
      p_actions: actions.slice(1),
    })
    setBusy(false)
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST202' || error.code === 'PGRST205' || /does not exist/i.test(error.message || '')) {
        setErr("The workflow builder isn't live on this deployment yet — the update hasn't been applied, so nothing was saved.")
        return
      }
      setErr(error.message || "Couldn't save the workflow.")
      return
    }
    onSaved()
  }

  const zoomBy = (d) => setZoom((z) => Math.min(1.6, Math.max(0.4, Math.round((z + d) * 10) / 10)))

  return (
    <div className="panel auto-group wf-builder">
      {/* top bar */}
      <div className="wf-topbar">
        <button type="button" className="wf-back" onClick={onClose}>
          <Svg d={Ic.chevL} /> Workflows
        </button>
        <input className="wf-name" value={name} disabled={busy} onChange={(e) => { setName(e.target.value); touch() }}
          placeholder="Workflow name" />
        <span className={'wf-saved' + (dirty ? ' dirty' : '')}>{dirty ? 'Unsaved changes' : 'Saved'}</span>
        <div className="wf-pub">
          <span className={'wf-pub-lab' + (!enabled ? ' on' : '')}>Draft</span>
          <Toggle on={enabled} disabled={busy} onChange={(v) => { setEnabled(v); touch() }} />
          <span className={'wf-pub-lab' + (enabled ? ' on' : '')}>Publish</span>
        </div>
        <button className="solid-btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      {err && <div className="oc-err" style={{ padding: '6px 16px 0' }}>{err}</div>}

      <div className="wf-body">
        {/* left: build panel */}
        <div className="wf-side">
          {draft?.summary && (
            <div className="wf-ai-summary">
              <b><Svg d={Ic.bolt} /> {draft.fromTemplate ? `From the “${draft.fromTemplate}” template` : 'Prefilled draft'}</b>
              <p>{draft.summary}</p>
            </div>
          )}
          {sel == null && (
            <div className="wf-summary">
              <p className="wf-summary-h">Build</p>
              <p className="wf-fields-hint">Click a node on the canvas to edit it, or use a <b>+</b> between nodes to add an action.</p>
              <p className="wf-summary-sub">Trigger:</p>
              <ol className="wf-summary-list">
                <li><b>{triggerLine(trigger)}</b></li>
              </ol>
              <p className="wf-summary-sub">Actions:</p>
              <ol className="wf-summary-list">
                {actions.map((a, i) => <li key={i}><b>{actionLine(a)}</b></li>)}
              </ol>
            </div>
          )}
          {sel?.kind === 'trigger' && (
            <>
              <div className="wf-side-head">
                <b>Trigger</b>
                <button type="button" className="wf-x" onClick={() => setSel(null)}><Svg d={Ic.x} /></button>
              </div>
              <WorkflowNodeEditor kind="trigger" value={trigger} crewActive={[]} workspace={workspace} disabled={busy}
                onChange={(v) => { setTrigger(v); touch() }} />
            </>
          )}
          {sel?.kind === 'action' && actions[sel.idx] != null && (
            <>
              <div className="wf-side-head">
                <b>Action {sel.idx + 1}</b>
                <button type="button" className="wf-x" onClick={() => setSel(null)}><Svg d={Ic.x} /></button>
              </div>
              <WorkflowNodeEditor kind="action" value={actions[sel.idx]} crewActive={workspace?.crew || []} workspace={workspace} disabled={busy}
                onChange={(v) => { const next = [...actions]; next[sel.idx] = v; setActions(next); touch() }} />
            </>
          )}
        </div>

        {/* right: canvas */}
        <div className="wf-canvas-wrap" ref={canvasRef}>
          <div className="wf-canvas" style={{ transform: `scale(${zoom})` }}>
            <div className={'wf-node wf-node-trigger' + (sel?.kind === 'trigger' ? ' sel' : '')}
              onClick={() => setSel({ kind: 'trigger' })}>
              <div className="wf-node-ico"><Svg d={TRIGGER_ICON[trigger.type] || Ic.bolt} /></div>
              <div className="wf-node-t">
                <span className="wf-node-cat">Trigger · {WORKFLOW_TRIGGERS.find(([k]) => k === trigger.type)?.[1] || trigger.type}</span>
                <b>{triggerLine(trigger)}</b>
              </div>
              <span className="wf-node-edit"><Svg d={Ic.edit} /></span>
            </div>

            <div className="wf-conn">
              <button type="button" className="wf-plus" title="Add action here" disabled={busy}
                onClick={(e) => { e.stopPropagation(); setAddAt(addAt === 0 ? null : 0) }}><Svg d={Ic.plus} /></button>
              {addAt === 0 && <ActionPicker onPick={(t) => { const next = [...actions]; next.splice(0, 0, { type: t }); setActions(next); setSel({ kind: 'action', idx: 0 }); setAddAt(null); touch() }} onClose={() => setAddAt(null)} />}
            </div>

            {actions.map((a, i) => (
              <div key={i}>
                <div className={'wf-node' + (sel?.kind === 'action' && sel.idx === i ? ' sel' : '')}
                  onClick={() => setSel({ kind: 'action', idx: i })}>
                  <div className="wf-node-ico"><Svg d={ACTION_ICON[a.type] || Ic.bolt} /></div>
                  <div className="wf-node-t">
                    <span className="wf-node-cat">Action {i + 1} · {ACTION_MENU.find(([k]) => k === a.type)?.[1] || a.type}</span>
                    <b>{actionLine(a)}</b>
                  </div>
                  <div className="wf-node-tools" onClick={(e) => e.stopPropagation()}>
                    <button type="button" title="Move up" disabled={i === 0 || busy} onClick={() => moveAction(i, -1)}>↑</button>
                    <button type="button" title="Move down" disabled={i === actions.length - 1 || busy} onClick={() => moveAction(i, 1)}>↓</button>
                    <button type="button" title="Remove this action" disabled={busy} onClick={() => removeAction(i)}><Svg d={Ic.x} /></button>
                  </div>
                </div>
                <div className="wf-conn">
                  <button type="button" className="wf-plus" title="Add action here" disabled={busy}
                    onClick={(e) => { e.stopPropagation(); setAddAt(addAt === i + 1 ? null : i + 1) }}><Svg d={Ic.plus} /></button>
                  {addAt === i + 1 && <ActionPicker onPick={(t) => insertAction(i + 1, t)} onClose={() => setAddAt(null)} />}
                </div>
              </div>
            ))}

            <div className="wf-end">END</div>
          </div>
          <div className="wf-zoom">
            <button type="button" onClick={() => zoomBy(-0.1)}>−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => zoomBy(0.1)}>+</button>
            <button type="button" onClick={() => setZoom(1)}>Fit</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* The action-type menu that pops off a + connector. */
function ActionPicker({ onPick, onClose }) {
  return (
    <div className="wf-picker">
      {ACTION_MENU.map(([k, lab]) => (
        <button key={k} type="button" onClick={() => onPick(k)}>
          <Svg d={ACTION_ICON[k] || Ic.bolt} /> {lab}
        </button>
      ))}
      <button type="button" className="wf-picker-x" onClick={onClose}><Svg d={Ic.x} /></button>
    </div>
  )
}

/* The workflow list — folders, search, run counters, builder entry. */
function WorkflowsPanel({ workspace, canEdit, highlight }) {
  const [rules, setRules] = useState(null) // null = loading
  const [runs, setRuns] = useState({})     // rule id -> times fired
  const [folders, setFolders] = useState([])
  const [err, setErr] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [tab, setTab] = useState('all')
  const [group, setGroup] = useState('all')   // "all" | folder id
  const [q, setQ] = useState('')
  const [builder, setBuilder] = useState(null)  // {rule?, draft?}
  const [addingGroup, setAddingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [renaming, setRenaming] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [moveFor, setMoveFor] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const { data, error } = await supabase
      .from('automation_rules')
      .select('id,name,enabled,trigger,result,actions,created_by,created_at,updated_at,folder_id')
      .eq('workspace_id', SENTINEL_WS)
      .order('created_at', { ascending: false })
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205' || /relation .* does not exist/i.test(error.message)) {
        setRules([]); return
      }
      setErr(error.message); setRules([]); return
    }
    setRules(data || [])
    const { data: fds } = await supabase
      .from('automation_folders')
      .select('id,name,position')
      .eq('workspace_id', SENTINEL_WS)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
    setFolders(fds || [])
    // Times run — one head-count per rule off the automation_sends ledger.
    const counts = {}
    await Promise.all((data || []).map(async (r) => {
      const { count } = await supabase.from('automation_sends')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', SENTINEL_WS)
        .eq('automation_key', `rule:${r.id}`)
      counts[r.id] = count || 0
    }))
    setRuns(counts)
  }

  useEffect(() => { load() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])

  // Deep-link: clear filters that could hide the target row, then scroll to it.
  const hlIds = highlight ? new Set(highlight) : null
  useEffect(() => {
    if (!highlight || !highlight.length) return
    setTab('all'); setGroup('all'); setQ('')
    const t = setTimeout(() => {
      document.getElementById(`wf-row-${highlight[0]}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    return () => clearTimeout(t)
  }, [highlight])

  const remove = async (id) => {
    if (!window.confirm('Delete this workflow? This cannot be undone.')) return
    setErr('')
    const { error } = await supabase.from('automation_rules').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    setRules((rs) => (rs || []).filter((r) => r.id !== id))
  }

  const toggle = async (rule) => {
    const next = !rule.enabled
    setErr('')
    setRules((rs) => (rs || []).map((r) => (r.id === rule.id ? { ...r, enabled: next } : r)))
    const { error } = await supabase.rpc('set_automation_enabled', { p_id: rule.id, p_enabled: next })
    if (error) {
      setRules((rs) => (rs || []).map((r) => (r.id === rule.id ? { ...r, enabled: !next } : r)))
      setErr(error.message || "Couldn't change that workflow.")
    }
  }

  /* ---------- groups (folders) ---------- */
  const addGroup = async () => {
    const name = groupName.trim()
    if (!name || busy) return
    setBusy(true); setErr('')
    const { data, error } = await supabase.from('automation_folders')
      .insert({ workspace_id: SENTINEL_WS, name: name.slice(0, 60), position: folders.length })
      .select('id,name,position').single()
    setBusy(false)
    if (error) { setErr(error.message); return }
    setFolders((f) => [...f, data])
    setGroup(data.id)
    setGroupName(''); setAddingGroup(false)
  }

  const renameGroup = async (f) => {
    const name = renameVal.trim()
    setRenaming(null)
    if (!name || name === f.name) return
    setFolders((fs) => fs.map((x) => (x.id === f.id ? { ...x, name } : x)))
    const { error } = await supabase.from('automation_folders').update({ name }).eq('id', f.id)
    if (error) { setErr(error.message); load() }
  }

  const delGroup = async (f) => {
    const n = (rules || []).filter((r) => r.folder_id === f.id).length
    if (!window.confirm(n
      ? `Delete the group "${f.name}"? Its ${n} workflow${n > 1 ? 's' : ''} stay — they just become ungrouped.`
      : `Delete the empty group "${f.name}"?`)) return
    setErr('')
    const { error } = await supabase.from('automation_folders').delete().eq('id', f.id)
    if (error) { setErr(error.message); return }
    setFolders((fs) => fs.filter((x) => x.id !== f.id))
    setRules((rs) => (rs || []).map((r) => (r.folder_id === f.id ? { ...r, folder_id: null } : r)))
    if (group === f.id) setGroup('all')
  }

  const moveTo = async (rule, folderId) => {
    setMoveFor(null); setErr('')
    const prev = rule.folder_id || null
    setRules((rs) => (rs || []).map((r) => (r.id === rule.id ? { ...r, folder_id: folderId } : r)))
    const { error } = await supabase.rpc('set_automation_rule_folder', {
      p_rule_id: rule.id, p_folder_id: folderId,
    })
    if (error) {
      setRules((rs) => (rs || []).map((r) => (r.id === rule.id ? { ...r, folder_id: prev } : r)))
      setErr(error.message || "Couldn't move that workflow.")
    }
  }

  if (!rules) return null
  if (!rules.length && !err && !canEdit) return null

  const drafts = rules.filter((r) => r.enabled === false).length
  const needle = q.trim().toLowerCase()
  const matchQ = (r) => !needle || r.name.toLowerCase().includes(needle)
  const shown = rules
    .filter((r) => tab === 'all' || r.enabled === false)
    .filter((r) => group === 'all' || r.folder_id === group)
    .filter(matchQ)
  const sections = group !== 'all'
    ? [{ folder: null, items: shown }]
    : [
        { folder: null, items: shown.filter((r) => !r.folder_id) },
        ...folders
          .map((f) => ({ folder: f, items: shown.filter((r) => r.folder_id === f.id) }))
          .filter((s) => s.items.length > 0),
      ].filter((s) => s.items.length > 0)

  if (builder) {
    return (
      <WorkflowBuilder workspace={workspace} rule={builder.rule || null} draft={builder.draft || null}
        onClose={() => setBuilder(null)}
        onSaved={() => { setBuilder(null); load() }} />
    )
  }

  return (
    <div className="panel auto-group wf-panel" id="workflows-panel">
      <div className="wf-head">
        <div className="auto-group-head" style={{ flex: 1 }}>
          <div className="auto-group-ico"><Svg d={Ic.automations} /></div>
          <div className="auto-item-t">
            <b>Workflows</b>
            <p>{rules.length ? `${rules.length - drafts} published · ${drafts} draft${drafts === 1 ? '' : 's'}` : 'When something happens, do this — build your own automations.'}</p>
          </div>
        </div>
        <div className="wf-head-btns">
          <label className="wf-search">
            <Svg d={Ic.search} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workflows" />
          </label>
          {canEdit && (
            <div className="wf-create">
              <button type="button" className="wf-create-btn" onClick={() => setMenuOpen((o) => !o)}>
                <Svg d={Ic.plus} /> Create workflow
              </button>
              {menuOpen && (
                <>
                  <div className="wf-create-veil" onClick={() => setMenuOpen(false)} />
                  <div className="wf-create-menu">
                    <button type="button" onClick={() => { setMenuOpen(false); setBuilder({ rule: null }) }}>
                      <Svg d={Ic.edit} /> Start from Scratch
                    </button>
                    <div className="wf-menu-divider">Start from a template</div>
                    {WORKFLOW_TEMPLATES.map((t) => (
                      <button key={t.key} type="button" onClick={() => {
                        setMenuOpen(false)
                        setBuilder({ rule: null, draft: { ...t.draft, summary: t.blurb, fromTemplate: t.title } })
                      }}>
                        <Svg d={Ic.bolt} /> {t.title}
                      </button>
                    ))}
                    {rules.length > 0 && (
                      <button type="button" onClick={() => {
                        setMenuOpen(false)
                        const src = rules[0]
                        setBuilder({ rule: { ...src, id: null, name: `${src.name} (copy)` } })
                      }}>
                        <Svg d={Ic.layers} /> Duplicate “{rules[0].name.length > 24 ? rules[0].name.slice(0, 24) + '…' : rules[0].name}”
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {rules.length > 0 && (
        <div className="wf-tabs">
          <button type="button" className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All workflows</button>
          <button type="button" className={tab === 'drafts' ? 'on' : ''} onClick={() => setTab('drafts')}>Drafts{drafts ? ` (${drafts})` : ''}</button>
        </div>
      )}

      {err && <span className="oc-err" style={{ display: 'block', margin: '8px 0' }}>{err}</span>}

      {rules.length === 0 && canEdit && !err && (
        <div className="wf-empty">
          <Svg d={Ic.automations} />
          <b>No workflows yet</b>
          <p>Start from scratch or grab a template — declined-card alerts, chargeback alerts, invoice reminders.</p>
        </div>
      )}

      {rules.length > 0 && (
        <div className="wf-layout">
          <aside className="wf-side-nav">
            <button type="button" className={'wf-sn-item' + (group === 'all' ? ' on' : '')} onClick={() => setGroup('all')}>
              <span className="wf-sn-name">All workflows</span>
              <span className="wf-sn-count">{rules.length}</span>
            </button>
            {folders.map((f) => (
              <div key={f.id} className={'wf-sn-item wf-sn-group' + (group === f.id ? ' on' : '')}
                onClick={() => setGroup(group === f.id ? 'all' : f.id)}>
                {renaming === f.id ? (
                  <input className="wf-sn-rename" autoFocus value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => renameGroup(f)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') renameGroup(f)
                      if (e.key === 'Escape') setRenaming(null)
                    }} />
                ) : (
                  <span className="wf-sn-name"><Svg d={Ic.layers} />{f.name}</span>
                )}
                <span className="wf-sn-count">{(rules || []).filter((r) => r.folder_id === f.id).length}</span>
                {canEdit && renaming !== f.id && (
                  <span className="wf-sn-acts" onClick={(e) => e.stopPropagation()}>
                    <button title="Rename group" onClick={() => { setRenaming(f.id); setRenameVal(f.name) }}><Svg d={Ic.edit} /></button>
                    <button className="auto-rule-del" title="Delete group" onClick={() => delGroup(f)}>×</button>
                  </span>
                )}
              </div>
            ))}
            {canEdit && (addingGroup ? (
              <input className="wf-sn-rename" autoFocus placeholder="Group name…" value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                onBlur={() => { if (!groupName.trim()) setAddingGroup(false) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addGroup()
                  if (e.key === 'Escape') { setAddingGroup(false); setGroupName('') }
                }} />
            ) : (
              <button type="button" className="wf-sn-item wf-sn-new" onClick={() => setAddingGroup(true)}>
                <span className="wf-sn-name">＋ New group</span>
              </button>
            ))}
          </aside>

          <div className="wf-list">
            {sections.every((s) => s.items.length === 0) && (
              <div className="wf-empty">
                <b>{needle ? 'No workflows match that search' : 'Nothing here'}</b>
                <p>{group !== 'all' ? 'This group is empty — use Move to on a workflow to fill it.' : 'Try the other tab, or clear the search.'}</p>
              </div>
            )}
            {sections.map((sec) => (
              <div key={sec.folder ? sec.folder.id : 'ungrouped'}>
                {sec.folder && (
                  <div className="wf-sec-h">
                    <Svg d={Ic.layers} />
                    <b>{sec.folder.name}</b>
                    <span className="wf-sn-count">{sec.items.length}</span>
                  </div>
                )}
                {sec.items.map((r) => {
                  const steps = [r.result, ...(r.actions || [])].filter(Boolean)
                  const pub = r.enabled !== false
                  const curFolder = folders.find((f) => f.id === r.folder_id) || null
                  return (
                    <div className={'wf-row' + (hlIds?.has(r.id) ? ' hl' : '')} key={r.id} id={`wf-row-${r.id}`}>
                      <Toggle on={pub} disabled={!canEdit} onChange={() => toggle(r)} />
                      <div className="wf-row-main">
                        <b>{r.name}</b>
                        <p>
                          <span className="auto-rule-trigger">When: {ruleTriggerLabel(r.trigger)}</span>
                          <span className="auto-rule-arrow"> → </span>
                          {steps.map((a, i) => (
                            <span key={i}>
                              {i > 0 && <span className="auto-rule-arrow"> then </span>}
                              <span className="auto-rule-result">{ruleResultLabel(a)}</span>
                            </span>
                          ))}
                        </p>
                        <p className="wf-meta">
                          {!pub && <span className="wf-draft-tag">Draft</span>}
                          <span>Last updated {wfRelTime(r.updated_at || r.created_at)}</span>
                          {curFolder && <span className="wf-meta-chip"><Svg d={Ic.layers} />{curFolder.name}</span>}
                        </p>
                      </div>
                      <div className="wf-row-side">
                        <span className="wf-runs" title="Times this workflow has fired">{runs[r.id] ? `${runs[r.id]}× run` : 'Not run yet'}</span>
                        {canEdit && <button className="ghost-btn" onClick={() => setBuilder({ rule: r })}>Edit</button>}
                        {canEdit && (
                          <div className="wf-create wf-move">
                            <button className="ghost-btn" onClick={() => setMoveFor(moveFor === r.id ? null : r.id)}>Move to</button>
                            {moveFor === r.id && (
                              <>
                                <div className="wf-create-veil" onClick={() => setMoveFor(null)} />
                                <div className="wf-create-menu">
                                  {folders.map((f) => (
                                    <button key={f.id} type="button" className={r.folder_id === f.id ? 'wf-move-on' : ''}
                                      onClick={() => moveTo(r, f.id)}>
                                      <Svg d={Ic.layers} /> {f.name}
                                      {r.folder_id === f.id && <span className="wf-move-check">✓</span>}
                                    </button>
                                  ))}
                                  {r.folder_id && (
                                    <button type="button" onClick={() => moveTo(r, null)}>
                                      Remove from group
                                    </button>
                                  )}
                                  {!folders.length && (
                                    <span className="wf-move-empty">No groups yet — create one on the left.</span>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                        {canEdit && (
                          <button className="ghost-btn" title="Duplicate this workflow"
                            onClick={() => setBuilder({ rule: { ...r, id: null, name: `${r.name} (copy)` } })}>
                            <Svg d={Ic.layers} />
                          </button>
                        )}
                        {canEdit && <button className="ghost-btn auto-rule-del" onClick={() => remove(r.id)} title="Delete this workflow">Delete</button>}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* "Last updated 4h ago" — compact relative stamp for the list rows. */
function wfRelTime(iso) {
  if (!iso) return 'never'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

/* The studio surface — mounted as a sub-tab of the Automations page.
 * workspace: { name, business_phone, crew } pseudo-workspace assembled by
 * the parent from app settings + profiles. */
export default function WorkflowStudio({ app }) {
  const [crew, setCrew] = useState([])
  const canEdit = !!(app?.user && app.user.role === 'admin')

  useEffect(() => {
    let live = true
    supabase.from('profiles')
      .select('id, full_name, role, is_driver')
      .in('role', ['admin', 'staff'])
      .then(({ data }) => {
        if (!live) return
        setCrew((data || []).map((p) => ({ id: p.id, name: p.full_name || p.role, is_driver: p.is_driver })))
      })
      .catch(() => {})
    return () => { live = false }
  }, [])

  const workspace = {
    id: SENTINEL_WS,
    name: app?.settings?.company_name || 'Valet Waste FL',
    business_phone: app?.settings?.company_phone || '',
    crew,
  }

  return <WorkflowsPanel workspace={workspace} canEdit={canEdit} />
}
