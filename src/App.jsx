import { useEffect, useRef, useState } from 'react'
import { useResponsive } from './useResponsive.js'
import { LINES, MONO } from './data.js'
import { supabase } from './lib/supabaseClient.js'
import RoutesView from './views/Routes.jsx'
import Clients from './views/Clients.jsx'
import Settings from './views/Settings.jsx'
import Schedule from './views/Schedule.jsx'
import Invoices from './views/Invoices.jsx'
import Dashboard from './views/Dashboard.jsx'
import Activity from './views/Activity.jsx'
import Team from './views/Team.jsx'
import Import from './views/Import.jsx'
import AiDock from './AiDock.jsx'

// Tabs not yet wired to Supabase show a clean placeholder (no sample data).
function Placeholder({ title }) {
  return (
    <div style={{ maxWidth: 720, margin: '40px auto', textAlign: 'center', background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '48px 28px' }}>
      <div style={{ fontSize: 26, marginBottom: 10 }}>◦</div>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{title} isn’t connected to live data yet</div>
      <div style={{ fontSize: 13, color: '#7c8a82' }}>This section will read from Supabase once it’s built out — like Clients and Routes & Dispatch already do.</div>
    </div>
  )
}

const NAV_MAIN = [
  { id: 'dashboard', glyph: '▦', label: 'Dashboard' },
  { id: 'routes', glyph: '◔', label: 'Routes & Dispatch' },
  { id: 'schedule', glyph: '▤', label: 'Schedules' },
  { id: 'invoices', glyph: '$', label: 'Invoicing' },
]
const NAV_FIELD = [
  { id: 'clients', glyph: '◎', label: 'Clients' },
  { id: 'import', glyph: '⇪', label: 'Import' },
  { id: 'activity', glyph: '◷', label: 'Activity Log' },
  { id: 'drivers', glyph: '⛟', label: 'Drivers & Field' },
  { id: 'team', glyph: '⚇', label: 'Team' },
  { id: 'portal', glyph: '◫', label: 'Client Portal' },
  { id: 'settings', glyph: '⚙', label: 'Settings' },
]
const BOTTOM_NAV = [
  { id: 'dashboard', glyph: '▦', label: 'Home' },
  { id: 'routes', glyph: '◔', label: 'Routes' },
  { id: 'schedule', glyph: '▤', label: 'Schedule' },
  { id: 'invoices', glyph: '$', label: 'Billing' },
  { id: 'clients', glyph: '◎', label: 'Clients' },
]

