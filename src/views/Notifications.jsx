// Notifications center: one place for the business team to see every
// notification the system sends — what's wired up, whether it's on, and
// which specific clients have opted out of a channel.
import { useEffect, useState } from 'react'
import {
  loadNotificationToggles,
  saveNotificationToggles,
  loadNotificationOptOuts,
  reEnableNotifications,
} from '../lib/notificationsData.js'

const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 14, marginBottom: 16, overflow: 'hidden' }
const cardHead = { padding: '13px 18px 11px', borderBottom: '1px solid #eef1ee', fontWeight: 700, fontSize: 14, color: '#2c3a32', display: 'flex', alignItems: 'center', gap: 8 }
const rowStyle = { display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderBottom: '1px solid #f2f4f2' }
const rowLast = { ...rowStyle, borderBottom: 'none' }
const nameStyle = { fontWeight: 600, fontSize: 13.5, color: '#2c3a32' }
const descStyle = { fontSize: 12, color: '#7c8a82', marginTop: 2 }

// CLIENT_* rows are customer-facing; TEAM_* go to staff.
const CLIENT_ROWS = [
  ['client_arrival', 'Tech arrival notice', '“Your tech is at your property” — push notification, then text, then email'],
  ['client_complete', 'Service complete', '“Service is done” with photos — push, then text, then email'],
  ['client_invoice_email', 'Invoice & reminder emails', 'Invoice sent and payment reminders delivered by email'],
  ['client_invoice_sms', 'Invoice & reminder texts', 'Payment reminders delivered by text message'],
  ['client_portal_invite', 'Portal invites', '“Your portal is ready” invite by email + text (includes the 5th-week-free pitch)'],
  ['client_service_reminder', 'Day-before pickup reminders', '“Your pickup is tomorrow” — push by default, optional email (its own schedule lives in Automations)'],
]
const TEAM_ROWS = [
  ['team_new_property', 'New property alerts', 'Admins get a text + email + push when a new property or request arrives'],
  ['team_payment_events', 'Payment events', 'Admins get texts when a payment is paid, declined, or refunded'],
  ['team_automation_alerts', 'Automation alerts', 'Staff alerts fired by automation rules — each rule also has its own switch in Automations'],
]

function Toggle({ on, disabled, onChange }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      style={{
        flex: 'none', width: 44, height: 25, borderRadius: 13, border: 'none', cursor: disabled ? 'wait' : 'pointer',
        background: on ? '#1f7a4d' : '#c9d2cc', position: 'relative', transition: 'background .15s', padding: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2.5, left: on ? 21 : 2.5, width: 20, height: 20, borderRadius: '50%',
        background: '#fff', transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
      }} />
    </button>
  )
}

