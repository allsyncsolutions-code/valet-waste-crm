// Annotations — the shared inbox for the "Annotate" topbar button.
// Every report an admin/staff member files (marked-up screenshot, optional
// screen recording, notes, pinned element) lands here with its full history:
// replies from the team and the status log (new → handled → reopen). The dev
// agent reads the same table, so anything written here is a work order.
import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { supabase, hasSupabase } from '../lib/supabaseClient.js'

const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 14, overflow: 'hidden' }
const inp = { background: '#fff', border: '1px solid #d9e2dc', borderRadius: 9, padding: '8px 11px', fontSize: 13, color: '#1a2420', outline: 'none' }
const fmtTime = (v) => new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

async function loadReports() {
  const { data, error } = await supabase
    .from('issue_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return data || []
}

async function loadReplies(reportId) {
  const { data, error } = await supabase
    .from('issue_report_replies')
    .select('*')
    .eq('report_id', reportId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

export default function Annotations({ app }) {
  const user = app?.user || null
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('open') // open | handled | all
  const [sel, setSel] = useState(null)         // expanded report id
  const [replies, setReplies] = useState({})   // reportId -> [reply rows]
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try { setRows(await loadReports()); setErr('') } catch (e) { setErr(e.message || String(e)) }
  }
  useEffect(() => {
    if (!hasSupabase) { setErr('Supabase env vars not set — check .env.local'); return }
    refresh().catch(() => {})
    const ch = supabase
      .channel('annotations-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issue_reports' }, () => refresh().catch(() => {}))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issue_report_replies' }, (p) => {
        const rid = p.new?.report_id || p.old?.report_id
        if (rid && sel === rid) loadReplies(rid).then((r) => setReplies((m) => ({ ...m, [rid]: r }))).catch(() => {})
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [sel])

  const visible = useMemo(() => {
    if (!rows) return []
    if (filter === 'open') return rows.filter((r) => r.status !== 'handled')
    if (filter === 'handled') return rows.filter((r) => r.status === 'handled')
    return rows
  }, [rows, filter])

  async function toggle(r) {
    if (sel === r.id) { setSel(null); return }
    setSel(r.id)
    if (!replies[r.id]) {
      loadReplies(r.id)
        .then((rr) => setReplies((m) => ({ ...m, [r.id]: rr })))
        .catch(() => setReplies((m) => ({ ...m, [r.id]: [] })))
    }
  }

  async function setStatus(r, next) {
    setBusy(true)
    try {
      const { error } = await supabase.from('issue_reports').update({ status: next }).eq('id', r.id)
      if (error) throw error
      await supabase.from('issue_report_replies').insert({
        report_id: r.id,
        author: user?.id || null,
        author_name: user?.full_name || user?.email || 'Staff',
        body: next === 'handled' ? 'marked as handled' : 'reopened',
        kind: 'status',
      })
      await refresh()
      setReplies((m) => ({ ...m, [r.id]: undefined })) // force reload on next expand
      if (sel === r.id) loadReplies(r.id).then((rr) => setReplies((m) => ({ ...m, [r.id]: rr }))).catch(() => {})
    } catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  async function sendReply(r) {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      const { error } = await supabase.from('issue_report_replies').insert({
        report_id: r.id,
        author: user?.id || null,
        author_name: user?.full_name || user?.email || 'Staff',
        body,
        kind: 'reply',
      })
      if (error) throw error
      setDraft('')
      const rr = await loadReplies(r.id)
      setReplies((m) => ({ ...m, [r.id]: rr }))
    } catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      {err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['open', 'Open'], ['handled', 'Handled'], ['all', 'All']].map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)} style={{ border: 'none', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: filter === v ? 700 : 500, cursor: 'pointer', background: filter === v ? '#1f7a4d' : '#eef1ee', color: filter === v ? '#fff' : '#5d6b63' }}>{l}</button>
        ))}
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#7c8a82' }}>
          {rows ? `${visible.length} shown` : 'Loading…'}
        </div>
      </div>

      <div style={card}>
        {rows === null ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>
            Nothing here. Click <b>Annotate</b> in the top bar to pin a problem on any screen — screenshot, video, notes — and it lands in this list.
          </div>
        ) : visible.map((r, i) => {
          const open = sel === r.id
          const hist = replies[r.id] || []
          return (
            <div key={r.id} style={{ borderTop: i ? '1px solid #f2f4f2' : 'none' }}>
              <div onClick={() => toggle(r)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}>
                <span style={{ flex: 'none', fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: r.status === 'handled' ? '#e7f4ed' : '#fdf2e0', color: r.status === 'handled' ? '#1f7a4d' : '#b07a1e' }}>{r.status === 'handled' ? 'handled' : 'new'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</div>
                  <div style={{ fontSize: 11.5, color: '#7c8a82', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.creator_name || r.creator_email || 'Staff'}
                    {r.screen ? ` · ${r.screen}` : ''}
                    {r.target_label ? ` · pinned: ${r.target_label}` : ''}
                    {hist.length ? ` · ${hist.length} in history` : ''}
                  </div>
                </div>
                <div style={{ flex: 'none', fontFamily: MONO, fontSize: 11, color: '#9aa69e' }}>{fmtTime(r.created_at)}</div>
              </div>

              {open && (
                <div style={{ padding: '4px 16px 16px', borderTop: '1px dashed #eef1ee' }}>
                  {r.screenshot_url && (
                    <a href={r.screenshot_url} target="_blank" rel="noreferrer">
                      <img src={r.screenshot_url} alt="Marked-up screenshot" style={{ display: 'block', maxWidth: '100%', maxHeight: 300, border: '1px solid #e6eae6', borderRadius: 10, margin: '12px 0' }} />
                    </a>
                  )}
                  {r.video_url && (
                    <video src={r.video_url} controls style={{ display: 'block', maxWidth: '100%', maxHeight: 260, border: '1px solid #e6eae6', borderRadius: 10, margin: '12px 0' }} />
                  )}
                  {r.note && <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', background: '#f7f9f7', border: '1px solid #eef1ee', borderRadius: 9, padding: '10px 12px', margin: '12px 0' }}>{r.note}</div>}
                  <div style={{ fontSize: 11.5, color: '#9aa69e', fontFamily: MONO, margin: '4px 0 12px' }}>
                    {r.page_path ? `path: ${r.page_path} · ` : ''}{r.selector ? `element: ${r.selector}` : ''}
                  </div>

                  {/* history: replies + status changes, chronological */}
                  <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#9aa69e', margin: '6px 0 8px' }}>HISTORY</div>
                  {hist.length === 0 && <div style={{ fontSize: 12, color: '#9aa69e', marginBottom: 10 }}>No replies yet.</div>}
                  {hist.map((h) => (
                    <div key={h.id} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'baseline' }}>
                      <span style={{ fontFamily: MONO, fontSize: 10.5, color: '#9aa69e', flex: 'none' }}>{fmtTime(h.created_at)}</span>
                      <span style={{ fontSize: 12.5 }}>
                        <b style={{ color: h.kind === 'status' ? '#b07a1e' : '#1a2420' }}>{h.author_name || 'Staff'}</b>
                        {h.kind === 'status' ? ` ${h.body}` : ` — ${h.body}`}
                      </span>
                    </div>
                  ))}

                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(r) } }}
                      placeholder="Reply — an update, a question, 'fix shipped'…" style={{ ...inp, flex: 1 }} />
                    <button onClick={() => sendReply(r)} disabled={busy || !draft.trim()} style={{ ...inp, cursor: 'pointer', fontWeight: 700, background: '#1f7a4d', color: '#fff', border: 'none' }}>Reply</button>
                    <button onClick={() => setStatus(r, r.status === 'handled' ? 'new' : 'handled')} disabled={busy}
                      style={{ ...inp, cursor: 'pointer', fontWeight: 700, background: r.status === 'handled' ? '#fdf2e0' : '#e7f4ed', color: r.status === 'handled' ? '#b07a1e' : '#1f7a4d', border: '1px solid #d9e2dc' }}>
                      {r.status === 'handled' ? 'Reopen' : 'Mark handled'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
