// Public BULK web signup — the property-manager intake page (…/?signup=bulk).
// A PM downloads the CSV template, fills in every service address (one per
// row), and uploads it here. The page parses + validates the file client-side
// (required fields, state/zip format, schedule vocabulary, in-file duplicates
// via normAddress) and shows an accept/reject preview BEFORE anything is
// submitted — fix the file and re-upload until every row is green.
//
// Flow: contact + billing address → CSV upload + preview → one optional card
// on file for the whole batch (5th-week-free pitch, Runner.js tokenization)
// → review + "Approve" (the button IS the e-signature; the edge fn records
// timestamp + IP on the customer row). The portal edge fn re-validates every
// row, skips addresses that already exist as properties, and creates ONE
// customer + one needs_review property per accepted row — each lands in the
// Dashboard "awaiting placement" queue and admins get a text with the counts.
// Service days are NOT chosen here: the area is guessed from the city (same
// map as SignupPage) and staff confirm days/route at placement.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { loadRunner, tokenizeCard } from '../lib/runnerJs.js'
import { parseCsv, buildRows, MAX_ROWS, MAX_BYTES, SCHED_LABEL } from '../lib/csvImport.js'

const GREEN = '#1f7a4d'
const money = (v) => `$${Number(v).toFixed(2)}`

async function signupApi(body) {
  const { data, error } = await supabase.functions.invoke('portal', { body })
  if (error) {
    let msg = error.message || String(error)
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error } catch (e) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data?.error) { const e = new Error(data.error); if (data.card_declined) e.cardDeclined = true; throw e }
  return data
}

const inp = { width: '100%', padding: '11px 13px', borderRadius: 10, border: '1.5px solid #d5dcd6', fontSize: 16, boxSizing: 'border-box', background: '#fff', color: '#1c2620' }
const label = { display: 'block', fontSize: 12.5, fontWeight: 700, color: '#4c5a51', margin: '0 0 5px' }
const card = { background: '#fff', borderRadius: 14, padding: '18px 16px', boxShadow: '0 1px 4px rgba(20,30,24,.08)', marginBottom: 14 }

