// Lightweight rich text for invoices. Formatting is a markdown subset stored
// as plain text (**bold**, *italic*, __underline__, "- " bullets, blank-line
// paragraphs) so the mobile app — which can't get a renderer over-the-air —
// still shows readable text. `RichText` renders it; `RichTextEditor` edits it
// with a B/I/U/bullet toolbar that wraps the current selection.
import { useRef } from 'react'

// Parse inline **bold** / *italic* / __underline__ into styled spans.
// Underline uses __ so *italic* stays single-asterisk and unambiguous.
export function renderInline(text, key = '') {
  const parts = []
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*)/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) parts.push(<b key={`${key}-b${i}`}>{tok.slice(2, -2)}</b>)
    else if (tok.startsWith('__')) parts.push(<u key={`${key}-u${i}`}>{tok.slice(2, -2)}</u>)
    else parts.push(<i key={`${key}-i${i}`}>{tok.slice(1, -1)}</i>)
    last = m.index + tok.length
    i++
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

// Render a whole block: consecutive "- " lines become a bulleted list,
// other lines become paragraphs (line breaks kept inside a paragraph).
export function RichText({ text, style }) {
  const src = String(text || '').trim()
  if (!src) return null
  const blocks = []
  let bullets = []
  const flushBullets = (k) => {
    if (!bullets.length) return
    blocks.push(
      <ul key={`ul${k}`} style={{ margin: '4px 0', paddingLeft: 20, ...style }}>
        {bullets.map((b, j) => <li key={j} style={{ marginBottom: 2 }}>{renderInline(b, `li${k}-${j}`)}</li>)}
      </ul>,
    )
    bullets = []
  }
  src.split(/\n/).forEach((line, k) => {
    const bm = line.match(/^\s*[-•]\s+(.*)$/)
    if (bm) { bullets.push(bm[1]); return }
    flushBullets(k)
    if (line.trim()) {
      blocks.push(
        <div key={`p${k}`} style={{ marginBottom: 4, ...style }}>{renderInline(line, `p${k}`)}</div>,
      )
    }
  })
  flushBullets('end')
  return <div>{blocks}</div>
}

// Toolbar-driven markdown editor. `rows` shrinks it for inline use (line-item
// descriptions); the toolbar buttons wrap the textarea's current selection.
export function RichTextEditor({ value, onChange, placeholder, rows = 4, style }) {
  const ref = useRef(null)

  function applyWrap(before, after = before) {
    const ta = ref.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e } = ta
    const sel = value.slice(s, e)
    const next = value.slice(0, s) + before + (sel || 'text') + after + value.slice(e)
    onChange(next)
    // restore focus + selection after React re-renders the new value
    requestAnimationFrame(() => {
      ta.focus()
      const inner = sel || 'text'
      ta.setSelectionRange(s + before.length, s + before.length + inner.length)
    })
  }

  function applyBullet() {
    const ta = ref.current
    if (!ta) return
    const { selectionStart: s } = ta
    const lineStart = value.lastIndexOf('\n', s - 1) + 1
    if (value.slice(lineStart, lineStart + 2) === '- ') {
      // already bulleted — remove it
      const next = value.slice(0, lineStart) + value.slice(lineStart + 2)
      onChange(next)
      requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(Math.max(0, s - 2), Math.max(0, s - 2)) })
    } else {
      const next = value.slice(0, lineStart) + '- ' + value.slice(lineStart)
      onChange(next)
      requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(s + 2, s + 2) })
    }
  }

  const btn = { background: '#fff', border: '1px solid #dde2dd', borderRadius: 6, minWidth: 26, height: 24, fontSize: 12.5, cursor: 'pointer', color: '#3c4a42', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }

  return (
    <div style={{ ...style }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        <button type="button" onClick={() => applyWrap('**')} style={{ ...btn, fontWeight: 800 }} title="Bold">B</button>
        <button type="button" onClick={() => applyWrap('*')} style={{ ...btn, fontStyle: 'italic', fontFamily: 'Georgia, serif' }} title="Italic">I</button>
        <button type="button" onClick={() => applyWrap('__')} style={{ ...btn, textDecoration: 'underline' }} title="Underline">U</button>
        <button type="button" onClick={applyBullet} style={{ ...btn }} title="Bulleted list">• List</button>
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{ width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }}
      />
    </div>
  )
}
