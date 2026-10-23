// Announcements: bulk text/email blasts to a filtered customer audience.
//
// The audience is computed in the browser (the CRM already has every customer
// loaded), so the preview count and the RingCentral usage estimate are exact
// and instant. Sending goes through the `announcements` edge function in
// chunks: it texts via RingCentral (Telnyx fallback, same rules as the `sms`
// function) and emails via SendGrid, receipting every message into
// sms_messages / email_messages with purpose 'announcement'.
import { supabase } from './supabaseClient.js'
import { logActivity } from './activityData.js'

// --- Audience filters --------------------------------------------------------

// Default filter set — "all customers on the current business line".
export const EMPTY_FILTERS = Object.freeze({
  line: '',        // '' = current business line, 'all' = every line
  status: 'all',   // 'all' | 'active'
  billing: 'any',  // 'any' | 'subscription' | 'one_time'
  card: 'any',     // 'any' | 'on_file' | 'none'
  tags: [],        // tag ids; customer matches ANY selected tag
})

export const AUDIENCE_OPTIONS = {
  status: [
    ['all', 'All statuses'],
    ['active', 'Active customers only'],
  ],
  billing: [
    ['any', 'Any billing type'],
    ['subscription', 'Subscriptions'],
    ['one_time', 'One-time service'],
  ],
  card: [
    ['any', 'With or without card'],
    ['on_file', 'Card on file'],
    ['none', 'No card on file'],
  ],
}

export function filterAudience(customers, f, activeLine) {
  // '' = the business line the user is on right now; 'all' = every line.
  const line = f.line === 'all' ? null : (f.line || activeLine)
  const tagSet = new Set((f.tags || []).filter(Boolean))
  return (customers || []).filter((c) => {
    if (line && (c.business_line || 'waste') !== line) return false
    if (f.status === 'active' && c.status !== 'active') return false
    if (f.billing === 'subscription' && c.billingType !== 'subscription') return false
    if (f.billing === 'one_time' && c.billingType !== 'one_time') return false
    if (f.card === 'on_file' && !c.autopay?.saved) return false
    if (f.card === 'none' && c.autopay?.saved) return false
    if (tagSet.size && !(c.tags || []).some((t) => tagSet.has(t.id))) return false
    return true
  })
}

// Where a text actually goes: the POC number first, then the main phone
// (same rule the rest of the CRM uses for customer texts).
export function textTarget(c) {
  const poc = (c.contactPhone || '').trim()
  if (poc) return poc
  return (c.phone || '').trim()
}
export function emailTarget(c) {
  return (c.email || '').trim()
}

// Build the send list from an audience. One entry per customer with resolved
// text/email targets, then deduped per destination (two client records can
// share a number/email — a property manager, a couple) so nobody gets the
// same announcement twice. Opted-out clients (No Service Notifications) keep
// their email but are skipped for texts.
export function buildRecipients(customers, f, activeLine) {
  const audience = filterAudience(customers, f, activeLine)
  const rows = (audience || []).map((c) => ({
    id: c.id,
    name: c.name || '',
    phone: textTarget(c),
    email: emailTarget(c),
    optedOutOfTexts: c.notifyOnService === false,
    tagNames: (c.tags || []).map((t) => t.name),
  }))
  const seenPhone = new Set()
  const seenEmail = new Set()
  let dupeTexts = 0, dupeEmails = 0
  for (const r of rows) {
    if (r.phone) {
      const key = r.phone.replace(/\D/g, '').slice(-10)
      if (key && seenPhone.has(key)) { dupeTexts++; r.phone = '' } // same number already covered
      else if (key) seenPhone.add(key)
    }
    if (r.email) {
      const key = r.email.toLowerCase()
      if (seenEmail.has(key)) { dupeEmails++; r.email = '' }
      else seenEmail.add(key)
    }
  }
  return {
    rows,
    counts: {
      total: rows.length,
      textable: rows.filter((r) => r.phone && !r.optedOutOfTexts).length,
      optedOut: rows.filter((r) => r.phone && r.optedOutOfTexts).length,
      emailable: rows.filter((r) => r.email).length,
      noContact: rows.filter((r) => !r.phone && !r.email).length,
      dupeTexts,
      dupeEmails,
    },
  }
}

// Human label for what was picked ("Active customers · Subscriptions ·
// tagged Priority, HOA") — stored on the history row and shown in the recap.
export function audienceLabel(f, allTags) {
  const parts = []
  if (f.status === 'active') parts.push('Active customers')
  else parts.push('All customers')
  if (f.billing === 'subscription') parts.push('subscriptions')
  if (f.billing === 'one_time') parts.push('one-time service')
  if (f.card === 'on_file') parts.push('card on file')
  if (f.card === 'none') parts.push('no card on file')
  const names = (f.tags || [])
    .map((id) => (allTags || []).find((t) => t.id === id)?.name)
    .filter(Boolean)
  if (names.length) parts.push(`tagged ${names.join(', ')}`)
  if (f.line === 'all') parts.push('all business lines')
  return parts.join(' · ')
}

// --- SMS usage math (shared with the preview UI) -----------------------------

