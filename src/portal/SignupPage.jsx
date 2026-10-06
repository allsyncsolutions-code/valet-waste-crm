// Public web signup — the Trashbolt-style agreement page for the marketing
// website (…/?signup=<slug>). No login: contact + address → pickup schedule
// (1 or 2 pickups/week, or On-Demand) → optional card on file (5th-week-free
// pitch, Runner.js tokenization) → review + "Approve" (the button IS the
// e-signature; the edge fn records the timestamp + IP). Pricing comes from
// the web form config (CRM → Web Forms tab). Creates the customer + property
// (flagged needs_review so it lands in the Dashboard "awaiting placement"
// queue) and texts admins.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { loadRunner, tokenizeCard } from '../lib/runnerJs.js'

const GREEN = '#1f7a4d'
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const DAY_LABEL = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' }
const DEFAULT_ON_DEMAND_NOTE = 'Varies by location and date requested — we’ll reach out after you submit.'
const money = (v) => `$${Number(v).toFixed(2)}`

// Service areas gate which pickup days the signup page offers (owner rule,
// 2026-09-30). The edge fn carries the same mapping and validates against it.
const AREA_OPTIONS = [
  { value: 'duval', label: 'Duval County', days: ['tuesday', 'friday'] },
  { value: 'st_johns', label: 'St. Johns County', days: ['monday', 'thursday'] },
  { value: 'palm_coast', label: 'Palm Coast', days: ['monday', 'thursday'] },
  { value: 'flagler', label: 'Flagler County', days: ['monday', 'thursday'] },
]
const areaByValue = (v) => AREA_OPTIONS.find((a) => a.value === v) || null
// Best-effort prefill from the city the customer typed — they can override.
function guessArea(city) {
  const c = String(city || '').toLowerCase()
  if (!c.trim()) return ''
  if (c.includes('jacksonville') || c.includes('atlantic beach') || c.includes('neptune beach') || c.includes('orange park')) return 'duval'
  if (c.includes('palm coast')) return 'palm_coast'
  if (c.includes('st. augustine') || c.includes('st augustine') || c.includes('saint augustine') || c.includes('ponte vedra') || c.includes('st. johns') || c.includes('st johns') || c.includes('elkton') || c.includes('hastings') || c.includes('fruit cove') || c.includes('world golf')) return 'st_johns'
  if (c.includes('flagler') || c.includes('bunnell') || c.includes('beverly beach') || c.includes('marineland')) return 'flagler'
  return ''
}

// ---------------------------------------------------------------------------
// FALLBACK pricing — real pricing lives in each web form's config, edited in
// the CRM's Web Forms tab (public page is /?signup=<slug>). These built-ins
// only render when the form has no line items of its own. No rates yet =
// "Confirmed before your first visit" and no money moves today (a saved card
// is vaulted only, charged later through normal invoicing).
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

