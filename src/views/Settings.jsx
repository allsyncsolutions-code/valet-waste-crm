import { useEffect, useState } from 'react'
import { MONO } from '../data.js'
import { listTags, createTag, updateTag, deleteTag, tagUsageCounts, subscribeTags, TAG_COLORS } from '../lib/tagsData.js'
import { loadSettings, saveDepot, geocodeAddress, subscribeSettings, saveSmsTemplates, saveRandyTone, RANDY_TONES } from '../lib/settingsData.js'
import { stripeStatus, stripeOnboard } from '../lib/stripeData.js'
import { platformBillingStatus, platformBillingCheckout, platformBillingPortal } from '../lib/platformBillingData.js'
import { getSmsConfig, saveSmsConfig, sendTestSms, listSmsSubscriptions, ensureSmsSubscription } from '../lib/smsData.js'

const EMPTY_SMS = {
  sms_enabled: false,
  sms_from_number: '',
  rc_server_url: 'https://platform.ringcentral.com',
  rc_client_id: '',
  rc_client_secret: '',
  rc_jwt: '',
  rc_webhook_verification_token: '',
}

export default function Settings({ app }) {
  const isMobile = app.isMobile
  const [tags, setTags] = useState([])
  const [counts, setCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(TAG_COLORS[0])
  const [confirmId, setConfirmId] = useState(null)
  const [paletteFor, setPaletteFor] = useState(null)
  const [depot, setDepot] = useState({ name: '', address: '', lat: '', lng: '' })
  const [depotMsg, setDepotMsg] = useState(null)
  const [geoBusy, setGeoBusy] = useState(false)
  const [depotSaving, setDepotSaving] = useState(false)
  const [stripe, setStripe] = useState({ loading: true, data: null, busy: false, err: null })
  const [billing, setBilling] = useState({ loading: true, data: null, busy: false, err: null })
  const [sms, setSms] = useState(EMPTY_SMS)
  const [smsFlags, setSmsFlags] = useState({ rc_secret_set: false, rc_jwt_set: false, rc_webhook_token_set: false })
  const [smsWebhookUrl, setSmsWebhookUrl] = useState('')
  const [smsMsg, setSmsMsg] = useState(null)
  const [smsSaving, setSmsSaving] = useState(false)
  const [smsTestTo, setSmsTestTo] = useState('')
  const [smsTesting, setSmsTesting] = useState(false)
  const [smsSub, setSmsSub] = useState({ loading: false, list: [], busy: false })
  const [tpl, setTpl] = useState({ company_name: '', sms_checkin_template: '', sms_checkout_template: '', sms_reminder_template: '', sms_invoice_template: '' })
  const [tplSaving, setTplSaving] = useState(false)
  const [tplMsg, setTplMsg] = useState(null)
  const [randyTone, setRandyTone] = useState('spicy')
  const [randyMsg, setRandyMsg] = useState(null)

  async function refresh() {
    const [t, c] = await Promise.all([listTags(), tagUsageCounts()])
    setTags(t)
    setCounts(c)
  }
  useEffect(() => {
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    const unsub = subscribeTags(() => refresh().catch(() => {}))
    return unsub
  }, [])

  useEffect(() => {
    const load = () => loadSettings().then((s) => {
      if (s) {
        setDepot({ name: s.depot_name || '', address: s.depot_address || '', lat: s.depot_lat ?? '', lng: s.depot_lng ?? '' })
        setTpl({
          company_name: s.company_name || '',
          sms_checkin_template: s.sms_checkin_template || '',
          sms_checkout_template: s.sms_checkout_template || '',
          sms_reminder_template: s.sms_reminder_template || '',
          sms_invoice_template: s.sms_invoice_template || '',
        })
        if (s.randy_tone) setRandyTone(s.randy_tone)
      }
    }).catch(() => {})
    load()
    const unsub = subscribeSettings(load)
    return unsub
  }, [])

  async function geocode() {
    const q = depot.address.trim()
    if (!q) return
    setGeoBusy(true)
    setDepotMsg(null)
    try {
      const r = await geocodeAddress(q)
      setDepot((d) => ({ ...d, lat: r.lat.toFixed(6), lng: r.lng.toFixed(6) }))
      setDepotMsg({ type: 'ok', text: 'Found: ' + r.display })
    } catch (e) {
      setDepotMsg({ type: 'err', text: e.message || String(e) })
    } finally {
      setGeoBusy(false)
    }
  }
  async function saveLoc(e) {
    e.preventDefault()
    const lat = parseFloat(depot.lat)
    const lng = parseFloat(depot.lng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setDepotMsg({ type: 'err', text: 'Enter a valid latitude and longitude (use Look up, or type them in).' })
      return
    }
    setDepotSaving(true)
    setDepotMsg(null)
    try {
      await saveDepot({ name: depot.name.trim(), address: depot.address.trim(), lat, lng })
      setDepotMsg({ type: 'ok', text: 'Saved — the route map will start here.' })
    } catch (e) {
      setDepotMsg({ type: 'err', text: e.message || String(e) })
    } finally {
      setDepotSaving(false)
    }
  }

  async function refreshStripe() {
    try {
      const d = await stripeStatus()
      setStripe((s) => ({ ...s, loading: false, data: d, err: null }))
    } catch (e) {
      setStripe((s) => ({ ...s, loading: false, err: e.message || String(e) }))
    }
  }
  useEffect(() => {
    refreshStripe()
    // returning from Stripe's hosted onboarding — clean the ?stripe= param
    const params = new URLSearchParams(window.location.search)
    if (params.get('stripe')) window.history.replaceState({}, '', window.location.pathname)
  }, [])
  async function connectStripe() {
    setStripe((s) => ({ ...s, busy: true, err: null }))
    try {
      const d = await stripeOnboard(window.location.origin)
      if (d && d.url) window.location.href = d.url
      else throw new Error('Could not start Stripe onboarding.')
    } catch (e) {
      setStripe((s) => ({ ...s, busy: false, err: e.message || String(e) }))
    }
  }

  async function refreshBilling() {
    try {
      const d = await platformBillingStatus()
      setBilling((s) => ({ ...s, loading: false, data: d, err: null }))
    } catch (e) {
      setBilling((s) => ({ ...s, loading: false, err: e.message || String(e) }))
    }
  }
  useEffect(() => {
    refreshBilling()
    // returning from Checkout / Billing Portal — clean the ?crm_billing= param
    const params = new URLSearchParams(window.location.search)
    if (params.get('crm_billing')) window.history.replaceState({}, '', window.location.pathname)
  }, [])
  async function startBilling() {
    setBilling((s) => ({ ...s, busy: true, err: null }))
    try {
      const d = await platformBillingCheckout()
      if (d && d.url) window.location.href = d.url
      else throw new Error('Could not start checkout.')
    } catch (e) {
      setBilling((s) => ({ ...s, busy: false, err: e.message || String(e) }))
    }
  }
  async function manageBilling() {
    setBilling((s) => ({ ...s, busy: true, err: null }))
    try {
      const d = await platformBillingPortal()
      if (d && d.url) window.location.href = d.url
      else throw new Error('Could not open the billing portal.')
    } catch (e) {
      setBilling((s) => ({ ...s, busy: false, err: e.message || String(e) }))
    }
  }

  useEffect(() => {
    getSmsConfig().then((c) => {
      setSms({
        sms_enabled: !!c.sms_enabled,
        sms_from_number: c.sms_from_number || '',
        rc_server_url: c.rc_server_url || 'https://platform.ringcentral.com',
        rc_client_id: c.rc_client_id || '',
        rc_client_secret: '',
        rc_jwt: '',
        rc_webhook_verification_token: '',
      })
      setSmsFlags({ rc_secret_set: !!c.rc_secret_set, rc_jwt_set: !!c.rc_jwt_set, rc_webhook_token_set: !!c.rc_webhook_token_set })
      setSmsWebhookUrl(c.webhook_url || '')
      if (c.sms_enabled) refreshSmsSubs()
    }).catch((e) => setSmsMsg({ type: 'err', text: e.message || String(e) }))
  }, [])

  async function saveSms(e) {
    e.preventDefault()
    setSmsSaving(true)
    setSmsMsg(null)
    try {
      await saveSmsConfig(sms)
      setSmsMsg({ type: 'ok', text: 'Saved.' })
      // re-pull so the masked/“saved” placeholders reflect what's now stored
      const c = await getSmsConfig()
      setSmsFlags({ rc_secret_set: !!c.rc_secret_set, rc_jwt_set: !!c.rc_jwt_set, rc_webhook_token_set: !!c.rc_webhook_token_set })
      setSms((s) => ({ ...s, rc_client_secret: '', rc_jwt: '' }))
    } catch (e2) {
      setSmsMsg({ type: 'err', text: e2.message || String(e2) })
    } finally {
      setSmsSaving(false)
    }
  }
  async function refreshSmsSubs() {
    setSmsSub((s) => ({ ...s, loading: true }))
    try {
      const r = await listSmsSubscriptions()
      setSmsSub((s) => ({ ...s, loading: false, list: r.subscriptions || [] }))
    } catch (e) {
      setSmsSub((s) => ({ ...s, loading: false }))
      setSmsMsg({ type: 'err', text: e.message || String(e) })
    }
  }
  async function connectInbound() {
    setSmsSub((s) => ({ ...s, busy: true }))
    setSmsMsg(null)
    try {
      await ensureSmsSubscription()
      setSmsMsg({ type: 'ok', text: 'Inbound replies connected — RingCentral will now POST customer texts to your webhook.' })
      await refreshSmsSubs()
    } catch (e) {
      setSmsMsg({ type: 'err', text: e.message || String(e) })
    } finally {
      setSmsSub((s) => ({ ...s, busy: false }))
    }
  }
  async function saveTemplates() {
    setTplSaving(true)
    setTplMsg(null)
    try {
      await saveSmsTemplates(tpl)
      setTplMsg({ type: 'ok', text: 'Templates saved.' })
    } catch (e) {
      setTplMsg({ type: 'err', text: e.message || String(e) })
    } finally {
      setTplSaving(false)
    }
  }
  async function pickTone(tone) {
    const prev = randyTone
    setRandyTone(tone)
    setRandyMsg(null)
    try {
      await saveRandyTone(tone)
      setRandyMsg({ type: 'ok', text: 'Saved — Randy will talk like this from his next reply.' })
    } catch (e) {
      setRandyTone(prev)
      setRandyMsg({ type: 'err', text: e.message || String(e) })
    }
  }
  async function testSms() {
    const to = smsTestTo.trim()
    if (!to) { setSmsMsg({ type: 'err', text: 'Enter a number to send a test to.' }); return }
    setSmsTesting(true)
    setSmsMsg(null)
    try {
      const r = await sendTestSms(to)
      setSmsMsg({ type: 'ok', text: `Test sent via ${r.provider || 'SMS'}.` })
    } catch (e) {
      setSmsMsg({ type: 'err', text: e.message || String(e) })
    } finally {
      setSmsTesting(false)
    }
  }

  async function addTag(e) {
    e.preventDefault()
    const n = newName.trim()
    if (!n) return
    try {
      await createTag(n, newColor)
      setNewName('')
      setNewColor(TAG_COLORS[0])
      await refresh()
    } catch (e2) {
      setErr(e2.message || String(e2))
    }
  }
  async function rename(id, name) {
    const n = (name || '').trim()
    if (!n) return refresh()
    try { await updateTag(id, { name: n }) } catch (e) { setErr(e.message || String(e)); refresh() }
  }
  async function recolor(id, color) {
    setPaletteFor(null)
    setTags((ts) => ts.map((t) => (t.id === id ? { ...t, color } : t)))
    try { await updateTag(id, { color }) } catch (e) { setErr(e.message || String(e)) }
  }
  async function remove(id) {
    if (confirmId !== id) { setConfirmId(id); return }
    setConfirmId(null)
    try { await deleteTag(id); await refresh() } catch (e) { setErr(e.message || String(e)) }
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      {/* starting location */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Starting location</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 16 }}>
          Your yard or depot. The route map centers here, and the optimizer starts every route from this point.
        </div>
        {depotMsg && (
          <div style={{ background: depotMsg.type === 'ok' ? '#eef7f1' : '#fdecea', border: '1px solid ' + (depotMsg.type === 'ok' ? '#cfe7da' : '#f3b7b0'), color: depotMsg.type === 'ok' ? '#1f7a4d' : '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 14 }}>{depotMsg.text}</div>
        )}
        <form onSubmit={saveLoc}>
          <SField label="Name"><input value={depot.name} onChange={(e) => setDepot((d) => ({ ...d, name: e.target.value }))} style={inp} placeholder="Main Yard" /></SField>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}><SField label="Address"><input value={depot.address} onChange={(e) => setDepot((d) => ({ ...d, address: e.target.value }))} style={inp} placeholder="123 Depot Rd, City, ST" /></SField></div>
            <button type="button" onClick={geocode} disabled={geoBusy || !depot.address.trim()} style={{ flex: 'none', marginBottom: 11, background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: geoBusy || !depot.address.trim() ? 0.6 : 1 }}>{geoBusy ? 'Looking…' : 'Look up'}</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
            <SField label="Latitude"><input value={depot.lat} onChange={(e) => setDepot((d) => ({ ...d, lat: e.target.value }))} style={inp} placeholder="44.804" /></SField>
            <SField label="Longitude"><input value={depot.lng} onChange={(e) => setDepot((d) => ({ ...d, lng: e.target.value }))} style={inp} placeholder="-93.278" /></SField>
          </div>
          <button type="submit" disabled={depotSaving} style={{ marginTop: 6, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: depotSaving ? 0.6 : 1 }}>{depotSaving ? 'Saving…' : 'Save location'}</button>
        </form>
      </div>

      {/* trashy randy personality */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Trashy Randy personality</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 14 }}>
          How Randy talks to your team in the dispatch chat. This is staff-only — anything a customer sees (invoices, texts, saved notes) always stays clean and professional, no matter the tone.
        </div>
        {randyMsg && (
          <div style={{ background: randyMsg.type === 'ok' ? '#eef7f1' : '#fdecea', border: '1px solid ' + (randyMsg.type === 'ok' ? '#cfe7da' : '#f3b7b0'), color: randyMsg.type === 'ok' ? '#1f7a4d' : '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 14 }}>{randyMsg.text}</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
          {RANDY_TONES.map(([id, label, desc]) => {
            const on = randyTone === id
            return (
              <div key={id} onClick={() => pickTone(id)} style={{ cursor: 'pointer', border: `1px solid ${on ? '#1f7a4d' : '#dde2dd'}`, background: on ? '#e7f1eb' : '#fff', borderRadius: 11, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ flex: 'none', marginTop: 2, width: 16, height: 16, borderRadius: '50%', border: `2px solid ${on ? '#1f7a4d' : '#c3ccc5'}`, background: on ? '#1f7a4d' : '#fff', boxShadow: on ? 'inset 0 0 0 2px #fff' : 'none' }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: on ? '#15281d' : '#1a2420' }}>{label}{id === 'spicy' ? ' 🌶️' : ''}</div>
                  <div style={{ fontSize: 11.5, color: '#7c8a82', marginTop: 2, lineHeight: 1.35 }}>{desc}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* payments */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Payments</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 16 }}>
          Connect your Stripe account to charge customers. You’ll sign in to Stripe — there are no API keys to copy.
        </div>
        {stripe.err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 14 }}>{stripe.err}</div>}
        {stripe.loading ? (
          <div style={{ color: '#9aa69e', fontSize: 13 }}>Checking Stripe status…</div>
        ) : stripe.data && stripe.data.connected && stripe.data.chargesEnabled ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#22b06b', flex: 'none' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Connected — ready to accept payments</div>
              <div style={{ fontSize: 11, color: '#9aa69e', fontFamily: MONO }}>{stripe.data.accountId}</div>
            </div>
            <button onClick={refreshStripe} style={{ background: '#fff', border: '1px solid #e6eae6', color: '#5d6b63', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Refresh</button>
          </div>
        ) : stripe.data && stripe.data.connected ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#c08a2e', flex: 'none' }} />
              <div style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>Stripe started — onboarding isn’t finished yet</div>
            </div>
            <button onClick={connectStripe} disabled={stripe.busy} style={{ background: '#635bff', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: stripe.busy ? 0.6 : 1 }}>{stripe.busy ? 'Opening…' : 'Finish Stripe setup'}</button>
          </div>
        ) : (
          <button onClick={connectStripe} disabled={stripe.busy} style={{ background: '#635bff', color: '#fff', border: 'none', borderRadius: 9, padding: '11px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', opacity: stripe.busy ? 0.6 : 1 }}>{stripe.busy ? 'Opening…' : 'Connect with Stripe'}</button>
        )}
      </div>

      {/* CRM subscription (platform billing — our own $250/mo) */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>CRM subscription</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 16 }}>
          Your Valet Waste CRM plan — $250/mo, billed on the 2nd. Card is entered and managed securely on Stripe.
        </div>
        {billing.err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 14 }}>{billing.err}</div>}
        {billing.loading ? (
          <div style={{ color: '#9aa69e', fontSize: 13 }}>Checking subscription…</div>
        ) : (() => {
          const st = (billing.data && billing.data.status) || 'none'
          const active = st === 'active' || st === 'trialing'
          const pastDue = st === 'past_due' || st === 'unpaid' || st === 'incomplete'
          const dot = active ? '#22b06b' : pastDue ? '#c0392b' : '#c08a2e'
          const label = active ? 'Active' : pastDue ? 'Payment needed' : st === 'canceled' ? 'Canceled' : 'Not set up'
          const nextDate = billing.data && billing.data.currentPeriodEnd
            ? new Date(billing.data.currentPeriodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : null
          const hasCustomer = billing.data && billing.data.hasCustomer
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: dot, flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{label}{active ? ' — $250/mo' : ''}</div>
                <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 2 }}>
                  {active && nextDate ? `Next charge ${nextDate}` : billing.data && billing.data.cancelAtPeriodEnd && nextDate ? `Ends ${nextDate}` : pastDue ? 'Update the card to keep service active' : 'Add a card to activate billing'}
                </div>
              </div>
              {active || (hasCustomer && billing.data.hasSubscription) ? (
                <button onClick={manageBilling} disabled={billing.busy} style={{ background: '#fff', border: '1px solid #635bff', color: '#635bff', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: billing.busy ? 0.6 : 1 }}>{billing.busy ? 'Opening…' : 'Manage billing'}</button>
              ) : (
                <button onClick={startBilling} disabled={billing.busy} style={{ background: '#635bff', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', opacity: billing.busy ? 0.6 : 1 }}>{billing.busy ? 'Opening…' : 'Set up billing'}</button>
              )}
            </div>
          )
        })()}
      </div>

      {/* text messaging (SMS) */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Text messaging (SMS)</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 16 }}>
          Connect your RingCentral developer app to send reminders, invoices, and check-in texts — and receive customer replies. When enabled, RingCentral takes priority over Telnyx for all outbound SMS.
        </div>
        {smsMsg && (
          <div style={{ background: smsMsg.type === 'ok' ? '#eef7f1' : '#fdecea', border: '1px solid ' + (smsMsg.type === 'ok' ? '#cfe7da' : '#f3b7b0'), color: smsMsg.type === 'ok' ? '#1f7a4d' : '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 14 }}>{smsMsg.text}</div>
        )}
        <form onSubmit={saveSms}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, cursor: 'pointer' }}>
            <span
              onClick={() => setSms((s) => ({ ...s, sms_enabled: !s.sms_enabled }))}
              style={{ width: 42, height: 24, borderRadius: 12, background: sms.sms_enabled ? '#22b06b' : '#cfd6d0', position: 'relative', flex: 'none', transition: 'background .15s' }}
            >
              <span style={{ position: 'absolute', top: 3, left: sms.sms_enabled ? 21 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
            </span>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Enable RingCentral SMS</span>
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 11 }}>
            <SField label="From Number"><input value={sms.sms_from_number} onChange={(e) => setSms((s) => ({ ...s, sms_from_number: e.target.value }))} style={inp} placeholder="(904) 902-7767" /></SField>
            <SField label="Server URL">
              <select value={sms.rc_server_url} onChange={(e) => setSms((s) => ({ ...s, rc_server_url: e.target.value }))} style={inp}>
                <option value="https://platform.ringcentral.com">Production (platform.ringcentral.com)</option>
                <option value="https://platform.devtest.ringcentral.com">Sandbox (platform.devtest.ringcentral.com)</option>
              </select>
            </SField>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 11 }}>
            <SField label="Client ID"><input value={sms.rc_client_id} onChange={(e) => setSms((s) => ({ ...s, rc_client_id: e.target.value }))} style={inp} placeholder="Client ID" /></SField>
            <SField label="Client Secret"><input type="password" value={sms.rc_client_secret} onChange={(e) => setSms((s) => ({ ...s, rc_client_secret: e.target.value }))} style={inp} placeholder={smsFlags.rc_secret_set ? 'Secret saved — enter new value to replace' : 'Client Secret'} /></SField>
          </div>

          <SField label="JWT Token">
            <textarea value={sms.rc_jwt} onChange={(e) => setSms((s) => ({ ...s, rc_jwt: e.target.value }))} style={{ ...inp, minHeight: 84, fontFamily: MONO, fontSize: 12.5, resize: 'vertical' }} placeholder={smsFlags.rc_jwt_set ? 'JWT saved — paste a new one to replace' : 'Paste your RingCentral JWT credential'} />
          </SField>

          <SField label="Webhook Verification Token (optional)">
            <input value={sms.rc_webhook_verification_token} onChange={(e) => setSms((s) => ({ ...s, rc_webhook_verification_token: e.target.value }))} style={inp} placeholder={smsFlags.rc_webhook_token_set ? 'Saved — enter new value to replace' : 'Require a Verification-Token header on inbound webhooks'} />
          </SField>

          <button type="submit" disabled={smsSaving} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: smsSaving ? 0.6 : 1 }}>{smsSaving ? 'Saving…' : 'Save RingCentral Settings'}</button>
        </form>

        {/* inbound replies (webhook subscription) */}
        <div style={{ borderTop: '1px solid #f0f2ef', marginTop: 18, paddingTop: 16 }}>
          <div style={{ fontSize: 12.5, color: '#5d6b63', fontWeight: 600, marginBottom: 4 }}>Inbound replies</div>
          <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 10 }}>
            Connect once and the app keeps the RingCentral webhook subscription alive automatically — no manual setup in the developer portal.
          </div>
          {smsWebhookUrl && (
            <div style={{ background: '#f7f9f7', border: '1px solid #e6eae6', borderRadius: 9, padding: '9px 12px', marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: '#9aa69e', fontWeight: 600, marginBottom: 2 }}>Webhook URL</div>
              <div style={{ fontFamily: MONO, fontSize: 11.5, color: '#1f7a4d', wordBreak: 'break-all' }}>{smsWebhookUrl}</div>
            </div>
          )}
          {smsSub.list.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#22b06b', flex: 'none' }} />
              <div style={{ fontSize: 12.5, color: '#5d6b63' }}>
                {smsSub.list.length} active subscription{smsSub.list.length === 1 ? '' : 's'}
                {smsSub.list[0]?.expirationTime ? ` — renews before ${new Date(smsSub.list[0].expirationTime).toLocaleDateString()}` : ''}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: '#9aa69e', marginBottom: 10 }}>{smsSub.loading ? 'Checking…' : 'Not connected yet.'}</div>
          )}
          <button type="button" onClick={connectInbound} disabled={smsSub.busy} style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: smsSub.busy ? 0.6 : 1 }}>{smsSub.busy ? 'Connecting…' : smsSub.list.length ? 'Reconnect / refresh' : 'Connect inbound replies'}</button>
        </div>

        <div style={{ borderTop: '1px solid #f0f2ef', marginTop: 18, paddingTop: 16 }}>
          <div style={{ fontSize: 12.5, color: '#5d6b63', fontWeight: 600, marginBottom: 8 }}>Send a test text</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}><input value={smsTestTo} onChange={(e) => setSmsTestTo(e.target.value)} style={inp} placeholder="(555) 123-4567" /></div>
            <button type="button" onClick={testSms} disabled={smsTesting} style={{ flex: 'none', background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: smsTesting ? 0.6 : 1 }}>{smsTesting ? 'Sending…' : 'Send test'}</button>
          </div>
        </div>
      </div>

      {/* message templates */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Message templates</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 14 }}>
          The text customers receive for each event. Use placeholders: <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{'{customerName} {serviceType} {address} {companyName} {invoiceNumber} {total} {payLink}'}</span>
        </div>
        {tplMsg && (
          <div style={{ background: tplMsg.type === 'ok' ? '#eef7f1' : '#fdecea', border: '1px solid ' + (tplMsg.type === 'ok' ? '#cfe7da' : '#f3b7b0'), color: tplMsg.type === 'ok' ? '#1f7a4d' : '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 14 }}>{tplMsg.text}</div>
        )}
        <SField label="Company name (for {companyName})"><input value={tpl.company_name} onChange={(e) => setTpl((t) => ({ ...t, company_name: e.target.value }))} style={inp} placeholder="Valet Waste FL" /></SField>
        <TplField label="Invoice text" value={tpl.sms_invoice_template} onChange={(v) => setTpl((t) => ({ ...t, sms_invoice_template: v }))} />
        <TplField label="Check-in (tech arriving)" value={tpl.sms_checkin_template} onChange={(v) => setTpl((t) => ({ ...t, sms_checkin_template: v }))} />
        <TplField label="Check-out (service complete)" value={tpl.sms_checkout_template} onChange={(v) => setTpl((t) => ({ ...t, sms_checkout_template: v }))} />
        <TplField label="Service reminder" value={tpl.sms_reminder_template} onChange={(v) => setTpl((t) => ({ ...t, sms_reminder_template: v }))} />
        <button type="button" onClick={saveTemplates} disabled={tplSaving} style={{ marginTop: 4, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: tplSaving ? 0.6 : 1 }}>{tplSaving ? 'Saving…' : 'Save templates'}</button>
      </div>

      {/* tags */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '20px 22px' }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Tags</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 16 }}>
          Manage the shared tag list. Renaming or recoloring a tag updates it on every client that uses it.
        </div>

        {err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginBottom: 14 }}>{err}</div>}

        {/* add new */}
        <form onSubmit={addTag} style={{ display: 'flex', gap: 8, marginBottom: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <button type="button" onClick={() => setPaletteFor(paletteFor === 'new' ? null : 'new')} title="Pick color" style={{ width: 34, height: 38, borderRadius: 9, border: '1px solid #dde2dd', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ width: 16, height: 16, borderRadius: '50%', background: newColor }} />
            </button>
            {paletteFor === 'new' && <Palette onPick={(c) => { setNewColor(c); setPaletteFor(null) }} />}
          </div>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New tag name…" style={{ ...inp, flex: 1, minWidth: 180 }} />
          <button type="submit" disabled={!newName.trim()} style={{ flex: 'none', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: newName.trim() ? 1 : 0.6 }}>Add tag</button>
        </form>

        {loading && <div style={{ color: '#9aa69e', fontSize: 13 }}>Loading…</div>}
        {!loading && !tags.length && <div style={{ color: '#9aa69e', fontSize: 13 }}>No tags yet. Create one above.</div>}

        {tags.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 4px', borderTop: '1px solid #f0f2ef' }}>
            <div style={{ position: 'relative', flex: 'none' }}>
              <button onClick={() => setPaletteFor(paletteFor === t.id ? null : t.id)} title="Change color" style={{ width: 26, height: 26, borderRadius: '50%', background: t.color, border: '2px solid #fff', boxShadow: '0 0 0 1px #dde2dd', cursor: 'pointer' }} />
              {paletteFor === t.id && <Palette onPick={(c) => recolor(t.id, c)} />}
            </div>
            <input
              value={t.name}
              onChange={(e) => setTags((ts) => ts.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))}
              onBlur={() => rename(t.id, t.name)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              style={{ flex: 1, minWidth: 0, border: '1px solid transparent', borderRadius: 7, padding: '7px 9px', fontSize: 14, outline: 'none', background: '#f7f9f7' }}
            />
            {!isMobile && <div style={{ flex: 'none', fontFamily: MONO, fontSize: 11, color: '#9aa69e', width: 70, textAlign: 'right' }}>{counts[t.id] || 0} client{(counts[t.id] || 0) === 1 ? '' : 's'}</div>}
            <button onClick={() => remove(t.id)} style={{ flex: 'none', background: confirmId === t.id ? '#c0492f' : '#fff', color: confirmId === t.id ? '#fff' : '#c0492f', border: '1px solid #f0c9c2', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {confirmId === t.id ? 'Confirm' : 'Delete'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function Palette({ onPick }) {
  return (
    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 60, background: '#fff', border: '1px solid #e3e6e2', borderRadius: 10, padding: 8, display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 7, boxShadow: '0 10px 26px rgba(0,0,0,.16)' }}>
      {TAG_COLORS.map((c) => (
        <button key={c} onClick={() => onPick(c)} title={c} style={{ width: 24, height: 24, borderRadius: '50%', background: c, border: '2px solid #fff', boxShadow: '0 0 0 1px #dde2dd', cursor: 'pointer' }} />
      ))}
    </div>
  )
}

function TplField({ label, value, onChange }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, color: '#5d6b63', marginBottom: 5, fontWeight: 500 }}>{label}</div>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '10px 12px', fontSize: 13.5, outline: 'none', boxSizing: 'border-box', minHeight: 62, resize: 'vertical', lineHeight: 1.4 }} />
    </label>
  )
}

function SField({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 11 }}>
      <div style={{ fontSize: 11.5, color: '#5d6b63', marginBottom: 5, fontWeight: 500 }}>{label}</div>
      {children}
    </label>
  )
}

const inp = { width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '10px 12px', fontSize: 15, outline: 'none', boxSizing: 'border-box' }
