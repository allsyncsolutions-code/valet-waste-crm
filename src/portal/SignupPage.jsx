// Public web signup — the Trashbolt-style agreement page for the marketing
// website (…/?signup=1). No login: contact + address → service day/frequency →
// optional card on file (5th-week-free pitch, Runner.js tokenization) →
// review + "Approve" (the button IS the e-signature; the edge fn records the
// timestamp + IP). Creates the customer + property (flagged needs_review so
// it lands in the Dashboard "awaiting placement" queue) and texts admins.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { loadRunner, tokenizeCard } from '../lib/runnerJs.js'

const GREEN = '#1f7a4d'
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const DAY_LABEL = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' }
const FREQS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
]
const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' }

// ---------------------------------------------------------------------------
// PRICING — TODO: the team hasn't set rates yet. When they land, fill in
// price (number) per line and set TOTAL_LABEL; the review step renders them.
// Until then the form shows "confirmed before your first visit" and takes
// no payment today (card on file is vaulted only — charged later by staff).
const LINE_ITEMS = [
  { description: 'Valet trash service', price: null },
]
const TOTAL_LABEL = null // e.g. 'per month'
// ---------------------------------------------------------------------------

async function signupApi(body) {
  const { data, error } = await supabase.functions.invoke('portal', { body })
  if (error) {
    let msg = error.message || String(error)
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error } catch (e) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

const inp = { width: '100%', padding: '11px 13px', borderRadius: 10, border: '1.5px solid #d5dcd6', fontSize: 16, boxSizing: 'border-box', background: '#fff', color: '#1c2620' }
const label = { display: 'block', fontSize: 12.5, fontWeight: 700, color: '#4c5a51', margin: '0 0 5px' }
const card = { background: '#fff', borderRadius: 14, padding: '18px 16px', boxShadow: '0 1px 4px rgba(20,30,24,.08)', marginBottom: 14 }

export default function SignupPage() {
  const [cfg, setCfg] = useState(null)
  const [cfgErr, setCfgErr] = useState('')
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(null) // { cardSaved }

  // Step 1 — contact
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [street, setStreet] = useState('')
  const [city, setCity] = useState('')
  const [stateVal, setStateVal] = useState('')
  const [zip, setZip] = useState('')
  const [billingSame, setBillingSame] = useState(true)
  const [bStreet, setBStreet] = useState('')
  const [bCity, setBCity] = useState('')
  const [bState, setBState] = useState('')
  const [bZip, setBZip] = useState('')
  const [ebilling, setEbilling] = useState(true)
  // Step 2 — service
  const [serviceDay, setServiceDay] = useState('monday')
  const [frequency, setFrequency] = useState('weekly')
  const [startDate, setStartDate] = useState('')
  const [notes, setNotes] = useState('')
  // Step 3 — payment
  const [cardChoice, setCardChoice] = useState('card') // 'card' | 'skip'
  const [consent, setConsent] = useState(false)
  // Honeypot (bots fill it; must stay empty)
  const [company, setCompany] = useState('')

  // Runner.js state
  const [runnerReady, setRunnerReady] = useState(false)
  const [runnerCfg, setRunnerCfg] = useState(null)
  const runnerRef = useRef(null)
  const formRef = useRef(null)
  const [formKey, setFormKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    signupApi({ action: 'signup_config' })
      .then((c) => { if (!cancelled) setCfg(c) })
      .catch((e) => { if (!cancelled) setCfgErr(e.message || String(e)) })
    return () => { cancelled = true }
  }, [])

  // Inject the Runner card form when step 3 shows it.
  useEffect(() => {
    if (step !== 3 || cardChoice !== 'card' || !cfg || !formRef.current) return
    let cancelled = false
    loadRunner().then((Runner) => {
      if (cancelled || !formRef.current) return
      const r = new Runner()
      r.init({
        element: '#run-signup-form',
        publicKey: cfg.publicKey,
        mid: cfg.mid,
        env: cfg.env === 'uat' ? 'staging' : 'production',
        useExpiry: true,
        useCvv: true,
      })
      runnerRef.current = r
      setRunnerReady(true)
    }).catch((e) => setErr(e.message || String(e)))
    return () => { cancelled = true; runnerRef.current = null }
  }, [step, cardChoice, cfg, formKey])

  // Runner's fields are single-use: remount to retry after any tokenize.
  function resetCardForm() {
    runnerRef.current = null
    setRunnerReady(false)
    setFormKey((k) => k + 1)
  }

  function validContact() {
    if (!firstName.trim() || !lastName.trim()) return 'Please enter your first and last name.'
    if (phone.replace(/\D/g, '').length < 10) return 'Please enter a valid phone number.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Please enter a valid email address.'
    if (!street.trim() || !city.trim() || !stateVal.trim() || !zip.trim()) return 'Please enter your full service address.'
    if (!billingSame && (!bStreet.trim() || !bCity.trim() || !bState.trim() || !bZip.trim())) return 'Please enter your full billing address.'
    return null
  }

  async function approve() {
    setErr('')
    const contactErr = validContact()
    if (contactErr) { setErr(contactErr); setStep(1); return }
    setBusy(true)
    try {
      let card = null
      if (cardChoice === 'card') {
        if (!runnerRef.current) throw new Error('The secure card form is still loading — give it a second and try again.')
        if (!consent) throw new Error('Please check the box agreeing to automatic monthly charges first.')
        const t = await tokenizeCard(runnerRef.current)
        if (!t || (!t.account_token && !t.token)) {
          resetCardForm()
          throw new Error("We couldn't read the card details. Please re-enter your card information and try again.")
        }
        card = { account_token: t.account_token || t.token, expiration: t.expiry, cvn: t.cvv, consent: true }
      }
      const res = await signupApi({
        action: 'public_signup',
        first_name: firstName, last_name: lastName, phone, email,
        street, city, state: stateVal, zip,
        billing_same: billingSame,
        billing_street: bStreet, billing_city: bCity, billing_state: bState, billing_zip: bZip,
        ebilling,
        service_day: serviceDay, frequency, start_date: startDate || null, notes,
        card,
        agreed: true,
        company,
      })
      setDone({ cardSaved: !!res.card_saved })
      window.scrollTo(0, 0)
    } catch (e) {
      const msg = e.message || String(e)
      setErr(msg)
      if (/card|verif|declin/i.test(msg)) { resetCardForm(); setStep(3) }
    }
    setBusy(false)
  }

  const companyName = cfg?.company_name || 'Valet Waste'

  const shell = (inner) => (
    <div style={{ minHeight: '100vh', background: '#f2f5f2', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', color: '#1c2620' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '20px 14px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 2px 18px' }}>
          {cfg?.logo_url ? (
            <img src={cfg.logo_url} alt="logo" style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover', background: '#fff' }} />
          ) : (
            <div style={{ width: 40, height: 40, borderRadius: 10, background: GREEN, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 17 }}>{companyName.charAt(0)}</div>
          )}
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 800 }}>{companyName}</div>
            <div style={{ fontSize: 12.5, color: '#66766c' }}>Residential valet trash signup</div>
          </div>
        </div>
        {inner}
        <div style={{ textAlign: 'center', fontSize: 11.5, color: '#93a298', marginTop: 22 }}>Questions? Call or text us and we'll get you set up.</div>
      </div>
    </div>
  )

  if (cfgErr) return shell(
    <div style={card}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Signup is temporarily unavailable</div>
      <div style={{ fontSize: 14, color: '#4c5a51', lineHeight: 1.5 }}>{cfgErr}</div>
    </div>
  )

  if (done) return shell(
    <div style={{ ...card, textAlign: 'center', padding: '30px 20px' }}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
      <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>You're approved — welcome aboard!</div>
      <div style={{ fontSize: 14, color: '#4c5a51', lineHeight: 1.6 }}>
        We got your signup for <b>{street}, {city}</b> — <b>{DAY_LABEL[serviceDay]}days</b>, {FREQ_LABEL[frequency].toLowerCase()}.
        We'll text you at <b>{phone}</b> to confirm your exact start date before your first visit.
        {done.cardSaved
          ? <span><br />Your card is on file — your <b>5th week is free</b>.</span>
          : <span><br />No card on file yet — we'll bill you after your first visit.</span>}
      </div>
    </div>
  )

  const stepsBar = (
    <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
      {[1, 2, 3, 4].map((n) => (
        <div key={n} style={{ flex: 1, height: 5, borderRadius: 3, background: step >= n ? GREEN : '#dde4de' }} />
      ))}
    </div>
  )

  const stepTitle = (t, sub) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 18, fontWeight: 800 }}>{t}</div>
      {sub && <div style={{ fontSize: 13, color: '#66766c', marginTop: 3, lineHeight: 1.45 }}>{sub}</div>}
    </div>
  )

  const nextBtn = (fn, labelText = 'Continue') => (
    <button type="button" onClick={fn} style={{ width: '100%', padding: '13px', borderRadius: 11, border: 'none', background: GREEN, color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>{labelText}</button>
  )
  const backBtn = (
    <button type="button" onClick={() => { setErr(''); setStep(step - 1) }} style={{ background: 'none', border: 'none', color: '#66766c', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', padding: '10px 0 0', width: '100%', textAlign: 'center' }}>← Back</button>
  )

  return shell(
    <div>
      {stepsBar}
      {err && <div style={{ background: '#fdecea', border: '1px solid #f5c6c0', color: '#a02c22', borderRadius: 10, padding: '10px 13px', fontSize: 13.5, marginBottom: 14, lineHeight: 1.45 }}>{err}</div>}

      {step === 1 && (
        <div style={card}>
          {stepTitle('Your info', 'Where do we pick up, and how do we reach you?')}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1 }}><label style={label}>First name</label><input style={inp} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" /></div>
            <div style={{ flex: 1 }}><label style={label}>Last name</label><input style={inp} value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" /></div>
          </div>
          <div style={{ marginBottom: 10 }}><label style={label}>Mobile phone</label><input style={inp} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="(___) ___-____" /></div>
          <div style={{ marginBottom: 10 }}><label style={label}>Email</label><input style={inp} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
          <label style={label}>Service address</label>
          <div style={{ marginBottom: 10 }}><input style={inp} value={street} onChange={(e) => setStreet(e.target.value)} autoComplete="street-address" placeholder="Street" /></div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 2 }}><input style={inp} value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" placeholder="City" /></div>
            <div style={{ flex: 1 }}><input style={inp} value={stateVal} onChange={(e) => setStateVal(e.target.value)} autoComplete="address-level1" placeholder="State" maxLength={2} /></div>
            <div style={{ flex: 1.4 }}><input style={inp} value={zip} onChange={(e) => setZip(e.target.value)} autoComplete="postal-code" placeholder="Zip" /></div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, margin: '4px 0 10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={billingSame} onChange={(e) => setBillingSame(e.target.checked)} style={{ width: 17, height: 17 }} />
            Billing address is the same
          </label>
          {!billingSame && (
            <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '12px 10px', marginBottom: 10 }}>
              <label style={label}>Billing address</label>
              <div style={{ marginBottom: 8 }}><input style={inp} value={bStreet} onChange={(e) => setBStreet(e.target.value)} placeholder="Street" /></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 2 }}><input style={inp} value={bCity} onChange={(e) => setBCity(e.target.value)} placeholder="City" /></div>
                <div style={{ flex: 1 }}><input style={inp} value={bState} onChange={(e) => setBState(e.target.value)} placeholder="State" maxLength={2} /></div>
                <div style={{ flex: 1.4 }}><input style={inp} value={bZip} onChange={(e) => setBZip(e.target.value)} placeholder="Zip" /></div>
              </div>
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={ebilling} onChange={(e) => setEbilling(e.target.checked)} style={{ width: 17, height: 17 }} />
            Email my invoices (e-billing)
          </label>
          <div style={{ marginTop: 14 }}>{nextBtn(() => { const e = validContact(); if (e) { setErr(e); return } setErr(''); setStep(2) })}</div>
        </div>
      )}

      {step === 2 && (
        <div style={card}>
          {stepTitle('Pickup schedule', 'Pick your service day and how often — you can change it later.')}
          <label style={label}>Service day</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 5, marginBottom: 14 }}>
            {DAYS.map((d) => (
              <button key={d} type="button" onClick={() => setServiceDay(d)} style={{ padding: '10px 0', borderRadius: 9, border: '1.5px solid', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: serviceDay === d ? GREEN : '#fff', color: serviceDay === d ? '#fff' : '#4c5a51', borderColor: serviceDay === d ? GREEN : '#d5dcd6' }}>{DAY_LABEL[d]}</button>
            ))}
          </div>
          <label style={label}>Frequency</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {FREQS.map((f) => (
              <button key={f.value} type="button" onClick={() => setFrequency(f.value)} style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: '1.5px solid', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', background: frequency === f.value ? GREEN : '#fff', color: frequency === f.value ? '#fff' : '#4c5a51', borderColor: frequency === f.value ? GREEN : '#d5dcd6' }}>{f.label}</button>
            ))}
          </div>
          <div style={{ marginBottom: 12 }}><label style={label}>Preferred start date (optional)</label><input style={inp} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
          <div style={{ marginBottom: 4 }}>
            <label style={label}>Notes for our team</label>
            <textarea style={{ ...inp, minHeight: 84, resize: 'vertical' }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={'Gate code, where the cart lives, pets to know about, carry-out requests…'} />
          </div>
          <div style={{ marginTop: 14 }}>{nextBtn(() => { setErr(''); setStep(3) })}</div>
          {backBtn}
        </div>
      )}

      {step === 3 && (
        <div style={card}>
          {stepTitle('Payment', 'Add a card on file now and your 5th week is free — or skip and we’ll bill you after your first visit.')}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <button type="button" onClick={() => { setCardChoice('card'); setErr('') }} style={{ flex: 1, padding: '12px 8px', borderRadius: 10, border: '1.5px solid', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', background: cardChoice === 'card' ? GREEN : '#fff', color: cardChoice === 'card' ? '#fff' : '#4c5a51', borderColor: cardChoice === 'card' ? GREEN : '#d5dcd6', lineHeight: 1.3 }}>
              Add card now<br /><span style={{ fontSize: 11.5, fontWeight: 600, opacity: 0.9 }}>5th week free 🎉</span>
            </button>
            <button type="button" onClick={() => { setCardChoice('skip'); setErr('') }} style={{ flex: 1, padding: '12px 8px', borderRadius: 10, border: '1.5px solid', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', background: cardChoice === 'skip' ? GREEN : '#fff', color: cardChoice === 'skip' ? '#fff' : '#4c5a51', borderColor: cardChoice === 'skip' ? GREEN : '#d5dcd6', lineHeight: 1.3 }}>
              Skip for now<br /><span style={{ fontSize: 11.5, fontWeight: 600, opacity: 0.9 }}>Bill me after 1st visit</span>
            </button>
          </div>
          {cardChoice === 'card' && cfg && (
            <div>
              <div key={formKey} id="run-signup-form" ref={formRef} style={{ minHeight: 90 }} />
              {!runnerReady && <div style={{ color: '#9aa69e', fontSize: 12.5, padding: '0 2px 8px' }}>Loading secure card form…</div>}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: '#4c5a51', lineHeight: 1.45, margin: '6px 0 4px', cursor: 'pointer' }}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: 17, height: 17, marginTop: 1, flex: 'none' }} />
                <span>I agree to keep this card on file for automatic monthly charges. My card is vaulted securely and is never charged today — and with a card on file, my 5th week of service is free.</span>
              </label>
            </div>
          )}
          {cardChoice === 'skip' && (
            <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '12px 13px', fontSize: 13.5, color: '#4c5a51', lineHeight: 1.5 }}>
              No problem — we’ll bill you after your first visit. You can add a card any time from your client portal.
            </div>
          )}
          <div style={{ marginTop: 14 }}>{nextBtn(() => { setErr(''); setStep(4) }, 'Review my signup')}</div>
          {backBtn}
        </div>
      )}

      {step === 4 && (
        <div style={card}>
          {stepTitle('Review & approve', 'Tap Approve to start service — that tap is your signature.')}
          <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12 }}>
            <b>{firstName} {lastName}</b><br />
            {phone} · {email}<br />
            Service: {street}, {city}, {stateVal} {zip}<br />
            Pickup: <b>{DAY_LABEL[serviceDay]}days</b>, {FREQ_LABEL[frequency].toLowerCase()}{startDate ? `, starting ${new Date(startDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}<br />
            Payment: {cardChoice === 'card' ? 'Card on file (5th week free)' : 'Billed after first visit'}
            {notes && <><br />Notes: {notes}</>}
          </div>
          <div style={{ borderTop: '1px dashed #d5dcd6', paddingTop: 12, marginBottom: 12 }}>
            {LINE_ITEMS.map((li, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6 }}>
                <span>{li.description}</span>
                <span style={{ fontWeight: 700 }}>{li.price != null ? `$${Number(li.price).toFixed(2)}` : 'Confirmed before your first visit'}</span>
              </div>
            ))}
            {TOTAL_LABEL && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 800, borderTop: '1px solid #e4e9e4', paddingTop: 8, marginTop: 4 }}><span>Total</span><span>{TOTAL_LABEL}</span></div>}
          </div>
          <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '11px 13px', fontSize: 12.5, color: '#4c5a51', lineHeight: 1.55, marginBottom: 14 }}>
            By tapping <b>Approve</b> you agree to start valet trash service at the address above on the schedule shown, to monthly billing, and — if you saved a card — that it may be charged for service. We’ll text you to confirm your exact start date before your first visit.
          </div>
          {/* Honeypot — invisible to humans, bots fill it and get silently dropped */}
          <input type="text" value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="off" tabIndex={-1} aria-hidden="true" style={{ position: 'absolute', left: -9999, opacity: 0, height: 0 }} />
          <button type="button" onClick={approve} disabled={busy} style={{ width: '100%', padding: '14px', borderRadius: 11, border: 'none', background: GREEN, color: '#fff', fontSize: 16.5, fontWeight: 800, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.75: 1 }}>
            {busy ? 'Approving…' : '✓ Approve & start service'}
          </button>
          {backBtn}
        </div>
      )}
    </div>
  )
}
