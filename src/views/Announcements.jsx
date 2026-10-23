// Announcements: send one message to a filtered audience of customers by
// text and/or email. The audience builder previews exactly who will get it
// (and who can't), the send confirms the RingCentral cost in text messages
// (segments) before anything goes out, and past blasts are listed below.
import { useEffect, useMemo, useRef, useState } from 'react'
import { MONO } from '../data.js'
import { loadCustomers } from '../lib/customersData.js'
import { listTags } from '../lib/tagsData.js'
import { getSmsConfig } from '../lib/smsData.js'
import { currentActorName } from '../lib/activityData.js'
import {
  AUDIENCE_OPTIONS, EMPTY_FILTERS, audienceLabel, buildRecipients,
  estimateSmsUsage, firstNameOf, groupFailures, loadAnnouncementActivity,
  loadAnnouncements, loadAnnouncementFailures, monthToDateTexts,
  renderAnnouncement, sendAnnouncement,
} from '../lib/announcementsData.js'

const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 14, marginBottom: 16, overflow: 'hidden' }
const inp = { background: '#fff', border: '1px solid #d9e2dc', borderRadius: 9, padding: '8px 11px', fontSize: 13, color: '#1a2420', outline: 'none' }
const label = { fontFamily: MONO, fontSize: 9.5, letterSpacing: '.14em', color: '#7c8a82', marginBottom: 6 }
const CHANNELS = [['sms', '💬 Text'], ['email', '✉ Email'], ['both', 'Both']]