// GSM 03.38 default alphabet. Characters outside it (emoji, curly quotes,
// em dashes…) force UCS-2 encoding, which carries far fewer characters per
// segment — the difference between a 1-segment and a 3-segment text.
const GSM7 = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà' +
  ' ' // keep space explicit even though it's above
)
const GSM7_EXT = new Set('^{}[]~\\|€')

// How many segments one message occupies on the wire. GSM-7: 160 chars for a
// single segment, 153 each once concatenated; UCS-2: 70 / 67.
export function smsSegments(text) {
  const chars = [...String(text || '')]
  if (!chars.length) return 0
  let units = 0
  for (const ch of chars) {
    if (GSM7_EXT.has(ch)) units += 2
    else if (GSM7.has(ch)) units += 1
    else return chars.length <= 70 ? 1 : Math.ceil(chars.length / 67) // UCS-2
  }
  return units <= 160 ? 1 : Math.ceil(units / 153)
}

// Exact blast estimate for a recipient list: renders {firstName}/{name} per
// customer and sums the segments, plus the max segments any one message uses.
export function estimateSmsUsage(body, recipients) {
  let totalSegments = 0
  let maxSegments = 0
  let messages = 0
  for (const r of recipients) {
    if (!r.phone || r.optedOutOfTexts) continue
    const segs = smsSegments(renderAnnouncement(body, r))
    totalSegments += segs
    maxSegments = Math.max(maxSegments, segs)
    messages++
  }
  return { messages, totalSegments, maxSegments }
}

// {firstName} / {name} / {company} personalization — same placeholder idea as
// the invoice/reminder templates.
export function renderAnnouncement(tpl, vars, company) {
  return String(tpl || '')
    .replace(/\{firstName\}/g, () => (vars.firstName != null ? vars.firstName : '{firstName}'))
    .replace(/\{name\}/g, () => (vars.name != null ? vars.name : '{name}'))
    .replace(/\{company\}/g, () => (company != null ? company : '{company}'))
}

export function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || ''
}

// Month-to-date outbound texts — context for the RingCentral warning
// ("you've already sent X this month"). Includes every provider; anything
// paused/opted-out never reached a provider so it isn't counted.
export async function monthToDateTexts() {
  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  const { count, error } = await supabase
    .from('sms_messages')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'out')
    .eq('status', 'sent')
    .gte('created_at', start.toISOString())
  if (error) throw error
  return count || 0
}

// --- Sending ------------------------------------------------------------------

// Chunk size per edge-function call. Keeps each invocation well under the
// edge runtime's wall clock even for slow providers.
const CHUNK = 75

export async function sendAnnouncement({ channel, subject, body, recipients, label, filters, actorName, onProgress }) {
  const active = recipients.filter((r) => (channel !== 'email' && r.phone && !r.optedOutOfTexts) || (channel !== 'sms' && r.email))
  const totals = { sentSms: 0, failedSms: 0, skippedOptOut: recipients.filter((r) => channel !== 'email' && r.phone && r.optedOutOfTexts).length, sentEmail: 0, failedEmail: 0, failures: [] }
  const warnings = []
  const chunks = []
  for (let i = 0; i < active.length; i += CHUNK) chunks.push(active.slice(i, i + CHUNK))

  let first = true
  for (let i = 0; i < chunks.length; i++) {
    const { data, error } = await supabase.functions.invoke('announcements', {
      body: {
        action: 'send',
        create: first, // first chunk also writes the history row
        channel,
        subject,
        body,
        recipients: chunks[i],
        audienceLabel: label,
        filters,
        sentByName: actorName,
      },
    })
    if (error) throw error
    if (data && data.error) throw new Error(data.error)
    first = false
    if (data) {
      totals.sentSms += data.sentSms || 0
      totals.failedSms += data.failedSms || 0
      totals.sentEmail += data.sentEmail || 0
      totals.failedEmail += data.failedEmail || 0
      for (const f of data.smsFailures || []) totals.failures.push({ channel: 'sms', customerId: f.customerId || null, name: f.name, target: f.phone, error: f.error })
      for (const f of data.emailFailures || []) totals.failures.push({ channel: 'email', customerId: f.customerId || null, name: f.name, target: f.email, error: f.error })
      for (const w of data.warnings || []) if (!warnings.includes(w)) warnings.push(w)
    }
    onProgress && onProgress({ done: Math.min((i + 1) * CHUNK, active.length), total: active.length, totals })
  }

  const how = [
    channel !== 'email' ? `${totals.sentSms} text${totals.sentSms === 1 ? '' : 's'}${totals.failedSms ? ` (${totals.failedSms} failed)` : ''}` : null,
    channel !== 'sms' ? `${totals.sentEmail} email${totals.sentEmail === 1 ? '' : 's'}${totals.failedEmail ? ` (${totals.failedEmail} failed)` : ''}` : null,
  ].filter(Boolean).join(' + ')
  logActivity({
    type: 'announcement_sent',
    summary: `Announcement to ${label}: ${how || 'nothing sent'}${totals.skippedOptOut ? ` · ${totals.skippedOptOut} opted out of texts` : ''}`,
    meta: { channel, subject: subject || null, body, label, counts: totals },
  })
  return { ...totals, warnings }
}

