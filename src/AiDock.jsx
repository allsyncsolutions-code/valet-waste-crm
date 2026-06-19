import { MONO } from './data.js'

const PALETTE = {
  user: ['#1f7a4d', '#fff', 'none', 'flex-end'],
  ai: ['#f1f4f1', '#1a2420', '1px solid #e6eae6', 'flex-start'],
}

const CHIPS = [
  { label: 'Optimize Route B', msg: 'Optimize Route B for me' },
  { label: 'Bill this month', msg: 'Set up monthly batch billing for Northgate' },
  { label: 'New recurring stop', msg: 'Create a recurring pickup every 1st & 3rd Monday' },
]

export default function AiDock({ inline, mobile, aiMessages, aiBusy, aiInput, setAiInput, onSubmit, onClose, onConfirm, onDismiss, onChip, scrollRef }) {
  const containerStyle = inline
    ? { width: 392, flex: 'none', background: '#fff', borderLeft: '1px solid #e3e6e2', display: 'flex', flexDirection: 'column', boxShadow: '-18px 0 40px rgba(20,40,30,.06)', height: '100%' }
    : mobile
    ? { position: 'fixed', left: 0, right: 0, bottom: 0, top: 0, background: '#fff', display: 'flex', flexDirection: 'column', zIndex: 410, animation: 'sheetUp .2s ease' }
    : { position: 'fixed', top: 0, right: 0, bottom: 0, width: 392, maxWidth: '92vw', background: '#fff', borderLeft: '1px solid #e3e6e2', display: 'flex', flexDirection: 'column', boxShadow: '-18px 0 40px rgba(20,40,30,.16)', zIndex: 410, animation: 'slideIn .18s ease' }

  return (
    <div style={containerStyle}>
      <div style={{ padding: '15px 16px', borderBottom: '1px solid #eef0ed', display: 'flex', alignItems: 'center', gap: 11, flex: 'none', paddingTop: mobile ? 'calc(15px + env(safe-area-inset-top))' : 15 }}>
        <div style={{ width: 30, height: 30, borderRadius: 9, background: 'linear-gradient(135deg,#1f7a4d,#155e3a)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, flex: 'none' }}>✦</div>
        <div style={{ flex: 1, lineHeight: 1.25 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Trashy Randy</div>
          <div style={{ fontSize: 11, color: '#1f7a4d', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22b06b', display: 'inline-block' }} />
            {aiBusy ? 'Working…' : 'Online · claude'}
          </div>
        </div>
        <div onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#7c8a82', fontSize: 16 }}>✕</div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {aiMessages.map((m, i) => {
          const p = m.role === 'user' ? PALETTE.user : PALETTE.ai
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: p[3], gap: 6 }}>
              <div style={{ maxWidth: '90%', background: m.done ? '#eef7f1' : p[0], color: p[1], border: m.done ? '1px solid #d6e7dd' : p[2], borderRadius: 13, padding: '10px 13px', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.text}</div>
              {!!m.action && (
                <div style={{ width: '90%', border: '1px solid #d6e7dd', background: '#f3faf5', borderRadius: 11, padding: '11px 13px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                    <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '.12em', color: '#1f7a4d', background: '#dcefe3', padding: '2px 7px', borderRadius: 5 }}>PROPOSED ACTION</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#15281d', marginBottom: 10 }}>{m.action}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => onConfirm(i)} style={{ flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 8, padding: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Approve &amp; run</button>
                    <button onClick={onDismiss} style={{ background: '#fff', border: '1px solid #d2dcd6', color: '#5d6b63', borderRadius: 8, padding: '7px 12px', fontSize: 12, cursor: 'pointer' }}>Edit</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {aiBusy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#7c8a82', fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#1f7a4d', animation: 'blink 1s infinite' }} />
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#1f7a4d', animation: 'blink 1s infinite .2s' }} />
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#1f7a4d', animation: 'blink 1s infinite .4s' }} />
            <span style={{ marginLeft: 4 }}>Thinking…</span>
          </div>
        )}
      </div>

      <div style={{ padding: '10px 14px calc(10px + env(safe-area-inset-bottom))', borderTop: '1px solid #eef0ed', flex: 'none' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 9 }}>
          {CHIPS.map((c) => (
            <div key={c.label} onClick={() => onChip(c.msg)} style={{ fontSize: 11.5, color: '#2f5d44', background: '#eef5f0', border: '1px solid #dde9e1', borderRadius: 20, padding: '4px 10px', cursor: 'pointer' }}>{c.label}</div>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSubmit() }} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit() } }}
            rows={1}
            placeholder="Message Trashy Randy…"
            style={{ flex: 1, resize: 'none', border: '1px solid #dde2dd', borderRadius: 10, padding: '10px 12px', fontSize: 16, outline: 'none', maxHeight: 120, lineHeight: 1.4 }}
          />
          <button type="submit" style={{ width: 40, height: 40, flex: 'none', border: 'none', borderRadius: 10, background: '#1f7a4d', color: '#fff', fontSize: 16, cursor: 'pointer' }}>↑</button>
        </form>
      </div>
    </div>
  )
}
