import { useEffect, useState } from 'react'
import { MONO } from '../data.js'
import { loadAnnotations, setAnnotationStatus, deleteAnnotation } from '../lib/annotationsData.js'

const fmt = (ts) => { try { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return ts } }

export default function Annotations({ app }) {
  const [items, setItems] = useState([])
  const [filter, setFilter] = useState('open')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState(null)

  async function refresh() {
    setLoading(true)
    try { setItems(await loadAnnotations(filter)) }
    catch (e) { setErr(e.message || String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [filter])

  async function toggle(a) {
    setBusyId(a.id)
    try { await setAnnotationStatus(a.id, a.status === 'open' ? 'resolved' : 'open'); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    finally { setBusyId(null) }
  }
  async function remove(a) {
    if (!window.confirm('Delete this annotation?')) return
    setBusyId(a.id)
    try { await deleteAnnotation(a.id); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    finally { setBusyId(null) }
  }

  const TABS = [['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']]

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ fontSize: 13, color: '#5d6b63', marginBottom: 14 }}>
        Notes admins left with the ✎ annotation tool. Click the pencil in the top bar, then any element, to add more. Work through them here with Claude.
      </div>

      {err && <div style={{ background: '#fbeae6', color: '#c0492f', border: '1px solid #c0492f33', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {TABS.map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)} style={{ background: filter === v ? '#1f7a4d' : '#fff', color: filter === v ? '#fff' : '#5d6b63', border: `1px solid ${filter === v ? '#1f7a4d' : '#dde2dd'}`, borderRadius: 9, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{l}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ padding: 28, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading…</div>
      ) : !items.length ? (
        <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '40px 24px', textAlign: 'center', color: '#7c8a82', fontSize: 13 }}>
          No {filter === 'all' ? '' : filter} annotations. Turn on the ✎ tool in the top bar to flag something.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((a) => (
            <div key={a.id} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '13px 15px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', color: a.status === 'open' ? '#c0492f' : '#1f7a4d', background: a.status === 'open' ? '#fbeae6' : '#e7f1eb', padding: '2px 7px', borderRadius: 5 }}>{a.status === 'open' ? 'OPEN' : 'RESOLVED'}</span>
                {a.view_title && <span style={{ fontSize: 12, fontWeight: 600, color: '#5d6b63' }}>{a.view_title}</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5, color: '#9aa69e' }}>{a.author_name} · {fmt(a.created_at)}</span>
              </div>
              {a.target_label && <div style={{ fontSize: 12.5, color: '#7c8a82', marginBottom: 6 }}>Element: <b style={{ color: '#1a2420' }}>“{a.target_label}”</b></div>}
              <div style={{ fontSize: 14, color: '#1a2420', whiteSpace: 'pre-wrap' }}>{a.note}</div>
              {a.target_selector && <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#b3bcb4', marginTop: 6, wordBreak: 'break-all' }}>{a.target_selector}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                <button onClick={() => toggle(a)} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #1f7a4d55', color: '#1f7a4d', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>{a.status === 'open' ? 'Mark resolved' : 'Reopen'}</button>
                <button onClick={() => remove(a)} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #c0492f55', color: '#c0492f', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