export default function Notifications({ app }) {
  const [tab, setTab] = useState('toggles') // toggles | optouts
  const [toggles, setToggles] = useState(null)
  const [optOuts, setOptOuts] = useState(null)
  const [err, setErr] = useState('')
  const [busyKey, setBusyKey] = useState(null)
  const [busyClient, setBusyClient] = useState(null)

  async function refreshToggles() {
    try { setToggles(await loadNotificationToggles()) }
    catch (e) { setErr(e.message || String(e)) }
  }
  async function refreshOptOuts() {
    try { setOptOuts(await loadNotificationOptOuts()) }
    catch (e) { setErr(e.message || String(e)) }
  }

  useEffect(() => {
    refreshToggles()
    refreshOptOuts()
  }, [])

  async function flip(key, next) {
    setErr('')
    const updated = { ...toggles, [key]: next }
    setToggles(updated) // optimistic
    setBusyKey(key)
    try { await saveNotificationToggles(updated) }
    catch (e) { setErr(e.message || String(e)); await refreshToggles() }
    finally { setBusyKey(null) }
  }

  async function reEnable(c, fields) {
    setErr('')
    setBusyClient(c.id)
    try {
      await reEnableNotifications(c.id, fields)
      await refreshOptOuts()
    } catch (e) { setErr(e.message || String(e)) }
    finally { setBusyClient(null) }
  }

  const anyOff = (c) => c.notify_on_service === false || c.notify_sms === false || c.notify_email === false

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {err && <div style={{ background: '#fbeae6', color: '#c0492f', border: '1px solid #c0492f33', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, background: '#eef1ee', padding: 4, borderRadius: 11, width: 'fit-content' }}>
        {[['toggles', '🔔 Notification switches'], ['optouts', '◎ Client opt-outs']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            background: tab === id ? '#fff' : 'transparent', color: tab === id ? '#1f7a4d' : '#5d6b63',
            boxShadow: tab === id ? '0 1px 3px rgba(0,0,0,.12)' : 'none',
          }}>{label}</button>
        ))}
      </div>

      {tab === 'toggles' ? (
        toggles === null ? (
          <div style={{ padding: 28, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: '#5d6b63', marginBottom: 14 }}>
              These switches control whether each notification type goes out at all. Turning one off stops it for everyone — clients who individually opted out are listed in the <b>Client opt-outs</b> tab, and everyone not listed there receives everything that's switched on.
            </div>

            <div style={card}>
              <div style={cardHead}>👤 Client notifications</div>
              {CLIENT_ROWS.map(([key, label, desc], i) => (
                <div key={key} style={i === CLIENT_ROWS.length - 1 ? rowLast : rowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nameStyle}>{label}</div>
                    <div style={descStyle}>{desc}</div>
                  </div>
                  <Toggle on={!!toggles[key]} disabled={busyKey === key} onChange={(n) => flip(key, n)} />
                </div>
              ))}
            </div>

            <div style={card}>
              <div style={cardHead}>⚇ Team notifications</div>
              {TEAM_ROWS.map(([key, label, desc], i) => (
                <div key={key} style={i === TEAM_ROWS.length - 1 ? rowLast : rowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nameStyle}>{label}</div>
                    <div style={descStyle}>{desc}</div>
                  </div>
                  <Toggle on={!!toggles[key]} disabled={busyKey === key} onChange={(n) => flip(key, n)} />
                </div>
              ))}
            </div>

            <div style={{ fontSize: 12, color: '#7c8a82', padding: '4px 2px' }}>
              Note: Trashy Randy's one-off “send a text” messages are staff-initiated, so they stay available regardless of these switches — only automated sends are gated here. The global texting pause (Settings → SMS) and each automation rule's own switch still apply on top of these.
            </div>
          </>
        )
      ) : (
        <>
          <div style={{ fontSize: 13, color: '#5d6b63', marginBottom: 14 }}>
            Only clients who specifically turned something off appear here — everyone else is fully opted in. Opt-outs come from the 🔔 card in the client portal or the “unsubscribe” link in notification messages.
          </div>
          {optOuts === null ? (
            <div style={{ padding: 28, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading…</div>
          ) : !optOuts.length ? (
            <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '40px 24px', textAlign: 'center', color: '#7c8a82', fontSize: 13 }}>
              🎉 Nobody has opted out — every client is receiving all notification types.
            </div>
          ) : (
            <div style={card}>
              {optOuts.map((c, i) => (
                <div key={c.id} style={i === optOuts.length - 1 ? rowLast : rowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nameStyle}>{c.name || 'Unnamed client'}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                      {c.notify_on_service === false && (
                        <span style={{ fontSize: 11.5, background: '#faf3e2', color: '#b07d18', borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>Service texts/emails off</span>
                      )}
                      {c.notify_sms === false && (
                        <span style={{ fontSize: 11.5, background: '#fdecea', color: '#9a2c1e', borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>All SMS off</span>
                      )}
                      {c.notify_email === false && (
                        <span style={{ fontSize: 11.5, background: '#fdecea', color: '#9a2c1e', borderRadius: 20, padding: '3px 10px', fontWeight: 600 }}>All email off</span>
                      )}
                    </div>
                  </div>
                  {app?.openClient && (
                    <button
                      onClick={() => app.openClient(c.id)}
                      style={{ flex: 'none', background: '#fff', color: '#5d6b63', border: '1px solid #e6eae6', borderRadius: 9, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >View</button>
                  )}
                  {anyOff(c) && (
                    <button
                      disabled={busyClient === c.id}
                      onClick={() => reEnable(c, ['notify_on_service', 'notify_sms', 'notify_email'].filter((f) => c[f] === false))}
                      style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: busyClient === c.id ? 'wait' : 'pointer' }}
                    >{busyClient === c.id ? '…' : 'Turn back on'}</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