const CHANNEL_LABEL = { sms: 'Text', email: 'Email', both: 'Text + Email' }
const fmtTime = (v) => new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function Announcements({ app }) {
  const [customers, setCustomers] = useState(null)
  const [tags, setTags] = useState([])
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS })
  const [channel, setChannel] = useState('sms')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [showList, setShowList] = useState(false)
  const [sms, setSms] = useState(null) // { sms_enabled, sms_paused, sms_from_number }
  const [mtdTexts, setMtdTexts] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(null) // { done, total }
  const [result, setResult] = useState(null) // totals or { error }
  const [why, setWhy] = useState(null) // { ann, rows: [] | null, err? } — failure reasons for a history row
  const [history, setHistory] = useState(null) // rows + source note
  const [err, setErr] = useState('')
  const bodyRef = useRef(null)

  useEffect(() => {
    loadCustomers().then(setCustomers).catch((e) => setErr(e.message || String(e)))
    listTags().then(setTags).catch(() => {})
    getSmsConfig().then(setSms).catch(() => setSms({}))
    monthToDateTexts().then(setMtdTexts).catch(() => setMtdTexts(null))
  }, [])

  async function refreshHistory() {
    try {
      const rows = await loadAnnouncements()
      setHistory({ rows, note: '' })
    } catch (_e) {
      // Table not there yet (migration 0067 not applied) — activity recaps.
      try {
        const rows = await loadAnnouncementActivity()
        setHistory({ rows, note: 'Full history lands here once migration 0067 (announcements table) is applied; for now this list comes from the activity feed.' })
      } catch (e2) {
        setHistory({ rows: [], note: e2.message || String(e2) })
      }
    }
  }
  useEffect(() => { refreshHistory() }, [])

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }))
  const { rows: recipients, counts } = useMemo(
    () => buildRecipients(customers || [], filters, app.activeLine),
    [customers, filters, app.activeLine],
  )
  const labelText = useMemo(() => audienceLabel(filters, tags), [filters, tags])

  const wantSms = channel !== 'email'
  const wantEmail = channel !== 'sms'
  const smsUsage = useMemo(
    () => estimateSmsUsage(body, recipients),
    [body, recipients],
  )
  // Per-recipient max body length guard: one text cannot exceed 10 segments
  // (RingCentral hard limit is 1600 GSM chars); block rather than truncate.
  const tooLong = smsUsage.maxSegments > 10

  const reachable = recipients.filter((r) => (wantSms && r.phone && !r.optedOutOfTexts) || (wantEmail && r.email)).length
  const smsReady = !wantSms || (!!sms && sms.sms_enabled)
  const canSend = !!body.trim() && reachable > 0 && smsReady && !tooLong && !sending

  const samplePreview = recipients.length
    ? renderAnnouncement(body, { firstName: firstNameOf(recipients[0].name), name: recipients[0].name })
    : body

  async function doSend() {
    setConfirming(false)
    setSending({ done: 0, total: reachable })
    setResult(null)
    setErr('')
    try {
      const actor = await currentActorName()
      const totals = await sendAnnouncement({
        channel, subject: subject.trim(), body: body.trim(),
        recipients, label: labelText, filters, actorName: actor || 'Staff',
        onProgress: (p) => setSending({ ...p }),
      })
      setResult(totals)
      refreshHistory()
    } catch (e) {
      let msg = e.message || String(e)
      if (/failed to fetch|not found|404/i.test(msg)) msg += ' — the announcements edge function may not be deployed yet.'
      setResult({ error: msg })
    } finally {
      setSending(null)
    }
  }

  // Re-text only the people a blast failed to reach (deduped by number) —
  // everyone it reached the first time is left alone.
  async function retryFailed(failures, label, announcement) {
    const seen = new Set()
    const recipients = []
    for (const f of failures) {
      if (f.channel !== 'sms' || !f.target) continue
      const key = String(f.target).replace(/\D/g, '').slice(-10)
      if (!key || seen.has(key)) continue
      seen.add(key)
      recipients.push({ id: f.customerId || null, name: f.name || f.target, phone: f.target, email: '', optedOutOfTexts: false })
    }
    if (!recipients.length) { setResult({ error: 'No failed text recipients found to retry.' }); return }
    setSending({ done: 0, total: recipients.length })
    setResult(null)
    try {
      const actor = await currentActorName()
      const totals = await sendAnnouncement({
        channel: 'sms',
        subject: (announcement && announcement.subject) || subject.trim(),
        body: (announcement && announcement.body) || body.trim(),
        recipients,
        label: `${label} — retry of ${recipients.length} failed text${recipients.length === 1 ? '' : 's'}`,
        filters: { retryOf: announcement?.id || null },
        actorName: actor || 'Staff',
        onProgress: (p) => setSending({ ...p }),
      })
      setResult(totals)
      refreshHistory()
    } catch (e) {
      setResult({ error: e.message || String(e) })
    } finally {
      setSending(null)
    }
  }

  // "why?" on a history row: pull the failed receipts from around that blast.
  async function toggleWhy(h) {
    if (why && why.ann.id === h.id) { setWhy(null); return }
    setWhy({ ann: h, rows: null })
    try {
      const rows = await loadAnnouncementFailures(h)
      setWhy({ ann: h, rows })
    } catch (e) {
      setWhy({ ann: h, rows: [], err: e.message || String(e) })
    }
  }

  function insertToken(tok) {
    const el = bodyRef.current
    if (!el) { setBody((b) => b + tok); return }
    const s = el.selectionStart ?? body.length
    const e = el.selectionEnd ?? body.length
    const next = body.slice(0, s) + tok + body.slice(e)
    setBody(next)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + tok.length, s + tok.length) })
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#1a2420' }}>Announcements</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82' }}>Message every client matching a filter set — by text or email.</div>
      </div>

      {err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      {/* AUDIENCE */}
      <div style={{ ...card, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Send to</div>
          <div style={{ fontSize: 12.5, color: '#7c8a82' }}>{labelText}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: tags.length ? 12 : 0 }}>
          <div>
            <div style={label}>BUSINESS LINE</div>
            <select value={filters.line} onChange={(e) => set({ line: e.target.value })} style={{ ...inp, width: '100%', cursor: 'pointer' }}>
              <option value="">{app.activeLineObj?.name || 'Current line'}</option>
              <option value="all">All business lines</option>
            </select>
          </div>
          <div>
            <div style={label}>CUSTOMERS</div>
            <select value={filters.status} onChange={(e) => set({ status: e.target.value })} style={{ ...inp, width: '100%', cursor: 'pointer' }}>
              {AUDIENCE_OPTIONS.status.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <div style={label}>BILLING</div>
            <select value={filters.billing} onChange={(e) => set({ billing: e.target.value })} style={{ ...inp, width: '100%', cursor: 'pointer' }}>
              {AUDIENCE_OPTIONS.billing.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <div style={label}>CARD ON FILE</div>
            <select value={filters.card} onChange={(e) => set({ card: e.target.value })} style={{ ...inp, width: '100%', cursor: 'pointer' }}>
              {AUDIENCE_OPTIONS.card.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        {tags.length > 0 && (
          <div>
            <div style={label}>TAGS (MATCH ANY)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {tags.map((t) => {
                const on = filters.tags.includes(t.id)
                return (
                  <button key={t.id} onClick={() => set({ tags: on ? filters.tags.filter((x) => x !== t.id) : [...filters.tags, t.id] })}
                    style={{ border: `1px solid ${on ? (t.color || '#1f7a4d') : '#d9e2dc'}`, background: on ? (t.color || '#1f7a4d') : '#fff', color: on ? '#fff' : '#5d6b63', borderRadius: 20, padding: '5px 12px', fontSize: 12, fontWeight: on ? 700 : 500, cursor: 'pointer' }}>
                    {t.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* live recipient summary */}
        <div style={{ marginTop: 14, background: '#f6f8f6', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: '#3d4a43' }}>
          {customers === null ? 'Counting…' : (
            <>
              <strong style={{ fontSize: 14 }}>{counts.total}</strong> customers match
              {' · '}<strong>{counts.textable}</strong> can be texted
              {' · '}<strong>{counts.emailable}</strong> can be emailed
              {counts.optedOut > 0 && <span style={{ color: '#6b5a8a' }}> · {counts.optedOut} opted out of texts</span>}
              {counts.noContact > 0 && <span style={{ color: '#b07a1e' }}> · {counts.noContact} have no phone or email</span>}
              {(counts.dupeTexts > 0 || counts.dupeEmails > 0) && (
                <span style={{ color: '#7c8a82' }}> · {counts.dupeTexts + counts.dupeEmails} shared number/email deduped</span>
              )}
            </>
          )}
          <button onClick={() => setShowList((v) => !v)} style={{ border: 'none', background: 'none', color: '#1f7a4d', fontSize: 12, fontWeight: 700, cursor: 'pointer', padding: '0 0 0 8px' }}>
            {showList ? 'Hide list' : 'Show list'}
          </button>
        </div>
        {showList && (
          <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 8, border: '1px solid #eef1ee', borderRadius: 10 }}>
            {recipients.length === 0 && <div style={{ padding: 18, textAlign: 'center', color: '#9aa69e', fontSize: 12.5 }}>No customers match these filters.</div>}
            {recipients.map((r, i) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: i === recipients.length - 1 ? 'none' : '1px solid #f2f4f2', fontSize: 12.5 }}>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{r.name || '(no name)'}</div>
                <div style={{ color: '#5d6b63', width: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.phone || '—'}</div>
                <div style={{ color: '#5d6b63', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email || '—'}</div>
                {r.optedOutOfTexts && <span style={{ flex: 'none', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, color: '#6b5a8a', background: '#efeaf7' }}>no texts</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MESSAGE */}
      <div style={{ ...card, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Message</div>
          <div style={{ display: 'flex', background: '#eef1ee', borderRadius: 10, padding: 3, gap: 2, marginLeft: 'auto' }}>
            {CHANNELS.map(([v, l]) => (
              <button key={v} onClick={() => setChannel(v)} style={{ border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: channel === v ? 700 : 500, cursor: 'pointer', background: channel === v ? '#1f7a4d' : 'transparent', color: channel === v ? '#fff' : '#5d6b63' }}>{l}</button>
            ))}
          </div>
        </div>

        {wantEmail && (
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Email subject" style={{ ...inp, width: '100%', fontWeight: 600, marginBottom: 10 }} />
        )}
        <textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} rows={wantEmail ? 7 : 5}
          placeholder={wantSms ? 'e.g. Hi {firstName}, quick note from Valet Waste…' : 'Write the announcement…'}
          style={{ ...inp, width: '100%', resize: 'vertical', lineHeight: 1.55, fontFamily: 'inherit' }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 12, color: '#7c8a82' }}>
          {wantSms && (
            <span style={{ fontFamily: MONO, fontSize: 11 }}>
              {samplePreview.length} chars{smsUsage.messages > 0 ? ` · ${smsUsage.maxSegments || 1} segment${smsUsage.maxSegments === 1 ? '' : 's'} each` : ''}
              {smsUsage.maxSegments > 1 && smsUsage.messages > 0 ? ` (emoji/special characters split texts into more segments)` : ''}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {['{firstName}', '{name}'].map((t) => (
              <button key={t} onClick={() => insertToken(t)} style={{ border: '1px solid #d9e2dc', background: '#f7f9f7', borderRadius: 7, padding: '3px 8px', fontFamily: MONO, fontSize: 11, color: '#1f7a4d', cursor: 'pointer' }}>{t}</button>
            ))}
          </span>
        </div>
        {wantSms && tooLong && (
          <div style={{ marginTop: 10, background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 9, padding: '8px 12px', fontSize: 12.5 }}>
            This message is over the 10-segment text limit — shorten it (or send it by email instead).
          </div>
        )}
      </div>

      {/* TEXT-COST WARNING */}
      {wantSms && smsUsage.messages > 0 && (
        <div style={{ background: '#fbf3df', border: '1px solid #ecd9a8', borderRadius: 12, padding: '12px 14px', marginBottom: 16, fontSize: 13, color: '#6b5518', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, marginBottom: 3 }}>⚠ This send uses your RingCentral texting allowance</div>
          <div>
            Sending to <strong>{smsUsage.messages} numbers</strong>
              {smsUsage.maxSegments > 1 ? <> at <strong>{smsUsage.maxSegments} segments each</strong> — about <strong>{smsUsage.totalSegments} text messages</strong> (RingCentral counts each segment as one text)</> : <> — about <strong>{smsUsage.totalSegments} text message{smsUsage.totalSegments === 1 ? '' : 's'}</strong></>}
            {sms && sms.sms_from_number ? <> from {sms.sms_from_number}</> : null}.
            {mtdTexts != null && <> You've sent <strong>{mtdTexts.toLocaleString()}</strong> {mtdTexts === 1 ? 'text' : 'texts'} this month.</>}
          </div>
          {sms && sms.sms_paused && (
            <div style={{ marginTop: 6, fontWeight: 600, color: '#9a2c1e' }}>Texting is currently PAUSED in Settings — texts will be logged but not delivered.</div>
          )}
          {counts.optedOut > 0 && <div style={{ marginTop: 4, color: '#6b5a8a' }}>{counts.optedOut} opted-out client{counts.optedOut === 1 ? '' : 's'} will be skipped for texts.</div>}
        </div>
      )}
      {wantSms && sms && !sms.sms_enabled && (
        <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 12, padding: '12px 14px', marginBottom: 16, fontSize: 13 }}>
          Texting isn't enabled — turn it on in Settings → SMS before sending texts.
        </div>
      )}

      {/* SEND */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={() => setConfirming(true)} disabled={!canSend}
          style={{ background: canSend ? '#1f7a4d' : '#c7d2cb', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 13.5, fontWeight: 700, cursor: canSend ? 'pointer' : 'default' }}>
          {sending ? `Sending… ${sending.done}/${sending.total}` : `Send ${CHANNEL_LABEL[channel]} to ${reachable || 0} ${reachable === 1 ? 'customer' : 'customers'}`}
        </button>
        {!sending && result && !result.error && (
          <div style={{ fontSize: 12.5, color: '#1f7a4d', fontWeight: 600 }}>
            ✓ Sent {[result.sentSms, result.sentEmail].filter(Boolean).length ? `${result.sentSms || 0} text${result.sentSms === 1 ? '' : 's'}${result.sentSms && result.sentEmail ? ' + ' : ''}${result.sentEmail || 0} email${result.sentEmail === 1 ? '' : 's'}` : 'nothing'}
            {(result.failedSms || result.failedEmail) ? ` · ${result.failedSms + result.failedEmail} failed` : ''}
            {result.skippedOptOut ? ` · ${result.skippedOptOut} opted out` : ''}
          </div>
        )}
        {!sending && result && !result.error && (result.warnings || []).length > 0 && (
          <div style={{ flexBasis: '100%', background: '#fbf3df', border: '1px solid #ecd9a8', color: '#6b5518', borderRadius: 9, padding: '8px 12px', fontSize: 12.5 }}>
            {result.warnings.join(' · ')}
          </div>
        )}
        {!sending && result && !result.error && (result.failures || []).length > 0 && (
          <FailurePanel
            failures={result.failures}
            onRetry={() => retryFailed(result.failures, labelText)}
            retryBusy={!!sending}
          />
        )}
      </div>
      {sending && (
        <div style={{ height: 6, background: '#e6eae6', borderRadius: 4, marginBottom: 16, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${sending.total ? Math.round((sending.done / sending.total) * 100) : 0}%`, background: '#1f7a4d', transition: 'width .3s' }} />
        </div>
      )}
      {result && result.error && (
        <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, marginBottom: 16 }}>{result.error}</div>
      )}

      {/* HISTORY */}
      <div style={card}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #eef1ee', display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Past announcements</div>
          <div style={{ fontSize: 12, color: '#9aa69e' }}>per-message receipts live in Comms</div>
        </div>
        {history === null ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading…</div>
        ) : history.rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Nothing sent yet{history.note ? ` — ${history.note}` : ''}</div>
        ) : (
          <>
            {history.rows.map((h, i) => {
              const failed = (h.counts?.failedSms || 0) + (h.counts?.failedEmail || 0)
              return (
                <div key={h.id} style={{ borderBottom: i === history.rows.length - 1 ? 'none' : '1px solid #f2f4f2' }}>
                  <div style={{ display: 'flex', gap: 12, padding: '11px 16px' }}>
                    <div style={{ width: 30, height: 30, borderRadius: 9, background: h.channel === 'email' ? '#e8f0fa' : '#e7f4ed', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flex: 'none' }}>
                      {h.channel === 'email' ? '✉' : h.channel === 'both' ? '💬✉' : '💬'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {h.subject || (h.body || '').split('\n')[0] || '(announcement)'}
                      </div>
                      <div style={{ fontSize: 11.5, color: '#7c8a82', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {h.audienceLabel}{h.sentByName ? ` · by ${h.sentByName}` : ''}
                      </div>
                    </div>
                    <div style={{ flex: 'none', textAlign: 'right', fontSize: 11.5, color: '#9aa69e', lineHeight: 1.5 }}>
                      <div>{countsText(h.counts)}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', marginTop: 2 }}>
                        {fmtTime(h.createdAt)}
                        {failed > 0 && (
                          <button onClick={() => toggleWhy(h)} style={{ border: 'none', background: 'none', color: '#c0492f', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                            why?
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  {why && why.ann.id === h.id && (
                    <div style={{ padding: '0 16px 12px' }}>
                      {why.rows === null ? (
                        <div style={{ fontSize: 12.5, color: '#9aa69e' }}>Loading failure reasons…</div>
                      ) : why.err ? (
                        <div style={{ fontSize: 12.5, color: '#c0492f' }}>{why.err}</div>
                      ) : why.rows.length === 0 ? (
                        <div style={{ fontSize: 12.5, color: '#9aa69e' }}>No failed receipts found near this announcement.</div>
                      ) : (
                        <FailurePanel
                          failures={why.rows}
                          onRetry={() => retryFailed(why.rows, h.audienceLabel, h)}
                          retryBusy={!!sending}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {history.note && <div style={{ padding: '8px 16px 12px', fontSize: 11, color: '#9aa69e' }}>{history.note}</div>}
          </>
        )}
      </div>

      {/* CONFIRM MODAL */}
      {confirming && (
        <div onClick={() => setConfirming(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,25,20,.45)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 480, maxWidth: '100%', padding: 20 }}>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 10 }}>Send this announcement?</div>
            <div style={{ fontSize: 13, color: '#3d4a43', lineHeight: 1.65 }}>
              <div><strong>{CHANNEL_LABEL[channel]}</strong> to <strong>{reachable} {reachable === 1 ? 'customer' : 'customers'}</strong> — {labelText}.</div>
              {wantSms && smsUsage.messages > 0 && (
                <div style={{ marginTop: 8, background: '#fbf3df', border: '1px solid #ecd9a8', borderRadius: 9, padding: '8px 11px', color: '#6b5518' }}>
                  Uses about <strong>{smsUsage.totalSegments} RingCentral text {smsUsage.totalSegments === 1 ? 'message' : 'messages'}</strong>
                  {smsUsage.maxSegments > 1 ? ` (${smsUsage.messages} × ${smsUsage.maxSegments} segments)` : ''} — these count against your plan's texting allowance.
                </div>
              )}
              {wantSms && counts.optedOut > 0 && <div style={{ marginTop: 6, color: '#6b5a8a' }}>{counts.optedOut} opted-out clients will be skipped for texts.</div>}
              <div style={{ marginTop: 10, background: '#f6f8f6', borderRadius: 9, padding: '9px 11px', fontSize: 12.5, color: '#5d6b63', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
                {subject.trim() ? <><strong>{subject.trim()}</strong>{'\n\n'}</> : ''}{samplePreview}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setConfirming(false)} style={{ ...inp, cursor: 'pointer', flex: 1, fontWeight: 600 }}>Cancel</button>
              <button onClick={doSend} style={{ flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 13px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                Send now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function countsText(counts = {}) {
  const parts = []
  if (counts.sentSms) parts.push(`${counts.sentSms} text${counts.sentSms === 1 ? '' : 's'}`)
  if (counts.sentEmail) parts.push(`${counts.sentEmail} email${counts.sentEmail === 1 ? '' : 's'}`)
  if (counts.failedSms) parts.push(`${counts.failedSms} text failed`)
  if (counts.failedEmail) parts.push(`${counts.failedEmail} email failed`)
  if (counts.skippedOptOut) parts.push(`${counts.skippedOptOut} opted out`)
  return parts.join(' · ') || ''
}

// "Why did N fail?" — failed receipts grouped by humanized reason, with a
// one-click re-send to just the failed text recipients.
function FailurePanel({ failures, onRetry, retryBusy }) {
  const groups = groupFailures(failures)
  const smsCount = failures.filter((f) => f.channel === 'sms').length
  return (
    <div style={{ flexBasis: '100%', background: '#fdecea', border: '1px solid #f3b7b0', borderRadius: 11, padding: '12px 14px', fontSize: 12.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
        <strong style={{ color: '#9a2c1e', fontSize: 13 }}>Why {failures.length} failed</strong>
        {smsCount > 0 && onRetry && (
          <button
            onClick={onRetry}
            disabled={retryBusy}
            title="Text only the people this blast failed to reach — everyone already texted is left alone"
            style={{ marginLeft: 'auto', background: '#fff', border: '1px solid #f3b7b0', color: '#c0492f', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 700, cursor: retryBusy ? 'default' : 'pointer', opacity: retryBusy ? 0.6 : 1 }}
          >{retryBusy ? 'Retrying…' : `↻ Retry ${smsCount} failed text${smsCount === 1 ? '' : 's'}`}</button>
        )}
      </div>
      {groups.map((g) => (
        <div key={g.reason} style={{ marginBottom: 8 }}>
          <div style={{ color: '#9a2c1e' }}><strong>{g.count}</strong> · {g.reason}</div>
          {g.who.length > 0 && (
            <div style={{ fontSize: 11.5, color: '#7c8a82', marginTop: 2, lineHeight: 1.5 }}>
              {g.who.join(', ')}{g.count > g.who.length ? ` +${g.count - g.who.length} more` : ''}
            </div>
          )}
        </div>
      ))}
      <div style={{ fontSize: 11, color: '#9aa69e', marginTop: 6 }}>Per-message receipts (with the raw provider error) are in the Comms tab.</div>
    </div>
  )
}
