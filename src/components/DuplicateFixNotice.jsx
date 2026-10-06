// One-time admin notice: the duplicate-address fix (Oct 2026).
//
// Shown once per admin (localStorage key below). Web CRM only — deliberately
// NOT on the mobile app: this is a business-ops message for admins, and field
// techs' screens stay focused on the job. Reuse this component with a new
// STORAGE_KEY for future admin announcements.
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'vw_notice_duplicate_fix_v1'

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,30,20,.5)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
const modal = { width: '100%', maxWidth: 560, background: '#fff', borderRadius: 16, padding: '26px 28px', boxShadow: '0 24px 70px rgba(0,0,0,.35)', maxHeight: '85vh', overflowY: 'auto', boxSizing: 'border-box' }
const h = { fontWeight: 700, fontSize: 17, color: '#2c3a32', margin: '18px 0 8px' }
const p = { fontSize: 13.5, color: '#5d6b63', lineHeight: 1.65, margin: '0 0 10px' }
const li = { fontSize: 13.5, color: '#5d6b63', lineHeight: 1.6, marginBottom: 8 }

export default function DuplicateFixNotice() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try { if (!localStorage.getItem(STORAGE_KEY)) setOpen(true) } catch (_e) { /* private mode — skip */ }
  }, [])

  if (!open) return null
  const close = () => {
    setOpen(false)
    try { localStorage.setItem(STORAGE_KEY, new Date().toISOString()) } catch (_e) { /* best effort */ }
  }

  return (
    <div style={overlay} onClick={close}>
      <div style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Duplicate address fix">
        <div style={{ fontSize: 26, marginBottom: 4 }}>🏠</div>
        <div style={{ fontWeight: 800, fontSize: 20, color: '#1d2b23', letterSpacing: '-.01em' }}>Duplicate addresses — fixed</div>
        <div style={{ fontSize: 12.5, color: '#9aa69e', marginTop: 4 }}>One-time notice for admins · October 2026</div>

        <div style={h}>Where the duplicates were coming from</div>
        <p style={p}>
          Two holes let the same property end up on file more than once (this is what filled the Schedules page with stale
          duplicates like the old City Hideaways stops):
        </p>
        <ul style={{ margin: '0 0 4px', paddingLeft: 20 }}>
          <li style={li}><b>Bulk imports counted but didn't skip.</b> The CSV import view and Trashy Randy's bulk-add tool reported how many incoming addresses already existed — then imported them anyway. The “duplicates” number was a report, not a filter.</li>
          <li style={li}><b>Single adds only checked the same client, loosely.</b> A formatting variant (“123 Main St” vs “123 Main Street”) or the same address filed under a different client slipped right through.</li>
        </ul>

        <div style={h}>What's fixed now</div>
        <ul style={{ margin: '0 0 4px', paddingLeft: 20 }}>
          <li style={li}><b>Imports skip what you already have</b> — addresses on file are skipped, and repeats inside the same file collapse into one row.</li>
          <li style={li}><b>Every add checks the whole system</b> — CRM form, Trashy Randy, and portal request approvals all compare a normalized address against every client. If it exists, you're told which client has it.</li>
          <li style={li}><b>Database backstop</b> — a same-client duplicate can no longer be inserted by any tool, period.</li>
        </ul>

        <div style={h}>Cleaning up ones already there</div>
        <p style={p}>
          The fix stops new duplicates; it doesn't delete old ones. Use <b>Schedules → “Review paused…”</b> to bulk-resume or
          remove stale stops, and ask Trashy Randy to merge anything that's still active.
        </p>

        <button
          onClick={close}
          style={{ width: '100%', marginTop: 10, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
        >Got it</button>
      </div>
    </div>
  )
}