export default function SignupPage({ slug } = {}) {
  // ?signup=1 (or bare ?signup) is the default form; ?signup=<slug> renders the
  // matching web_forms row (edited in the CRM's Web Forms tab).
  const formSlug = !slug || slug === '1' ? 'default' : String(slug).slice(0, 60)
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
  const [isPm, setIsPm] = useState(false) // "I'm a property manager" — tags the account
  // Step 2 — service
  const [scheduleType, setScheduleType] = useState('weekly') // 'weekly' | 'on_call'
  const [pickupsPerWeek, setPickupsPerWeek] = useState(1) // 1 | 2
  const [area, setArea] = useState('')
  const [serviceDays, setServiceDays] = useState([])
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
    signupApi({ action: 'signup_config', slug: formSlug })
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
        slug: formSlug,
        first_name: firstName, last_name: lastName, phone, email,
        street, city, state: stateVal, zip,
        billing_same: billingSame,
        billing_street: bStreet, billing_city: bCity, billing_state: bState, billing_zip: bZip,
        ebilling,
        schedule_type: scheduleType,
        pickups_per_week: scheduleType === 'weekly' ? pickupsPerWeek : 0,
        service_days: scheduleType === 'weekly' ? serviceDays : [],
        area: areaObj ? areaObj.value : null,
        start_date: startDate || null, notes,
        property_manager: isPm,
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
  const form = cfg?.form || null
  const intro = form?.intro || 'Residential valet trash signup'
  // Line items / terms come from the web form config when present, else the
  // built-in placeholders (LINE_ITEMS/TOTAL_LABEL/terms below).
  const lineItems = form && form.line_items?.length ? form.line_items : LINE_ITEMS
  const totalLabel = form ? form.total_label : TOTAL_LABEL
  const termsText = form?.terms || 'By tapping Approve you agree to start valet trash service at the address above on the schedule shown, to monthly billing, and — if you saved a card — that it may be charged for service. We’ll text you to confirm your exact start date before your first visit.'
  const pricing = form?.pricing || {}
  const price1 = pricing.one_pickup
  const price2 = pricing.two_pickup
  const onDemandNote = pricing.on_demand_note || DEFAULT_ON_DEMAND_NOTE
  const selectedPrice = scheduleType === 'on_call' ? null : (pickupsPerWeek === 2 ? price2 : price1)
  const areaObj = areaByValue(area)
  const scheduleSummary = scheduleType === 'on_call'
    ? `On-Demand — ${onDemandNote}`
    : `${areaObj ? `${areaObj.label}: ` : ''}${serviceDays.map((d) => DAY_LABEL[d]).join(' + ')} — ${pickupsPerWeek} pickup${pickupsPerWeek > 1 ? 's' : ''}/ week${selectedPrice != null ? `, ${money(selectedPrice)}/wk` : ''}`

  function toggleDay(d) {
    setServiceDays((cur) => {
      if (cur.includes(d)) return cur.filter((x) => x !== d)
      const next = [...cur, d]
      return next.slice(-pickupsPerWeek) // keep at most the picked count
    })
  }

  function pickArea(v) {
    const a = areaByValue(v)
    setArea(v)
    // Two pickups/week in an area with exactly two service days = both days.
    setServiceDays(a && pickupsPerWeek === 2 ? a.days : [])
  }

  function pickSchedule(type, count) {
    setScheduleType(type)
    setPickupsPerWeek(count)
    setServiceDays([])
    setErr('')
  }

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
            <div style={{ fontSize: 12.5, color: '#66766c' }}>{form?.name || intro}</div>
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

  if (cfg && !form) return shell(
    <div style={card}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>This signup form is no longer available</div>
      <div style={{ fontSize: 14, color: '#4c5a51', lineHeight: 1.5 }}>Please call or text us and we'll get you signed up right away.</div>
    </div>
  )

  if (done) return shell(
    <div style={{ ...card, textAlign: 'center', padding: '30px 20px' }}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
      <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>You're approved — welcome aboard!</div>
      <div style={{ fontSize: 14, color: '#4c5a51', lineHeight: 1.6 }}>
        We got your signup for <b>{street}, {city}</b> — <b>{scheduleSummary}</b>.
        We'll text you at <b>{phone}</b> to confirm your {scheduleType === 'on_call' ? 'pickup' : 'start date'} before your first visit.
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
          <div style={{ fontSize: 13, color: '#66766c', margin: '0 0 10px' }}>
            Managing more than one property? <a href="?signup=bulk" style={{ color: GREEN, fontWeight: 700 }}>Upload a list of service addresses instead</a>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginTop: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={isPm} onChange={(e) => setIsPm(e.target.checked)} style={{ width: 17, height: 17 }} />
            I'm a property manager
          </label>
          {isPm && (
            <div style={{ fontSize: 13, color: '#66766c', margin: '6px 0 0', lineHeight: 1.5 }}>
              Managing several properties? You can <a href="?signup=bulk" style={{ color: GREEN, fontWeight: 700 }}>upload the whole list at once</a> instead of signing up one address at a time.
            </div>
          )}
          <div style={{ marginTop: 14 }}>{nextBtn(() => { const e = validContact(); if (e) { setErr(e); return } setErr(''); setArea((a) => a || guessArea(city)); setStep(2) })}</div>
        </div>
      )}

      {step === 2 && (
        <div style={card}>
          {stepTitle('Pickup schedule', 'Weekly valet trash service, or On-Demand when you need us.')}
          <label style={label}>How often?</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
            <button type="button" onClick={() => pickSchedule('weekly', 1)} style={{ padding: '12px 6px', borderRadius: 10, border: '1.5px solid', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', background: scheduleType === 'weekly' && pickupsPerWeek === 1 ? GREEN : '#fff', color: scheduleType === 'weekly' && pickupsPerWeek === 1 ? '#fff' : '#4c5a51', borderColor: scheduleType === 'weekly' && pickupsPerWeek === 1 ? GREEN : '#d5dcd6', lineHeight: 1.3 }}>
              1 pickup / week<br /><span style={{ fontSize: 12, fontWeight: 600, opacity: 0.9 }}>{price1 != null ? `${money(price1)}/wk` : 'weekly'}</span>
            </button>
            <button type="button" onClick={() => pickSchedule('weekly', 2)} style={{ padding: '12px 6px', borderRadius: 10, border: '1.5px solid', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', background: scheduleType === 'weekly' && pickupsPerWeek === 2 ? GREEN : '#fff', color: scheduleType === 'weekly' && pickupsPerWeek === 2 ? '#fff' : '#4c5a51', borderColor: scheduleType === 'weekly' && pickupsPerWeek === 2 ? GREEN : '#d5dcd6', lineHeight: 1.3 }}>
              2 pickups / week<br /><span style={{ fontSize: 12, fontWeight: 600, opacity: 0.9 }}>{price2 != null ? `${money(price2)}/wk` : 'weekly'}</span>
            </button>
            <button type="button" onClick={() => pickSchedule('on_call', 0)} style={{ padding: '12px 6px', borderRadius: 10, border: '1.5px solid', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', background: scheduleType === 'on_call' ? GREEN : '#fff', color: scheduleType === 'on_call' ? '#fff' : '#4c5a51', borderColor: scheduleType === 'on_call' ? GREEN : '#d5dcd6', lineHeight: 1.3 }}>
              On-Demand<br /><span style={{ fontSize: 12, fontWeight: 600, opacity: 0.9 }}>price varies</span>
            </button>
          </div>

          <label style={label}>Service area</label>
          <select
            value={area}
            onChange={(e) => pickArea(e.target.value)}
            style={{ ...inp, marginBottom: 14, padding: '11px 13px' }}
          >
            <option value="">Pick your county / area…</option>
            {AREA_OPTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>

          {scheduleType === 'weekly' && areaObj && (
            <>
              <label style={label}>{pickupsPerWeek === 2 ? `Pick both service days — ${areaObj.label} runs ${areaObj.days.map((d) => DAY_LABEL[d]).join(' and ')}` : `Pick your service day — ${areaObj.label} runs ${areaObj.days.map((d) => DAY_LABEL[d]).join(' or ')}`}</label>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${areaObj.days.length}, 1fr)`, gap: 5, marginBottom: 14, maxWidth: 220 }}>
                {areaObj.days.map((d) => {
                  const on = serviceDays.includes(d)
                  return (
                    <button key={d} type="button" onClick={() => toggleDay(d)} style={{ padding: '10px 0', borderRadius: 9, border: '1.5px solid', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: on ? GREEN : '#fff', color: on ? '#fff' : '#4c5a51', borderColor: on ? GREEN : '#d5dcd6' }}>{DAY_LABEL[d]}</button>
                  )
                })}
              </div>
              <div style={{ marginBottom: 12 }}><label style={label}>Preferred start date (optional)</label><input style={inp} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
            </>
          )}
          {scheduleType === 'on_call' && (
            <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '12px 13px', fontSize: 13.5, color: '#4c5a51', lineHeight: 1.5, marginBottom: 14 }}>
              {onDemandNote}
            </div>
          )}
          <div style={{ marginBottom: 4 }}>
            <label style={label}>Notes for our team</label>
            <textarea style={{ ...inp, minHeight: 84, resize: 'vertical' }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={'Gate code, where the cart lives, pets to know about, carry-out requests…'} />
          </div>
          <div style={{ marginTop: 14 }}>{nextBtn(() => {
            if (scheduleType === 'weekly') {
              if (!areaObj) { setErr('Please pick your service area.'); return }
              if (serviceDays.length !== pickupsPerWeek) {
                setErr(pickupsPerWeek === 2 ? 'Please pick both service days.' : 'Please pick your service day.'); return
              }
            }
            setErr(''); setStep(3)
          })}</div>
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
              <div style={{ fontSize: 11.5, color: '#9aa69e', lineHeight: 1.5 }}>
                Card details are entered in a secure Run Payments form — we never see or store your card number. A 3% card-processing surcharge applies to credit card charges (debit cards are never surcharged).
              </div>
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
            Pickup: <b>{scheduleSummary}</b>{startDate && scheduleType === 'weekly' ? `, starting ${new Date(startDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}<br />
            Payment: {cardChoice === 'card' ? 'Card on file (5th week free)' : 'Billed after first visit'}
            {notes && <><br />Notes: {notes}</>}
          </div>
          <div style={{ borderTop: '1px dashed #d5dcd6', paddingTop: 12, marginBottom: 12 }}>
            {lineItems.map((li, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6, gap: 12 }}>
                <span>{li.description}</span>
                <span style={{ fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap' }}>{li.price != null ? `$${Number(li.price).toFixed(2)}` : 'Confirmed before your first visit'}</span>
              </div>
            ))}
            {totalLabel && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 800, borderTop: '1px solid #e4e9e4', paddingTop: 8, marginTop: 4 }}><span>Total</span><span>{totalLabel}</span></div>}
          </div>
          <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '11px 13px', fontSize: 12.5, color: '#4c5a51', lineHeight: 1.55, marginBottom: 14 }}>
            {termsText}
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
