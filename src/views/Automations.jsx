import { useEffect, useState } from 'react'
import { MONO } from '../data.js'
import { loadAutomations, setAutomationStatus, deleteAutomation, runAutomationsNow } from '../lib/automationsData.js'

const fmt = (ts) => { try { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return ts } }

const STATUS_STYLE = {
  enabled: { label: 'ACTIVE', color: '#1f7a4d', bg: '#e7f1eb' },
  suggested: { label: 'SUGGESTED', color: '#b07d18', bg: '#faf3e2' },
  paused: { label: 'PAUSED', color: '#8a8f8a', bg: '#eef0ee' },
}

export default function Automations({ app }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [runMsg, setRunMsg] = useState('')

  async function refresh() {
    setLoading(true)
    try { setItems(await loadAutomations()) }
    catch (e) { setErr(e.message || String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])

  async function setStatus(a, status) {
    setBusyId(a.id); setErr('')
    try { await setAutomationStatus(a.id, status, a.name); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    finally { setBusyId(null) }
  }

  async function remove(a) {
    if (!window.confirm(`Delete "${a.name}"?`)) return
    setBusyId(a.id); setErr('')
    try { await deleteAutomation(a.id, a.name); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    finally { setBusyId(null) }
  }

  async function runNow(a) {
    setBusyId(a.id); setErr(''); setRunMsg('')
    try {
      const r = await runAutomationsNow(a.kind)
      const res = r?.ran?.find((x) => x.kind === a.kind)
      setRunMsg(res ? `${a.name}: ${res.result}` : r?.note || 'Ran.')
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    finally { setBusyId(null) }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ fontSize: 13, color: '#5d6b63', marginBottom: 14 }}>
        Scheduled jobs Trashy Randy runs for you, plus automations he's suggested from your requests. Approve a suggestion to put it on the schedule — nothing suggested runs until a staff member enables it.
      </div>

      {err && <div style={{ background: '#fbeae6', color: '#c0492f', border: '1px solid #c0492f33', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {runMsg && <div style={{ background: '#e7f1eb', color: '#1f7a4d', border: '1px solid #1f7a4d33', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{runMsg}</div>}

      {loading ? (
        <div style={{ padding: 28, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading…</div>
      ) : !items.length ? (
        <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '40px 24px', textAlign: 'center', color: '#7c8a82', fontSize: 13 }}>
          No automations yet. Ask Trashy Randy to automate something recurring and it'll show up here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((a) => {
            const st = STATUS_STYLE[a.status] || STATUS_STYLE.paused
            return (
              <div key={a.id} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '13px 15px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '.04em', color: st.color, background: st.bg, padding: '2px 7px', borderRadius: 5 }}>{st.label}</span>
                  <span style={{ fontSize: 14.5, fontWeight: 700, color: '#1a2420' }}>{a.name}</span>
                  <span style={{ flex: 1 }} />
                  {a.requested_by && <span style={{ fontSize: 11.5, color: '#9aa69e' }}>requested by {a.requested_by}</span>}
                </div>
                {a.description && <div style={{ fontSize: 13, color: '#5d6b63', whiteSpace: 'pre-wrap', marginBottom: 8 }}>{a.description}</div>}
                {(a.last_run_at || a.last_result) && (
                  <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 4 }}>
                    {a.last_run_at ? `Last run ${fmt(a.last_run_at)}` : 'Never run'}{a.last_result ? ` — ${a.last_result}` : ''}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {a.status === 'enabled' && (
                    <button onClick={() => runNow(a)} disabled={busyId === a.id} style={{ background: '#1f7a4d', border: '1px solid #1f7a4d', color: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Run now</button>
                  )}
                  {a.status !== 'enabled' && (
                    <button onClick={() => setStatus(a, 'enabled')} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #1f7a4d55', color: '#1f7a4d', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>{a.status === 'suggested' ? 'Approve & enable' : 'Resume'}</button>
                  )}
                  {a.status === 'enabled' && (
                    <button onClick={() => setStatus(a, 'paused')} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #b07d1855', color: '#b07d18', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Pause</button>
                  )}
                  <button onClick={() => remove(a)} disabled={busyId === a.id} style={{ background: '#fff', border: '1px solid #c0492f55', color: '#c0492f', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
