import { useEffect, useRef, useState } from 'react'
import { useResponsive } from './useResponsive.js'
import { LINES, MONO } from './data.js'
import { supabase } from './lib/supabaseClient.js'
import { loadSettings, saveLogoFile } from './lib/settingsData.js'
import RoutesView from './views/Routes.jsx'
import Clients from './views/Clients.jsx'
import Settings from './views/Settings.jsx'
import Schedule from './views/Schedule.jsx'
import Invoices from './views/Invoices.jsx'
import Dashboard from './views/Dashboard.jsx'
import Activity from './views/Activity.jsx'
import Drivers from './views/Drivers.jsx'
import Team from './views/Team.jsx'
import Import from './views/Import.jsx'
import Annotations from './views/Annotations.jsx'
import Automations from './views/Automations.jsx'
import JobCalendar from './views/JobCalendar.jsx'
import EmployeePay from './views/EmployeePay.jsx'
import MyDay from './views/MyDay.jsx'
import TechSchedule from './views/TechSchedule.jsx'
import TimeSheets from './views/TimeSheets.jsx'
import Portal from './views/Portal.jsx'
import AnnotationLayer from './components/AnnotationLayer.jsx'
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
  { id: 'automations', glyph: '⟳', label: 'Automations' },
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

  // Remember where the user was across page refreshes (line + screen).
  const [activeLine, setActiveLine] = useState(() => { try { return localStorage.getItem('vw_line') || 'waste' } catch (e) { return 'waste' } })
  const [activeView, setActiveView] = useState(() => { try { return localStorage.getItem('vw_view') || 'clients' } catch (e) { return 'clients' } })
  const [annotateMode, setAnnotateMode] = useState(false)
  const isAdmin = !!(user && user.role === 'admin')
  const [lineMenuOpen, setLineMenuOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false) // mobile drawer
  const [commandText, setCommandText] = useState('')
  const [logoSrc, setLogoSrc] = useState(null)
  const [newPickupTick, setNewPickupTick] = useState(0) // bumps to open the one-off pickup modal in Routes

  // AI dock
  const [aiOpen, setAiOpen] = useState(!isMobile)
  const [aiInput, setAiInput] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMessages, setAiMessages] = useState([
    {
      role: 'ai',
      text: "Hey, I'm Trashy Randy. I can add clients, schedule pickups, assign drivers, build invoices, and answer questions about your routes and billing. Just tell me what you need — e.g. \"what's scheduled today?\" or \"add a one-off pickup at 12 Main St to today's route.\"",
    },
  ])
  const aiScrollRef = useRef(null)
  const logoInputRef = useRef(null)

  useEffect(() => {
    // Local cache first for instant paint, then the shared logo from settings.
    try {
      const saved = localStorage.getItem('vw_logo')
      if (saved) setLogoSrc(saved)
    } catch (e) {}
    loadSettings()
      .then((s) => { if (s && s.logo_url) { setLogoSrc(s.logo_url); try { localStorage.setItem('vw_logo', s.logo_url) } catch (e) {} } })
      .catch(() => {})
  }, [])

  // lock body scroll when an overlay is open on mobile
  useEffect(() => {
    const lock = (isMobile && (navOpen || aiOpen))
    document.body.style.overflow = lock ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [isMobile, navOpen, aiOpen])

  const activeLineObj = LINES.find((l) => l.id === activeLine) || LINES[0]

  // Business-line access: members only see/switch to lines they're assigned.
  const myLines = (user && user.business_lines && user.business_lines.length) ? user.business_lines : ['waste', 'junk', 'lawn']
  const visibleLines = LINES.filter((l) => myLines.includes(l.id))

  // Junk Removal is one-time work — no recurring routes. Its Schedules tab is
  // the job calendar, and Routes & Dispatch is hidden entirely.
  const isJunk = activeLine === 'junk'
  const isLawn = activeLine === 'lawn'
  const navMain = isJunk
    ? NAV_MAIN.filter((n) => n.id !== 'routes')
    : isLawn
      ? [...NAV_MAIN, { id: 'employees', glyph: '✂', label: 'Employees' }]
      : NAV_MAIN
  // Lawn techs work per-JOB, not per-truck-route — swap Drivers & Field for My Day.
  const navFieldBase = isLawn
    ? NAV_FIELD.map((n) => (n.id === 'drivers' ? { id: 'myday', glyph: '☀', label: 'My Day' } : n))
    : NAV_FIELD
  // Field-crew tabs: schedule calendar (all lines) + payroll (lawn's per-job pay).
  const navField = (() => {
    const extra = [{ id: 'myschedule', glyph: '▥', label: 'My Schedule' }]
    if (isLawn) extra.push({ id: 'timesheets', glyph: '⏱', label: 'Time Sheets & Payroll' })
    const base = navFieldBase.slice()
    const idx = base.findIndex((n) => n.id === 'drivers' || n.id === 'myday')
    base.splice(idx === -1 ? base.length : idx + 1, 0, ...extra)
    return base
  })()

  // Techs (staff flagged as drivers) get a focused rail: Dashboard, Routes &
  // Dispatch, My Day / Drivers & Field, My Schedule, and Time Sheets & Payroll.
  const isTech = !isAdmin && !!(user && user.is_driver)
  const TECH_IDS = ['dashboard', 'routes', 'myday', 'drivers', 'myschedule', 'timesheets']
  const techMain = navMain.filter((n) => ['dashboard', 'routes'].includes(n.id))
  const techField = navField.filter((n) => TECH_IDS.includes(n.id))

  // Custom nav-tab order (drag to reorder in the rail; saved per browser).
  const [navOrder, setNavOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vw_nav_order') || '{}') } catch (e) { return {} }
  })
  const saveNavOrder = (group, ids) => setNavOrder((o) => {
    const next = { ...o, [group]: ids }
    try { localStorage.setItem('vw_nav_order', JSON.stringify(next)) } catch (e) { /* private mode */ }
    return next
  })
  // Sort items by the saved order; tabs not in the saved list (new features,
  // line-specific swaps) keep their default position at the end of the group.
  const applyNavOrder = (items, ids) => {
    if (!ids || !ids.length) return items
    const pos = new Map(ids.map((id, i) => [id, i]))
    return items.slice().sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 999) - (pos.has(b.id) ? pos.get(b.id) : 999))
  }

  // Persist line + screen so a refresh brings the user right back here.
  useEffect(() => {
    try {
      localStorage.setItem('vw_line', activeLine)
      localStorage.setItem('vw_view', activeView)
    } catch (e) { /* private mode etc. */ }
  }, [activeLine, activeView])

  // If the current view doesn't exist on this line, land on the dashboard.
  useEffect(() => {
    if (isJunk && activeView === 'routes') setActiveView('dashboard')
    if (!isLawn && activeView === 'employees') setActiveView('dashboard')
    if (!isLawn && activeView === 'timesheets') setActiveView('dashboard')
    if (isLawn && activeView === 'drivers') setActiveView('myday')
    if (!isLawn && activeView === 'myday') setActiveView('drivers')
    if (isTech && !TECH_IDS.includes(activeView)) setActiveView('dashboard')
    if (!myLines.includes(activeLine)) setActiveLine(myLines[0] || 'waste')
  }, [activeLine, activeView, isTech])

  const VIEW_META = {
    dashboard: ['Dispatch Overview', activeLineObj.name],
    routes: ['Routes & Dispatch', 'Live sequencing, GPS tracking and AI optimization'],
    schedule: isJunk ? ['Job Calendar', 'One-time junk jobs — click a day to schedule'] : ['Recurring Schedules', 'Set pickup cadence — nth weekday, alternating weeks'],
    invoices: ['Invoicing', 'Per-stop line items · monthly batch billing'],
    clients: ['Clients', 'Add and manage your customers'],
    import: ['Import Properties', 'Bulk-add service locations to a client'],
    activity: ['Activity Log', 'Everything you and Trashy Randy have done'],
    drivers: ['Drivers & Field', 'Check-in / check-out, photos and GPS'],
    myday: ['My Day', 'Your jobs — on my way, clock in, complete, photos'],
    myschedule: ['My Schedule', 'Week or month view of upcoming jobs'],
    timesheets: ['Time Sheets & Payroll', 'Your hours, jobs, and pay — weekly and monthly'],
    team: ['Team', 'Members and their business-line assignments'],
    portal: ['Client Portal', 'Search a client to preview their portal, copy their link, or send a quote'],
    settings: ['Settings', 'Manage tags and configuration'],
    annotations: ['Annotations', 'Admin notes flagged with the ✎ tool — review with Claude'],
    automations: ['Automations', 'Scheduled jobs Trashy Randy runs — plus his suggestions awaiting approval'],
    employees: ['Employees', 'Lawn jobs, per-job pay, overrides, and timesheets (Sun–Sat)'],
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
    // Instant local preview, then persist to storage + settings for everyone.
    const reader = new FileReader()
    reader.onload = () => setLogoSrc(reader.result)
    reader.readAsDataURL(file)
    saveLogoFile(file)
      .then((url) => { setLogoSrc(url); try { localStorage.setItem('vw_logo', url) } catch (e) {} })
      .catch((e) => console.error('logo upload failed:', e))
  }

  function startNewPickup() {
    go('routes')
    setNewPickupTick((t) => t + 1)
  }

  // bag passed to views
  const app = { activeLine, activeLineObj, go, openAssistant, askAi, runAi, isMobile, isTablet, user, newPickupTick }

  const views = {
    dashboard: <Dashboard app={app} />,
    routes: <RoutesView app={app} />,
    schedule: isJunk ? <JobCalendar app={app} line="junk" accent={activeLineObj.color} /> : <Schedule app={app} />,
    invoices: <Invoices app={app} />,
    clients: <Clients app={app} />,
    import: <Import app={app} />,
    activity: <Activity app={app} />,
    drivers: <Drivers app={app} />,
    myday: <MyDay app={app} />,
    myschedule: <TechSchedule app={app} />,
    timesheets: <TimeSheets app={app} />,
    portal: <Portal app={app} />,
    team: <Team app={app} />,
    settings: <Settings app={app} />,
    annotations: <Annotations app={app} />,
    automations: <Automations app={app} />,
    employees: <EmployeePay app={app} />,
  }

  const showInlineDock = aiOpen && !isMobile && !isTablet

  // Techs on mobile get their focused tabs in the bottom bar too.
  const bottomNav = isTech
    ? [
        { id: 'dashboard', glyph: '▦', label: 'Home' },
        { id: 'routes', glyph: '◔', label: 'Routes' },
        isLawn ? { id: 'myday', glyph: '☀', label: 'My Day' } : { id: 'drivers', glyph: '⛟', label: 'Field' },
        { id: 'myschedule', glyph: '▥', label: 'Schedule' },
        ...(isLawn ? [{ id: 'timesheets', glyph: '⏱', label: 'Pay' }] : []),
      ]
    : BOTTOM_NAV

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
              {visibleLines.map((bl) => (
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
        <NavGroup label="OPERATIONS" items={applyNavOrder(isTech ? techMain : navMain, navOrder.main)} activeView={activeView} onGo={go} onReorder={(ids) => saveNavOrder('main', ids)} />
        <NavGroup label={isTech ? 'MY WORK' : 'FIELD & CLIENTS'} items={applyNavOrder(isTech ? techField : (isAdmin ? [...navField, { id: 'annotations', glyph: '✎', label: 'Annotations' }] : navField), navOrder.field)} activeView={activeView} onGo={go} top={14} onReorder={(ids) => saveNavOrder('field', ids)} />
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
                <input value={commandText} onChange={(e) => setCommandText(e.target.value)} placeholder="Ask Trashy Randy — “what’s scheduled today?”…" style={{ width: '100%', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 10, padding: '9px 13px 9px 36px', fontSize: 16, color: '#1a2420', outline: 'none' }} />
                <div style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', fontFamily: MONO, fontSize: 10, color: '#9aa69e', border: '1px solid #e3e6e2', borderRadius: 5, padding: '2px 6px', pointerEvents: 'none' }}>⌘K</div>
              </form>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
            {isMobile && (
              <div onClick={openAssistant} style={{ width: 36, height: 36, borderRadius: 9, background: 'linear-gradient(135deg,#1f7a4d,#155e3a)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', fontSize: 15, flex: 'none' }}>✦</div>
            )}
            {isAdmin && (
              <div data-annot-ui onClick={() => setAnnotateMode((v) => !v)} title={annotateMode ? 'Annotation mode is ON — click to turn off' : 'Annotate: flag an element with a note'} style={{ position: 'relative', width: 36, height: 36, borderRadius: 9, border: `1px solid ${annotateMode ? '#1f7a4d' : '#e3e6e2'}`, background: annotateMode ? '#1f7a4d' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: annotateMode ? '#fff' : '#5d6b63', flex: 'none' }}>
                <span style={{ fontSize: 15 }}>✎</span>
              </div>
            )}
            {!isMobile && (
              <button onClick={startNewPickup} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
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
            {bottomNav.map((n) => {
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

      {isAdmin && (
        <AnnotationLayer
          active={annotateMode}
          viewName={activeView}
          viewTitle={viewTitle}
          onClose={() => setAnnotateMode(false)}
          onSaved={() => {}}
        />
      )}
    </div>
  )
}

function NavGroup({ label, items, activeView, onGo, top = 0, onReorder }) {
  // Drag-to-reorder within the group (desktop; order saved by the parent).
  const [dragId, setDragId] = useState(null)
  const [overId, setOverId] = useState(null)

  function drop(targetId) {
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); return }
    const ids = items.map((x) => x.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) { setDragId(null); setOverId(null); return }
    ids.splice(from, 1)
    ids.splice(to, 0, dragId)
    onReorder && onReorder(ids)
    setDragId(null)
    setOverId(null)
  }

  return (
    <>
      <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '.16em', color: '#4f6357', padding: `${8 + top}px 8px 6px` }}>{label}</div>
      {items.map((n) => {
        const active = activeView === n.id
        const dragging = dragId === n.id
        const over = overId === n.id && dragId && dragId !== n.id
        return (
          <div
            key={n.id}
            onClick={() => onGo(n.id)}
            draggable={!!onReorder}
            title={onReorder ? 'Drag to reorder' : undefined}
            onDragStart={(e) => { setDragId(n.id); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.id) } catch (err) {} }}
            onDragOver={(e) => { if (dragId && dragId !== n.id) { e.preventDefault(); setOverId(n.id) } }}
            onDragLeave={() => { if (overId === n.id) setOverId(null) }}
            onDrop={(e) => { e.preventDefault(); drop(n.id) }}
            onDragEnd={() => { setDragId(null); setOverId(null) }}
            style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2, fontWeight: active ? 600 : 500, color: active ? '#f3f7f4' : '#9fb3a8', background: active ? '#22332b' : 'transparent', opacity: dragging ? 0.45 : 1, boxShadow: over ? 'inset 0 2px 0 #46c585' : 'none' }}
          >
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