// --- History -------------------------------------------------------------------

// Past announcements from the dedicated table (migration 0067). Until that
// migration is applied the read errors — callers fall back to activity-log
// entries, so the tab works from day one either way.
export async function loadAnnouncements(limit = 50) {
  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    channel: r.channel,
    audienceLabel: r.audience_label,
    subject: r.subject,
    body: r.body,
    counts: r.counts || {},
    sentByName: r.sent_by_name,
    source: 'table',
  }))
}

// Fallback: announcement recaps from the activity feed (works before 0067).
export async function loadAnnouncementActivity(limit = 200) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('id, created_at, actor, summary, meta')
    .eq('type', 'announcement_sent')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []).map((r) => ({
    id: `act-${r.id}`,
    createdAt: r.created_at,
    channel: r.meta?.channel || null,
    audienceLabel: r.meta?.label || '',
    subject: r.meta?.subject || null,
    body: r.meta?.body || r.summary,
    counts: r.meta?.counts || {},
    sentByName: r.actor,
    source: 'activity',
  }))
}

// --- Failure reasons -----------------------------------------------------------

// Turn a raw provider error into something a human can act on. Old rows (sent
// before 2026-10-23) logged only the Telnyx fallback's message when
// RingCentral refused the send — flag those as unrecoverable-but-likely rate
// limits rather than pretending the fallback was the cause.
export function humanizeSendError(err) {
  const s = String(err || '').trim()
  if (/^Telnyx fallback isn't configured/.test(s)) {
    return 'RingCentral rejected the send — exact reason wasn\'t recorded on this blast (almost certainly rate limiting from sending too fast). Fixed for future sends.'
  }
  if (/429|rate limit|too many requests/i.test(s)) return 'Rate limited — RingCentral throttled the burst'
  if (/international/i.test(s)) return 'International number — not supported'
  if (/not.{0,12}sms.{0,12}enabled|isn.t a valid sms|landline/i.test(s)) return 'Number can\'t receive texts (not SMS-enabled / landline)'
  if (/invalid|not a valid|cannot find|does not exist|unallocated/i.test(s)) return 'Invalid or unreachable phone number'
  if (/blocked|spam|blacklist|opted out/i.test(s)) return 'Blocked by the carrier'
  if (/auth|unauthorized|token/i.test(s)) return 'Provider login failed (credentials need attention)'
  return s.length > 140 ? s.slice(0, 140) + '…' : s
}

// Group failure rows by humanized reason: [{ reason, count, who: [names], channel }].
export function groupFailures(failures) {
  const groups = new Map()
  for (const f of failures || []) {
    const reason = humanizeSendError(f.error)
    if (!groups.has(reason)) groups.set(reason, { reason, count: 0, who: [], channels: new Set() })
    const g = groups.get(reason)
    g.count++
    g.channels.add(f.channel || 'sms')
    const who = f.name || f.target || 'unknown'
    if (g.who.length < 12) g.who.push(who)
  }
  return [...groups.values()]
    .map((g) => ({ ...g, channels: [...g.channels] }))
    .sort((a, b) => b.count - a.count)
}

// Failed receipts for one past announcement, straight from sms_messages /
// email_messages (works for blasts sent before failure details were returned
// to the UI). Table rows are stamped at the START of the send, activity rows
// at the END — window accordingly.
export async function loadAnnouncementFailures(announcement) {
  const t0 = new Date(announcement.createdAt).getTime()
  const [from, to] = announcement.source === 'activity'
    ? [t0 - 45 * 60000, t0 + 5 * 60000]
    : [t0 - 2 * 60000, t0 + 30 * 60000]
  const range = { gte: new Date(from).toISOString(), lte: new Date(to).toISOString() }
  const [sms, emails] = await Promise.all([
    supabase.from('sms_messages')
      .select('to_number, error, customer_id')
      .eq('purpose', 'announcement').eq('status', 'failed')
      .gte('created_at', range.gte).lte('created_at', range.lte).limit(1000),
    supabase.from('email_messages')
      .select('to_email, error, customer_id')
      .eq('purpose', 'announcement').eq('status', 'failed')
      .gte('created_at', range.gte).lte('created_at', range.lte).limit(1000),
  ])
  if (sms.error) throw sms.error
  if (emails.error) throw emails.error
  const rows = [
    ...(sms.data || []).map((r) => ({ channel: 'sms', customerId: r.customer_id || null, name: null, target: r.to_number, error: r.error || '' })),
    ...(emails.data || []).map((r) => ({ channel: 'email', customerId: r.customer_id || null, name: null, target: r.to_email, error: r.error || '' })),
  ]
  // Resolve names where the receipt carries a customer link.
  const ids = [...new Set(rows.map((r) => r.customerId).filter(Boolean))]
  if (ids.length) {
    const { data: custs } = await supabase.from('customers').select('id, name').in('id', ids)
    const byId = new Map((custs || []).map((c) => [c.id, c.name]))
    for (const r of rows) if (r.customerId) r.name = byId.get(r.customerId) || null
  }
  return rows
}
