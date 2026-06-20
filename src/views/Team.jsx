import { useEffect, useState } from 'react'
import { MONO } from '../data.js'
import { loadTeam, inviteMember, setMemberRole, removeMember, subscribeTeam } from '../lib/teamData.js'

const ROLE_STYLE = {
  admin: ['#1f7a4d', '#e7f1eb', 'Admin'],
  staff: ['#2563a8', '#e6eef7', 'Staff'],
  pending: ['#c08a2e', '#fdf2e0', 'Pending'],
}

function initialsOf(name) {
  return String(name || 'U')
    .replace(/@.*$/, '')
    .split(/[\s._-]+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('') || 'U'
}

export default function Team({ app }) {
  const isMobile = app.isMobile
  const me = app.user || {}
  const isAdmin = me.role === 'admin'

  const [members, setMembers] = useState(null)
  const [err, setErr] = useState('')
  const [showInvite, setShowInvite] = useState(false)
  const [invite, setInvite] = useState({ email: '', full_name: '', role: 'staff', password: '' })
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(null) // {email, password}

  async function refresh() {
    try { setMembers(await loadTeam()); setErr('') }
    catch (e) { setErr((e && e.message) || String(e)) }
  }

  useEffect(() => {
    refresh()
    const off = subscribeTeam(() => refresh())
    return off
  }, [])

  async function submitInvite(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setErr(''); setCreated(null)
    try {
      const res = await inviteMember(invite)
      setCreated({ email: res.email, password: res.password })
      setInvite({ email: '', full_name: '', role: 'staff', password: '' })
      setShowInvite(false)
      refresh()
    } catch (e2) { setErr((e2 && e2.message) || String(e2)) }
    setBusy(false)
  }

  async function changeRole(m, role) {
    setErr('')
    try { await setMemberRole(m.id, role); refresh() }
    catch (e) { setErr((e && e.message) || String(e)) }
  }

  async function remove(m) {
    if (!window.confirm(`Remove ${m.full_name || m.email}? This deletes their login.`)) return
    setErr('')
    try { await removeMember(m.id); refresh() }
    catch (e) { setErr((e && e.message) || String(e)) }
  }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, fontSize: 13, color: '#5d6b63' }}>
          Staff who can sign in to the CRM. {isAdmin ? 'Invite members and manage their access.' : 'Only admins can change the team.'}
        </div>
        {isAdmin && (
          <button onClick={() => { setShowInvite((v) => !v); setCreated(null) }} style={btnPrimary}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>+</span> {isMobile ? 'Add' : 'Add member'}
          </button>
        )}
      </div>

      {err && <div style={banner('#c0492f', '#fbeae6')}>{err}</div>}

      {created && (
        <div style={banner('#1f7a4d', '#e7f1eb')}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Account created — share these credentials</div>
          Email: <b>{created.email}</b> · Temporary password: <b style={{ fontFamily: MONO }}>{created.password}</b>
          <div style={{ fontSize: 12, color: '#4a6256', marginTop: 4 }}>They can sign in now; ask them to change it in their account.</div>
        </div>
      )}

      {isAdmin && showInvite && (
        <form onSubmit={submitInvite} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 18, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <div>
              <label style={lbl}>Email</label>
              <input type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} style={inp} placeholder="name@company.com" />
            </div>
            <div>
              <label style={lbl}>Full name</label>
              <input value={invite.full_name} onChange={(e) => setInvite({ ...invite, full_name: e.target.value })} style={inp} placeholder="Jane Driver" />
            </div>
            <div>
              <label style={lbl}>Role</label>
              <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} style={inp}>
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div>
              <label style={lbl}>Temporary password <span style={{ color: '#9aa69e', fontWeight: 400 }}>(optional)</span></label>
              <input value={invite.password} onChange={(e) => setInvite({ ...invite, password: e.target.value })} style={inp} placeholder="Leave blank to auto-generate" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button type="submit" disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.7 : 1 }}>{busy ? 'Creating…' : 'Create account'}</button>
            <button type="button" onClick={() => setShowInvite(false)} style={btnGhost}>Cancel</button>
          </div>
        </form>
      )}

      {members === null ? (
        <div style={{ color: '#7c8a82', fontSize: 13, padding: 20, textAlign: 'center' }}>Loading…</div>
      ) : members.length === 0 ? (
        <div style={{ color: '#7c8a82', fontSize: 13, padding: 20, textAlign: 'center' }}>No team members yet.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14 }}>
          {members.map((m) => {
            const [rc, rb, rlabel] = ROLE_STYLE[m.role] || ROLE_STYLE.pending
            const isMe = m.id === me.id
            return (
              <div key={m.id} style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '16px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 42, height: 42, borderRadius: '50%', background: '#3a5246', color: '#dff0e6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 14, flex: 'none' }}>{initialsOf(m.full_name || m.email)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {m.full_name || m.email}{isMe && <span style={{ fontSize: 11, color: '#1f7a4d', fontWeight: 600, marginLeft: 8 }}>You</span>}
                    </div>
                    <div style={{ fontSize: 12, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.email}</div>
                  </div>
                  <div style={{ flex: 'none', fontSize: 10.5, fontWeight: 600, fontFamily: MONO, color: rc, background: rb, padding: '3px 9px', borderRadius: 20 }}>{rlabel}</div>
                </div>

                {isAdmin && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
                    <select value={m.role} onChange={(e) => changeRole(m, e.target.value)} disabled={isMe} style={{ ...inp, padding: '7px 9px', flex: 1, opacity: isMe ? 0.6 : 1 }}>
                      <option value="admin">Admin</option>
                      <option value="staff">Staff</option>
                      <option value="pending">Pending (no access)</option>
                    </select>
                    <button onClick={() => remove(m)} disabled={isMe} title={isMe ? "You can't remove yourself" : 'Remove'} style={{ ...btnGhost, color: isMe ? '#bbb' : '#c0492f', borderColor: isMe ? '#eee' : '#f0d4cd', cursor: isMe ? 'not-allowed' : 'pointer' }}>Remove</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const btnPrimary = { display: 'flex', alignItems: 'center', gap: 7, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', flex: 'none' }
const btnGhost = { background: '#fff', color: '#1a2420', border: '1px solid #dde2dd', borderRadius: 9, padding: '8px 13px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#5d6b63', marginBottom: 6 }
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '10px 12px', fontSize: 15, color: '#1a2420', outline: 'none' }
const banner = (color, bg) => ({ background: bg, color, border: `1px solid ${color}33`, borderRadius: 10, padding: '12px 14px', fontSize: 13, marginBottom: 14 })
