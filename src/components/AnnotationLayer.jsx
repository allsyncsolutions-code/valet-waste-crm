import { useEffect, useRef, useState } from 'react'
import { createAnnotation } from '../lib/annotationsData.js'

// Admin annotation mode. While active, hovering highlights the element under the
// cursor; clicking one freezes it and opens a note box. The note + a readable
// reference to the element are saved for review on the Annotations screen.
//
// Our own UI (banner, highlight, note card) is tagged data-annot-ui so clicks on
// it are ignored by the element picker.
export default function AnnotationLayer({ active, viewName, viewTitle, onClose, onSaved }) {
  const [rect, setRect] = useState(null)        // hovered element box
  const [picked, setPicked] = useState(null)    // { rect, label, selector }
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')
  const pickedRef = useRef(false)

  const isOurUi = (el) => !!(el && el.closest && el.closest('[data-annot-ui]'))

  // Readable label for the clicked element.
  function labelFor(el) {
    const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
    if (t) return t.slice(0, 120)
    return el.getAttribute?.('aria-label') || el.getAttribute?.('title') ||
      el.getAttribute?.('placeholder') || el.tagName.toLowerCase()
  }
  // Best-effort CSS path (a few levels) for later reference.
  function selectorFor(el) {
    const parts = []
    let node = el
    for (let i = 0; node && node.nodeType === 1 && i < 4; i++) {
      let part = node.tagName.toLowerCase()
      if (node.id) { part += `#${node.id}`; parts.unshift(part); break }
      const parent = node.parentElement
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName)
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  useEffect(() => {
    if (!active) { setRect(null); setPicked(null); setNote(''); setErr(''); pickedRef.current = false; return }

    const onMove = (e) => {
      if (pickedRef.current) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (!el || isOurUi(el)) { setRect(null); return }
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    const onClick = (e) => {
      const el = e.target
      if (isOurUi(el)) return            // let our own UI work normally
      e.preventDefault(); e.stopPropagation()
      const node = document.elementFromPoint(e.clientX, e.clientY) || el
      if (!node || isOurUi(node)) return
      const r = node.getBoundingClientRect()
      pickedRef.current = true
      setPicked({
        rect: { top: r.top, left: r.left, width: r.width, height: r.height },
        label: labelFor(node),
        selector: selectorFor(node),
      })
      setNote(''); setErr('')
    }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [active])

  function cancelPick() {
    setPicked(null); setNote(''); setErr(''); pickedRef.current = false
  }

  async function save() {
    if (busy) return
    if (!note.trim()) { setErr('Add a quick note about what is wrong.'); return }
    setBusy(true); setErr('')
    try {
      await createAnnotation({
        view: viewName,
        viewTitle,
        targetLabel: picked?.label,
        targetSelector: picked?.selector,
        note: note.trim(),
        pagePath: typeof location !== 'undefined' ? location.pathname : null,
      })
      cancelPick()
      setToast('Annotation saved')
      setTimeout(() => setToast(''), 2200)
      onSaved && onSaved()
    } catch (e) {
      setErr((e && e.message) || String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!active) return null

  const hl = picked?.rect || rect
  // Position the note card near the picked element, kept on-screen.
  const cardTop = picked ? Math.min(picked.rect.top + picked.rect.height + 8, (window.innerHeight - 230)) : 0
  const cardLeft = picked ? Math.min(Math.max(8, picked.rect.left), (window.innerWidth - 332)) : 0

  return (
    <>
      {/* mode banner */}
      <div data-annot-ui style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 4000, background: '#15281d', color: '#fff', borderRadius: 10, padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 6px 22px rgba(0,0,0,.25)', fontSize: 13 }}>
        <span>✎ Annotation mode — click any element to flag it</span>
        <button onClick={onClose} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 7, padding: '5px 11px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Done</button>
      </div>

      {/* highlight box */}
      {hl && (
        <div style={{ position: 'fixed', top: hl.top, left: hl.left, width: hl.width, height: hl.height, border: '2px solid #c0492f', background: 'rgba(192,73,47,.10)', borderRadius: 4, zIndex: 3990, pointerEvents: 'none', boxSizing: 'border-box' }} />
      )}

      {/* note card */}
      {picked && (
        <div data-annot-ui style={{ position: 'fixed', top: cardTop, left: cardLeft, width: 324, zIndex: 4010, background: '#fff', border: '1px solid #e3e6e2', borderRadius: 12, boxShadow: '0 10px 32px rgba(0,0,0,.22)', padding: 14 }}>
          <div style={{ fontSize: 11, color: '#7c8a82', marginBottom: 6 }}>Flagging on <b>{viewTitle}</b>:</div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1a2420', marginBottom: 10, maxHeight: 54, overflow: 'hidden' }}>“{picked.label}”</div>
          <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={3}
            placeholder="What's wrong / what should change?"
            style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #dde2dd', borderRadius: 9, padding: '9px 11px', fontSize: 13.5, outline: 'none', resize: 'vertical' }} />
          {err && <div style={{ color: '#c0492f', fontSize: 12, marginTop: 6 }}>{err}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button onClick={cancelPick} disabled={busy} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save note'}</button>
          </div>
        </div>
      )}

      {toast && (
        <div data-annot-ui style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 4010, background: '#1f7a4d', color: '#fff', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 600, boxShadow: '0 6px 22px rgba(0,0,0,.25)' }}>{toast}</div>
      )}
    </>
  )
}