export default function BulkSignupPage() {
  const [cfg, setCfg] = useState(null)
  const [cfgErr, setCfgErr] = useState('')
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(null) // { created, results, submitted, cardSaved }

  // Step 1 — contact + billing
  const [name, setName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [bStreet, setBStreet] = useState('')
  const [bCity, setBCity] = useState('')
  const [bState, setBState] = useState('')
  const [bZip, setBZip] = useState('')
  // Step 2 — upload
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState([]) // parsed + validated
  const [uploadErr, setUploadErr] = useState('')
  // Step 3 — payment
  const [cardChoice, setCardChoice] = useState('card') // 'card' | 'skip'
  const [consent, setConsent] = useState(false)
  // Honeypot (bots fill it; must stay empty)
  const [website, setWebsite] = useState('')

  // Runner.js state
  const [runnerReady, setRunnerReady] = useState(false)
  const runnerRef = useRef(null)
  const formRef = useRef(null)
  const [formKey, setFormKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    signupApi({ action: 'signup_config', slug: 'default' })
      .then((c) => { if (!cancelled) setCfg(c) })
      .catch((e) => { if (!cancelled) setCfgErr(e.message || String(e)) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (step !== 3 || cardChoice !== 'card' || !cfg || !formRef.current) return
    let cancelled = false
    loadRunner().then((Runner) => {
      if (cancelled || !formRef.current) return
      const r = new Runner()
      r.init({
        element: '#run-bulk-form',
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

  function resetCardForm() {
    runnerRef.current = null
    setRunnerReady(false)
    setFormKey((k) => k + 1)
  }

  const validRows = rows.filter((r) => !r.problems.length)
  const badRows = rows.filter((r) => r.problems.length)

  function validContact() {
    if (!name.trim()) return 'Please enter your name.'
    if (phone.replace(/\D/g, '').length < 10) return 'Please enter a valid phone number.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Please enter a valid email address.'
    if (!bStreet.trim() || !bCity.trim() || !bState.trim() || !bZip.trim()) return 'Please enter your full billing address.'
    return null
  }

  function onFile(e) {
    const f = e.target.files?.[0]
    setErr(''); setUploadErr('')
    if (!f) return
    if (f.size > MAX_BYTES) { setUploadErr('That file is too large — keep it under 1 MB.'); return }
    if (!/\.csv$/i.test(f.name)) { setUploadErr('Please upload a .csv file (in Excel: File → Save As → CSV).') ; return }
    const reader = new FileReader()
    reader.onload = () => {
      const { rows: parsed, headerError } = buildRows(parseCsv(reader.result))
      if (headerError) { setUploadErr(headerError); setRows([]); setFileName(''); return }
      if (!parsed.length) { setUploadErr('That file has a header but no address rows.'); setRows([]); setFileName(''); return }
      if (parsed.length > MAX_ROWS) { setUploadErr(`That's ${parsed.length} rows — please split it into batches of ${MAX_ROWS} or fewer.`); setRows([]); setFileName(''); return }
      setRows(parsed)
      setFileName(f.name)
    }
    reader.onerror = () => setUploadErr('Could not read that file — please try again.')
    reader.readAsText(f)
    e.target.value = '' // allow re-picking the same file after fixing it
  }

  async function approve() {
    setErr('')
    const contactErr = validContact()
    if (contactErr) { setErr(contactErr); setStep(1); return }
    if (!validRows.length) { setErr('Upload a file with at least one valid address first.'); setStep(2); return }
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
        action: 'public_bulk_signup',
        name, company_name: companyName, phone, email,
        billing_street: bStreet, billing_city: bCity, billing_state: bState, billing_zip: bZip,
        addresses: validRows.map((r) => ({
          street: r.street, unit: r.unit, city: r.city, state: r.state, zip: r.zip,
          schedule: r.schedule, start_date: r.startDate || null,
          notes: r.notes, resident_name: r.residentName, resident_phone: r.residentPhone,
        })),
        card,
        agreed: true,
        website,
      })
      setDone({ created: res.created, results: res.results || [], submitted: validRows.length, cardSaved: !!res.card_saved })
      window.scrollTo(0, 0)
    } catch (e) {
      const msg = e.message || String(e)
      setErr(msg)
      if (/card|verif|declin/i.test(msg) || e.cardDeclined) { resetCardForm(); setStep(3) }
    }
    setBusy(false)
  }

  const company = cfg?.company_name || 'Valet Waste'
  const form = cfg?.form || null
  const intro = 'Bulk signup — upload your address list'
  const termsText = form?.terms || 'By tapping Approve you agree to start valet trash service at every address listed above on the schedules shown, to monthly billing for each address, and — if you saved a card — that it may be charged for service. We’ll text you to confirm service days and start dates before the first visit at each address.'
  const pricing = form?.pricing || {}
  const schedCount = (s) => validRows.filter((r) => r.schedule === s).length
  const estWeekly = (s, p) => (schedCount(s) && p != null ? schedCount(s) * p : null)
  const weekly1 = estWeekly('1x', pricing.one_pickup)
  const weekly2 = estWeekly('2x', pricing.two_pickup)
  const skipped = done ? done.results.filter((r) => r.status !== 'created') : []

  const shell = (inner) => (
    <div style={{ minHeight: '100vh', background: '#f2f5f2', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', color: '#1c2620' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '20px 14px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 2px 18px' }}>
          {cfg?.logo_url ? (
            <img src={cfg.logo_url} alt="logo" style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover', background: '#fff' }} />
          ) : (
            <div style={{ width: 40, height: 40, borderRadius: 10, background: GREEN, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 17 }}>{company.charAt(0)}</div>
          )}
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 800 }}>{company}</div>
            <div style={{ fontSize: 12.5, color: '#66766c' }}>{intro}</div>
          </div>
        </div>
        {inner}
        <div style={{ textAlign: 'center', fontSize: 11.5, color: '#93a298', marginTop: 22 }}>Questions? Call or text us and we'll get you set up.</div>
      </div>
    </div>
  )

  if (cfgErr) return shell(
    <div style={card}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Bulk signup is temporarily unavailable</div>
      <div style={{ fontSize: 14, color: '#4c5a51', lineHeight: 1.5 }}>{cfgErr}</div>
    </div>
  )

  if (cfg && !form) return shell(
    <div style={card}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Signup is no longer available</div>
      <div style={{ fontSize: 14, color: '#4c5a51', lineHeight: 1.5 }}>Please call or text us and we'll get you signed up right away.</div>
    </div>
  )

  if (done) return shell(
    <div style={{ ...card, textAlign: 'center', padding: '30px 20px' }}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
      <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>Your addresses are in!</div>
      <div style={{ fontSize: 14, color: '#4c5a51', lineHeight: 1.6, textAlign: 'left' }}>
        We accepted <b>{done.created}</b> of the <b>{done.submitted}</b> addresses you uploaded — each one is now in our
        setup queue. We'll text <b>{phone}</b> to confirm service days and start dates before the first visit at each address.
        {done.cardSaved
          ? <span><br />Your card is on file — your <b>5th week is free</b>.</span>
          : <span><br />No card on file yet — we'll bill you after service starts.</span>}
      </div>
      {skipped.length > 0 && (
        <div style={{ textAlign: 'left', marginTop: 16 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>{skipped.length} row{skipped.length > 1 ? 's were' : ' was'} not added:</div>
          <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #e4e9e4', borderRadius: 10 }}>
            {skipped.map((s) => (
              <div key={s.i} style={{ padding: '9px 12px', borderTop: '1px solid #eef2ee', fontSize: 13, color: '#4c5a51' }}>
                <b>{s.address || `Row ${s.i + 2}`}</b> — {s.reason}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12.5, color: '#66766c', marginTop: 8, lineHeight: 1.5 }}>
            Already-serviceable addresses were skipped so nothing gets double-booked — existing service continues unchanged.
          </div>
        </div>
      )}
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
  const nextBtn = (fn, labelText = 'Continue', disabled = false) => (
    <button type="button" onClick={fn} disabled={disabled} style={{ width: '100%', padding: '13px', borderRadius: 11, border: 'none', background: GREEN, color: '#fff', fontSize: 16, fontWeight: 800, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>{labelText}</button>
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
          {stepTitle('Your info', 'Who’s the account contact, and where do we send the bill?')}
          <div style={{ marginBottom: 10 }}><label style={label}>Your name</label><input style={inp} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></div>
          <div style={{ marginBottom: 10 }}><label style={label}>Company / property management (optional)</label><input style={inp} value={companyName} onChange={(e) => setCompanyName(e.target.value)} autoComplete="organization" /></div>
          <div style={{ marginBottom: 10 }}><label style={label}>Mobile phone</label><input style={inp} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="(___) ___-____" /></div>
          <div style={{ marginBottom: 10 }}><label style={label}>Email</label><input style={inp} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></div>
          <label style={label}>Billing address</label>
          <div style={{ marginBottom: 10 }}><input style={inp} value={bStreet} onChange={(e) => setBStreet(e.target.value)} autoComplete="street-address" placeholder="Street" /></div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 2 }}><input style={inp} value={bCity} onChange={(e) => setBCity(e.target.value)} autoComplete="address-level2" placeholder="City" /></div>
            <div style={{ flex: 1 }}><input style={inp} value={bState} onChange={(e) => setBState(e.target.value)} autoComplete="address-level1" placeholder="State" maxLength={2} /></div>
            <div style={{ flex: 1.4 }}><input style={inp} value={bZip} onChange={(e) => setBZip(e.target.value)} autoComplete="postal-code" placeholder="Zip" /></div>
          </div>
          <div style={{ marginTop: 14 }}>{nextBtn(() => { const e = validContact(); if (e) { setErr(e); return } setErr(''); setStep(2) })}</div>
          <div style={{ textAlign: 'center', fontSize: 12.5, color: '#66766c', marginTop: 10 }}>Just one address? <a href="?signup=1" style={{ color: GREEN, fontWeight: 700 }}>Use the standard signup</a></div>
        </div>
      )}

      {step === 2 && (
        <div style={card}>
          {stepTitle('Upload addresses', 'One address per row — download the template, fill it in Excel or Google Sheets, and upload the .csv here.')}
          <a href="/bulk-service-addresses-template.csv" download style={{ display: 'block', textAlign: 'center', padding: '12px', borderRadius: 10, border: `1.5px dashed ${GREEN}`, color: GREEN, fontSize: 14, fontWeight: 800, textDecoration: 'none', marginBottom: 12 }}>
            ⬇ Download the CSV template
          </a>
          <label style={{ ...label, fontSize: 13, color: '#66766c', fontWeight: 600 }}>
            Columns: street*, city*, state* (2-letter), zip*, then optional unit, schedule (1x / 2x / on_demand — defaults to 1x), start_date (YYYY-MM-DD), notes, resident_name, resident_phone. One header row + up to {MAX_ROWS} addresses.
          </label>
          <input type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: 'block', fontSize: 14, margin: '4px 0 12px' }} />
          {uploadErr && <div style={{ background: '#fdecea', border: '1px solid #f5c6c0', color: '#a02c22', borderRadius: 10, padding: '10px 13px', fontSize: 13.5, marginBottom: 12, lineHeight: 1.45 }}>{uploadErr}</div>}

          {rows.length > 0 && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <div style={{ flex: 1, background: '#e8f5ec', borderRadius: 10, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: GREEN }}>{validRows.length}</div>
                  <div style={{ fontSize: 12, color: '#4c5a51' }}>ready</div>
                </div>
                <div style={{ flex: 1, background: badRows.length ? '#fdecea' : '#f7f9f7', borderRadius: 10, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: badRows.length ? '#a02c22' : '#93a298' }}>{badRows.length}</div>
                  <div style={{ fontSize: 12, color: '#4c5a51' }}>need{!badRows.length || badRows.length > 1 ? '' : 's'} fix{!badRows.length || badRows.length > 1 ? 'es' : ''}</div>
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: '#66766c', marginBottom: 8 }}>{fileName}</div>

              {badRows.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6, color: '#a02c22' }}>Fix these rows and re-upload the file:</div>
                  <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #f5c6c0', borderRadius: 10 }}>
                    {badRows.map((r) => (
                      <div key={r.i} style={{ padding: '9px 12px', borderTop: '1px solid #fbe3df', fontSize: 13, color: '#4c5a51' }}>
                        <b>Row {r.i + 2}:</b> {r.addr || '(address unreadable)'}
                        <div style={{ color: '#a02c22', marginTop: 2 }}>{r.problems.map((p) => `• ${p}`).join('  ')}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {validRows.length > 0 && (
                <div style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>Ready to submit:</div>
                  <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #e4e9e4', borderRadius: 10 }}>
                    {validRows.slice(0, 50).map((r) => (
                      <div key={r.i} style={{ padding: '9px 12px', borderTop: '1px solid #eef2ee', fontSize: 13, color: '#4c5a51', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <span>{r.addr}</span>
                        <span style={{ whiteSpace: 'nowrap', color: '#66766c' }}>{SCHED_LABEL[r.schedule]}{r.startDate ? ` from ${r.startDate}` : ''}</span>
                      </div>
                    ))}
                    {validRows.length > 50 && <div style={{ padding: '9px 12px', fontSize: 13, color: '#66766c', borderTop: '1px solid #eef2ee' }}>…and {validRows.length - 50} more</div>}
                  </div>
                  {badRows.length === 0 && (
                    <div style={{ background: '#e8f5ec', borderRadius: 10, padding: '10px 13px', fontSize: 13, color: '#1f7a4d', marginTop: 10, lineHeight: 1.5 }}>
                      ✓ Every row checks out — duplicates of addresses already in our system are filtered out when you approve.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 14 }}>{nextBtn(() => { setErr(''); setStep(3) }, 'Continue', !validRows.length)}</div>
          {backBtn}
        </div>
      )}

      {step === 3 && (
        <div style={card}>
          {stepTitle('Payment', `Add a card on file now — one card covers all ${validRows.length} address${validRows.length > 1 ? 'es' : ''}, and your 5th week is free. Or skip and we’ll bill you after service starts.`)}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <button type="button" onClick={() => { setCardChoice('card'); setErr('') }} style={{ flex: 1, padding: '12px 8px', borderRadius: 10, border: '1.5px solid', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', background: cardChoice === 'card' ? GREEN : '#fff', color: cardChoice === 'card' ? '#fff' : '#4c5a51', borderColor: cardChoice === 'card' ? GREEN : '#d5dcd6', lineHeight: 1.3 }}>
              Add card now<br /><span style={{ fontSize: 11.5, fontWeight: 600, opacity: 0.9 }}>5th week free 🎉</span>
            </button>
            <button type="button" onClick={() => { setCardChoice('skip'); setErr('') }} style={{ flex: 1, padding: '12px 8px', borderRadius: 10, border: '1.5px solid', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', background: cardChoice === 'skip' ? GREEN : '#fff', color: cardChoice === 'skip' ? '#fff' : '#4c5a51', borderColor: cardChoice === 'skip' ? GREEN : '#d5dcd6', lineHeight: 1.3 }}>
              Skip for now<br /><span style={{ fontSize: 11.5, fontWeight: 600, opacity: 0.9 }}>Bill me after service starts</span>
            </button>
          </div>
          {cardChoice === 'card' && cfg && (
            <div>
              <div key={formKey} id="run-bulk-form" ref={formRef} style={{ minHeight: 90 }} />
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
              No problem — we’ll bill you after service starts. You can add a card any time from your client portal.
            </div>
          )}
          <div style={{ marginTop: 14 }}>{nextBtn(() => { setErr(''); setStep(4) }, 'Review my signup')}</div>
          {backBtn}
        </div>
      )}

      {step === 4 && (
        <div style={card}>
          {stepTitle('Review & approve', 'Tap Approve to start service at every address below — that tap is your signature.')}
          <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 12 }}>
            <b>{companyName ? `${companyName} — ${name}` : name}</b><br />
            {phone} · {email}<br />
            Billing: {bStreet}, {bCity}, {bState} {bZip}<br />
            <b>{validRows.length}</b> service address{validRows.length > 1 ? 'es' : ''}:
            {schedCount('1x') > 0 && <><br />• {schedCount('1x')} × 1 pickup/week{pricing.one_pickup != null ? ` (${money(pricing.one_pickup)}/wk each)` : ''}</>}
            {schedCount('2x') > 0 && <><br />• {schedCount('2x')} × 2 pickups/week{pricing.two_pickup != null ? ` (${money(pricing.two_pickup)}/wk each)` : ''}</>}
            {schedCount('on_demand') > 0 && <><br />• {schedCount('on_demand')} × On-Demand</>}
            <br />Payment: {cardChoice === 'card' ? 'Card on file (5th week free)' : 'Billed after service starts'}
            {(weekly1 != null || weekly2 != null) && <><br /><span style={{ color: '#66766c', fontSize: 13 }}>Estimated weekly total: {money((weekly1 || 0) + (weekly2 || 0))} — confirmed with you before your first visit.</span></>}
          </div>
          <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #e4e9e4', borderRadius: 10, marginBottom: 12 }}>
            {validRows.map((r) => (
              <div key={r.i} style={{ padding: '7px 12px', borderTop: '1px solid #eef2ee', fontSize: 12.5, color: '#4c5a51' }}>{r.addr}</div>
            ))}
          </div>
          <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '11px 13px', fontSize: 12.5, color: '#4c5a51', lineHeight: 1.55, marginBottom: 14 }}>
            {termsText}
          </div>
          {/* Honeypot — invisible to humans, bots fill it and get silently dropped */}
          <input type="text" value={website} onChange={(e) => setWebsite(e.target.value)} autoComplete="off" tabIndex={-1} aria-hidden="true" style={{ position: 'absolute', left: -9999, opacity: 0, height: 0 }} />
          <button type="button" onClick={approve} disabled={busy} style={{ width: '100%', padding: '14px', borderRadius: 11, border: 'none', background: GREEN, color: '#fff', fontSize: 16.5, fontWeight: 800, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.75 : 1 }}>
            {busy ? 'Approving…' : `✓ Approve & start service at ${validRows.length} address${validRows.length > 1 ? 'es' : ''}`}
          </button>
          {backBtn}
        </div>
      )}
    </div>
  )
}