export default function App({ user, onSignOut }) {
  const { isMobile, isTablet } = useResponsive()

  const displayName = (user && (user.full_name || user.email)) || 'Staff'
  const roleLabel = user && user.role === 'admin' ? 'Administrator' : 'Staff'
  const initials = String(displayName)
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || 'U'

  const [activeLine, setActiveLine] = useState('waste')
  const [activeView, setActiveView] = useState('clients')
  const [lineMenuOpen, setLineMenuOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false) // mobile drawer
  const [commandText, setCommandText] = useState('')
  const [logoSrc, setLogoSrc] = useState(null)

  // AI dock
  const [aiOpen, setAiOpen] = useState(!isMobile)
  const [aiInput, setAiInput] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMessages, setAiMessages] = useState([
    {
      role: 'ai',
      text: "Hey, I'm Trashy Randy. Tell me to add a client — e.g. \"Add Northgate Retail, weekly Monday pickup, 6yd dumpster, invoice monthly\" — and I'll set them up with a pickup schedule and invoice schedule.",
    },
  ])
  const aiScrollRef = useRef(null)
  const logoInputRef = useRef(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('vw_logo')
      if (saved) setLogoSrc(saved)
    } catch (e) {}
  }, [])

  // lock body scroll when an overlay is open on mobile
  useEffect(() => {
    const lock = (isMobile && (navOpen || aiOpen))
    document.body.style.overflow = lock ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [isMobile, navOpen, aiOpen])

  const activeLineObj = LINES.find((l) => l.id === activeLine) || LINES[0]

  const VIEW_META = {
    dashboard: ['Dispatch Overview', activeLineObj.name],
    routes: ['Routes & Dispatch', 'Live sequencing, GPS tracking and AI optimization'],
    schedule: ['Recurring Schedules', 'Set pickup cadence — nth weekday, alternating weeks'],
    invoices: ['Invoicing', 'Per-stop line items · monthly batch billing'],
    clients: ['Clients', 'Add and manage your customers'],
    import: ['Import Properties', 'Bulk-add service locations to a client'],
    activity: ['Activity Log', 'Everything you and Trashy Randy have done'],
    drivers: ['Drivers & Field', 'Check-in / check-out, photos and GPS'],
    team: ['Team', 'Members and their business-line assignments'],
    portal: ['Client Portal', 'What your clients see when they log in'],
    settings: ['Settings', 'Manage tags and configuration'],
  }
  const [viewTitle, viewSubtitle] = VIEW_META[activeView] || VIEW_META.dashboard

  function go(view) {
    setActiveView(view)
    setLineMenuOpen(false)
    setNavOpen(false)
  }

  function scrollAi() {
    requestAnimationFrame(() => {
      if (aiScrollRef.current) aiScrollRef.current.scrollTop = aiScrollRef.current.scrollHeight
    })
  }

  async function runAi(text) {
    const clean = (text || '').trim()
    if (!clean) return
    // Build conversation history for the edge function (role + text).
    const history = aiMessages
      .filter((m) => m.text)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }))
    history.push({ role: 'user', text: clean })

    setAiMessages((prev) => prev.concat([{ role: 'user', text: clean }]))
    setAiInput('')
    setCommandText('')
    setAiBusy(true)
    scrollAi()
    try {
      const { data, error } = await supabase.functions.invoke('dispatch-ai', { body: { messages: history } })
      if (error) throw error
      setAiMessages((prev) => prev.concat([{ role: 'ai', text: (data && data.text) || 'Done.' }]))
    } catch (e) {
      setAiMessages((prev) => prev.concat([{
        role: 'ai',
        text: "I couldn't reach the assistant service: " + ((e && e.message) || e) + '. (If this is the first run, make sure the ANTHROPIC_API_KEY secret is set in Supabase.)',
      }]))
    }
    setAiBusy(false)
    scrollAi()
  }

  function confirmAction(idx) {
    setAiMessages((prev) => {
      const msgs = prev.slice()
      const label = msgs[idx].action
      msgs[idx] = { ...msgs[idx], action: '' }
      msgs.push({ role: 'ai', text: '✓ Done — ' + label + '. The change is live and logged to the activity feed.', action: '', done: true })
      return msgs
    })
    scrollAi()
  }

  function openAssistant() { setAiOpen(true) }

  function askAi(prompt) {
    setAiOpen(true)
    runAi(prompt)
  }

  function onLogoFile(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const src = reader.result
      setLogoSrc(src)
      try { localStorage.setItem('vw_logo', src) } catch (e) {}
    }
    reader.readAsDataURL(file)
  }

  // bag passed to views
  const app = { activeLine, activeLineObj, go, openAssistant, askAi, runAi, isMobile, isTablet, user }

  const views = {
    dashboard: <Dashboard app={app} />,
    routes: <RoutesView app={app} />,
    schedule: <Schedule app={app} />,
    invoices: <Invoices app={app} />,
    clients: <Clients app={app} />,
    import: <Import app={app} />,
    activity: <Activity app={app} />,
    drivers: <Placeholder title="Drivers & Field" />,
    portal: <Placeholder title="Client Portal" />,
    team: <Team app={app} />,
    settings: <Settings app={app} />,
  }

  const showInlineDock = aiOpen && !isMobile && !isTablet

  const navRail = (
    <nav
      style={{
        width: 236,
        flex: 'none',
        background: '#15201b',
        display: 'flex',
        flexDirection: 'column',
        color: '#9fb3a8',
        height: '100%',
      }}
    >
      <div style={{ padding: '18px 18px 14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            onClick={() => logoInputRef.current && logoInputRef.current.click()}
            title="Click to upload your logo"
            style={{ width: 32, height: 32, borderRadius: 8, background: logoSrc ? '#fff' : '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', cursor: 'pointer', overflow: 'hidden', position: 'relative' }}
          >
            {logoSrc ? (
              <img src={logoSrc} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div style={{ width: 14, height: 14, border: '2.5px solid #eafff2', borderRadius: '50%', borderRightColor: 'transparent' }} />
            )}
          </div>
          <div style={{ lineHeight: 1 }}>
            <div style={{ color: '#f3f7f4', fontWeight: 700, fontSize: 16, letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>Valet Waste</div>
            <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '.16em', color: '#5f7568', marginTop: 3 }}>DISPATCH CRM</div>
          </div>
          {isMobile && (
            <div onClick={() => setNavOpen(false)} style={{ marginLeft: 'auto', color: '#9fb3a8', fontSize: 18, cursor: 'pointer', padding: 4 }}>✕</div>
          )}
        </div>
        <input ref={logoInputRef} onChange={(e) => onLogoFile(e.target.files && e.target.files[0])} type="file" accept="image/*" style={{ display: 'none' }} />
      </div>

      {/* business line switcher */}
      <div style={{ padding: '0 14px 14px 14px' }}>
        <div onClick={() => setLineMenuOpen((v) => !v)} style={{ position: 'relative', background: '#1d2c25', border: '1px solid #2a3c33', borderRadius: 9, padding: '9px 11px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 9, height: 9, borderRadius: 3, background: activeLineObj.color, flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#dfe9e3', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeLineObj.name}</div>
            <div style={{ fontSize: 10, color: '#5f7568' }}>{activeLineObj.meta}</div>
          </div>
          <div style={{ color: '#5f7568', fontSize: 10 }}>▾</div>
          {lineMenuOpen && (
            <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: '#22332b', border: '1px solid #324840', borderRadius: 10, padding: 5, zIndex: 50, boxShadow: '0 14px 30px rgba(0,0,0,.4)' }}>
              {LINES.map((bl) => (
                <div key={bl.id} onClick={(e) => { e.stopPropagation(); setActiveLine(bl.id); setLineMenuOpen(false) }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 9px', borderRadius: 7, cursor: 'pointer' }}>
                  <div style={{ width: 8, height: 8, borderRadius: 3, background: bl.color, flex: 'none' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#e3ede7', fontSize: 13, fontWeight: 500 }}>{bl.name}</div>
                    <div style={{ fontSize: 10, color: '#6a8175' }}>{bl.meta}</div>
                  </div>
                  {bl.id === activeLine && <div style={{ color: '#46c585', fontSize: 12 }}>✓</div>}
                </div>
              ))}
              <div style={{ height: 1, background: '#324840', margin: '5px 4px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 9px', borderRadius: 7, cursor: 'pointer', color: '#7a9387' }}>
                <div style={{ width: 8, height: 8, borderRadius: 3, border: '1.5px dashed #6a8175', flex: 'none' }} />
                <div style={{ fontSize: 13 }}>Add business line</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>
        <NavGroup label="OPERATIONS" items={NAV_MAIN} activeView={activeView} onGo={go} />
        <NavGroup label="FIELD & CLIENTS" items={NAV_FIELD} activeView={activeView} onGo={go} top={14} />
      </div>

      <div onClick={openAssistant} style={{ margin: '10px 12px', padding: '11px 12px', borderRadius: 10, background: 'linear-gradient(135deg,#1f7a4d,#155e3a)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 24, height: 24, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.16)', borderRadius: 7, fontSize: 13, color: '#fff' }}>✦</div>
        <div style={{ flex: 1, lineHeight: 1.2 }}>
          <div style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}>Trashy Randy</div>
          <div style={{ fontSize: 10, color: '#bfe6d0' }}>Ask · route · invoice</div>
        </div>
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid #233329', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#3a5246', color: '#dff0e6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 12, flex: 'none' }}>{initials}</div>
        <div style={{ flex: 1, lineHeight: 1.2, minWidth: 0 }}>
          <div style={{ color: '#dfe9e3', fontWeight: 500, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</div>
          <div style={{ fontSize: 10, color: '#5f7568' }}>{roleLabel}</div>
        </div>
        <div onClick={onSignOut} title="Sign out" style={{ color: '#9fb3a8', fontSize: 11, cursor: 'pointer', border: '1px solid #2a3c33', borderRadius: 7, padding: '4px 8px' }}>Sign out</div>
      </div>
    </nav>
  )

  return (
    <div style={{ display: 'flex', height: '100dvh', width: '100%', overflow: 'hidden', background: '#f4f5f3', color: '#1a2420', fontSize: 14 }}>
      {/* desktop rail */}
      {!isMobile && navRail}

      {/* mobile drawer */}
      {isMobile && navOpen && (
        <>
          <div onClick={() => setNavOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 300 }} />
          <div style={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: 252, maxWidth: '84vw', zIndex: 310, animation: 'slideIn .18s ease' }}>{navRail}</div>
        </>
      )}

      {/* MAIN */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* top bar */}
        <header style={{ minHeight: 62, flex: 'none', background: '#fff', borderBottom: '1px solid #e3e6e2', display: 'flex', alignItems: 'center', padding: isMobile ? '0 14px' : '0 22px', gap: isMobile ? 12 : 18 }}>
          {isMobile && (
            <div onClick={() => setNavOpen(true)} style={{ width: 36, height: 36, flex: 'none', borderRadius: 9, border: '1px solid #e3e6e2', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5d6b63', fontSize: 17 }}>≡</div>
          )}
          <div style={{ minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
            <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{viewTitle}</div>
            {!isMobile && <div style={{ fontSize: 11.5, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{viewSubtitle}</div>}
          </div>

          {!isMobile && (
            <div style={{ flex: 1, minWidth: 120, maxWidth: 520 }}>
              <form onSubmit={(e) => { e.preventDefault(); if (commandText.trim()) askAi(commandText) }} style={{ position: 'relative' }}>
                <div style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#1f7a4d', fontSize: 13, pointerEvents: 'none' }}>✦</div>
                <input value={commandText} onChange={(e) => setCommandText(e.target.value)} placeholder="Ask Trashy Randy — “route the new Cedar Industrial pickup”…" style={{ width: '100%', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 10, padding: '9px 13px 9px 36px', fontSize: 16, color: '#1a2420', outline: 'none' }} />
                <div style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', fontFamily: MONO, fontSize: 10, color: '#9aa69e', border: '1px solid #e3e6e2', borderRadius: 5, padding: '2px 6px', pointerEvents: 'none' }}>⌘K</div>
              </form>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
            {isMobile && (
              <div onClick={openAssistant} style={{ width: 36, height: 36, borderRadius: 9, background: 'linear-gradient(135deg,#1f7a4d,#155e3a)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', fontSize: 15, flex: 'none' }}>✦</div>
            )}
            <div style={{ position: 'relative', width: 36, height: 36, borderRadius: 9, border: '1px solid #e3e6e2', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5d6b63', flex: 'none' }}>
              <span style={{ fontSize: 15 }}>⚲</span>
              <div style={{ position: 'absolute', top: 7, right: 8, width: 7, height: 7, borderRadius: '50%', background: '#c0492f', border: '1.5px solid #fff' }} />
            </div>
            {!isMobile && (
              <button onClick={() => askAi('Route a new pickup for Cedar Industrial and set up its billing')} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: 15, lineHeight: 1 }}>+</span> New pickup
              </button>
            )}
          </div>
        </header>

        {/* content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px 14px 96px' : '22px 24px 60px', WebkitOverflowScrolling: 'touch' }}>
          {views[activeView] || views.dashboard}
        </div>

        {/* mobile bottom nav */}
        {isMobile && (
          <div style={{ flex: 'none', background: '#15201b', borderTop: '1px solid #233329', display: 'flex', padding: '6px 4px calc(6px + env(safe-area-inset-bottom))', position: 'relative', zIndex: 120 }}>
            {BOTTOM_NAV.map((n) => {
              const active = activeView === n.id
              return (
                <div key={n.id} onClick={() => go(n.id)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '6px 2px', cursor: 'pointer', color: active ? '#46c585' : '#7a9387' }}>
                  <span style={{ fontFamily: MONO, fontSize: 16, lineHeight: 1 }}>{n.glyph}</span>
                  <span style={{ fontSize: 10, fontWeight: active ? 600 : 500 }}>{n.label}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* inline AI dock (wide desktop) */}
      {showInlineDock && (
        <AiDock
          inline
          aiMessages={aiMessages}
          aiBusy={aiBusy}
          aiInput={aiInput}
          setAiInput={setAiInput}
          onSubmit={() => runAi(aiInput)}
          onClose={() => setAiOpen(false)}
          onConfirm={confirmAction}
          onDismiss={() => go('routes')}
          onChip={runAi}
          scrollRef={aiScrollRef}
        />
      )}

      {/* overlay AI dock (tablet + mobile) */}
      {aiOpen && (isTablet || isMobile) && (
        <>
          <div onClick={() => setAiOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.4)', zIndex: 400 }} />
          <AiDock
            mobile={isMobile}
            aiMessages={aiMessages}
            aiBusy={aiBusy}
            aiInput={aiInput}
            setAiInput={setAiInput}
            onSubmit={() => runAi(aiInput)}
            onClose={() => setAiOpen(false)}
            onConfirm={confirmAction}
            onDismiss={() => go('routes')}
            onChip={runAi}
            scrollRef={aiScrollRef}
          />
        </>
      )}
    </div>
  )
}

function NavGroup({ label, items, activeView, onGo, top = 0 }) {
  return (
    <>
      <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '.16em', color: '#4f6357', padding: `${8 + top}px 8px 6px` }}>{label}</div>
      {items.map((n) => {
        const active = activeView === n.id
        return (
          <div key={n.id} onClick={() => onGo(n.id)} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2, fontWeight: active ? 600 : 500, color: active ? '#f3f7f4' : '#9fb3a8', background: active ? '#22332b' : 'transparent' }}>
            {active && <div style={{ position: 'absolute', left: -12, top: 8, bottom: 8, width: 3, borderRadius: '0 3px 3px 0', background: '#46c585' }} />}
            <span style={{ fontFamily: MONO, fontSize: 14, width: 16, textAlign: 'center' }}>{n.glyph}</span>
            <span style={{ flex: 1, fontSize: 13.5 }}>{n.label}</span>
            {n.badge && <span style={{ fontFamily: MONO, fontSize: 10, background: '#2c4138', color: '#9fc7b1', padding: '1px 6px', borderRadius: 20 }}>{n.badge}</span>}
          </div>
        )
      })}
    </>
  )
}
