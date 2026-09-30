// Web Forms tab — manage the public signup page(s) (/?signup=<slug>): edit
// name/intro/pricing/terms, publish or unpublish, duplicate, delete, and copy
// the share link or embed snippet. All staff can view + copy links; only
// admins can change forms (same convention as Team).
import { useEffect, useState } from 'react'
import { loadWebForms, saveWebForm, duplicateWebForm, deleteWebForm } from '../lib/webFormsData.js'

const GREEN = '#1f7a4d'
const RED = '#c0492f'

export default function WebForms({ app }) {
  const me = app.user || {}
  const isAdmin = me.role === 'admin'
  const origin = window.location.origin

  const [forms, setForms] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [editing, setEditing] = useState(null) // null | 'new' | form row
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try { setForms(await loadWebForms()) } catch (e) { setErr(e.message || String(e)) }
  }
  useEffect(() => { refresh() }, [])

  function flash(text) { setMsg(text); setTimeout(() => setMsg(''), 2500) }

  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); flash(`${label} copied`) }
    catch { setErr('Copy failed — select and copy manually.') }
  }

  const linkFor = (slug) => `${origin}/?signup=${slug}`
  const embedFor = (f) =>
    `<iframe src="${linkFor(f.slug)}" style="width:100%;max-width:600px;height:1000px;border:0;" loading="lazy" title="${String(f.name).replace(/"/g, '&quot;')}"></iframe>`

  async function toggleActive(f) {
    if (!isAdmin) return
    setBusy(true)
    try {
      await saveWebForm({ ...f, active: !f.active })
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  async function onDuplicate(f) {
    if (!isAdmin) return
    setBusy(true)
    try {
      await duplicateWebForm(f)
      await refresh()
      flash('Form duplicated')
    } catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  async function onDelete(f) {
    if (!isAdmin) return
    if (!window.confirm(`Delete "${f.name}"? The public link stops working immediately. Past signups are not affected.`)) return
    setBusy(true)
    try {
      await deleteWebForm(f.id)
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  const inp = { width: '100%', padding: '9px 11px', borderRadius: 8, border: '1.5px solid #d5dcd6', fontSize: 14, boxSizing: 'border-box' }
  const label = { display: 'block', fontSize: 12, fontWeight: 700, color: '#4c5a51', margin: '0 0 4px' }
  const btn = (color = GREEN) => ({ background: 'none', border: `1.5px solid ${color}`, color, borderRadius: 8, padding: '6px 11px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' })

  if (editing) return (
    <Editor
      form={editing === 'new' ? null : editing}
      busy={busy}
      onCancel={() => setEditing(null)}
      onSaved={async () => { setEditing(null); await refresh(); flash('Form saved') }}
      onError={(e) => setErr(e.message || String(e))}
      setBusy={setBusy}
    />
  )

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '18px 16px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 19, fontWeight: 800 }}>Web Forms</div>
          <div style={{ fontSize: 13, color: '#7c8a82' }}>
            Public signup pages — share the link or embed them on a website. Submissions text every admin and land in the Dashboard awaiting-placement queue.
          </div>
        </div>
        {isAdmin && <button type="button" onClick={() => setEditing('new')} style={{ ...btn(), background: GREEN, color: '#fff', padding: '8px 14px' }}>+ New form</button>}
      </div>

      {err && <div style={{ background: '#fdecea', border: '1px solid #f5c6c0', color: '#a02c22', borderRadius: 10, padding: '10px 13px', fontSize: 13.5, marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ background: '#e8f5ec', border: '1px solid #bfe3cc', color: '#1f7a4d', borderRadius: 10, padding: '10px 13px', fontSize: 13.5, marginBottom: 12 }}>{msg}</div>}

      {forms === null && <div style={{ color: '#7c8a82', fontSize: 14 }}>Loading…</div>}
      {forms && forms.length === 0 && <div style={{ color: '#7c8a82', fontSize: 14 }}>No forms yet.</div>}

      {forms && forms.map((f) => {
        const items = Array.isArray(f.config?.line_items) ? f.config.line_items : []
        const p = f.config?.pricing || {}
        const pricingTxt = [
          p.one_pickup != null ? `1x/wk $${Number(p.one_pickup).toFixed(2)}` : null,
          p.two_pickup != null ? `2x/wk $${Number(p.two_pickup).toFixed(2)}` : null,
          'On-Demand: varies',
        ].filter(Boolean).join(' · ')
        const extraTxt = items.map((li) => `${li.description}${li.price != null ? ` ($${Number(li.price).toFixed(2)})` : ''}`).join(' · ')
        return (
          <div key={f.id} style={{ background: '#fff', borderRadius: 12, padding: '15px 16px', marginBottom: 12, boxShadow: '0 1px 4px rgba(20,30,24,.07)', opacity: f.active ? 1 : 0.65 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <span style={{ fontSize: 15.5, fontWeight: 800 }}>{f.name}</span>{' '}
                <span style={{ fontSize: 12, fontWeight: 700, color: f.active ? GREEN : '#9aa69e' }}>{f.active ? '● LIVE' : '○ unpublished'}</span>
                {f.slug === 'default' && <span style={{ fontSize: 11.5, color: '#9aa69e' }}> — the /?signup=1 default</span>}
                <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3 }}>
                  {pricingTxt}{extraTxt ? ` · ${extraTxt}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <a href={linkFor(f.slug)} target="_blank" rel="noreferrer" style={{ ...btn('#4c5a51'), textDecoration: 'none' }}>Open</a>
                <button type="button" onClick={() => copyText(linkFor(f.slug), 'Link')} style={btn()}>Copy link</button>
                <button type="button" onClick={() => copyText(embedFor(f), 'Embed code')} style={btn()}>Embed</button>
                {isAdmin && (
                  <>
                    <button type="button" onClick={() => setEditing(f)} style={btn()}>Edit</button>
                    <button type="button" disabled={busy} onClick={() => onDuplicate(f)} style={btn()}>Copy</button>
                    <button type="button" disabled={busy} onClick={() => toggleActive(f)} style={btn(f.active ? '#b8860b' : GREEN)}>{f.active ? 'Unpublish' : 'Publish'}</button>
                    <button type="button" disabled={busy} onClick={() => onDelete(f)} style={btn(RED)}>Delete</button>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })}

      {!isAdmin && <div style={{ fontSize: 12.5, color: '#9aa69e', marginTop: 6 }}>Viewing only — only admins can change forms (same as Team).</div>}
    </div>
  )
}

function Editor({ form, busy, setBusy, onCancel, onSaved, onError }) {
  const [name, setName] = useState(form?.name || '')
  const [intro, setIntro] = useState(form?.config?.intro || '')
  const [price1, setPrice1] = useState(form?.config?.pricing?.one_pickup ?? '')
  const [price2, setPrice2] = useState(form?.config?.pricing?.two_pickup ?? '')
  const [onDemandNote, setOnDemandNote] = useState(form?.config?.pricing?.on_demand_note || 'Varies by location and date requested — we’ll reach out after you submit.')
  const [items, setItems] = useState(
    Array.isArray(form?.config?.line_items) && form.config.line_items.length
      ? form.config.line_items.map((li) => ({ description: li.description || '', price: li.price ?? '' }))
      : [{ description: '', price: '' }],
  )
  const [totalLabel, setTotalLabel] = useState(form?.config?.total_label || '')
  const [terms, setTerms] = useState(form?.config?.terms || '')
  const [active, setActive] = useState(form ? !!form.active : true)

  const inp = { width: '100%', padding: '9px 11px', borderRadius: 8, border: '1.5px solid #d5dcd6', fontSize: 14, boxSizing: 'border-box' }
  const label = { display: 'block', fontSize: 12, fontWeight: 700, color: '#4c5a51', margin: '0 0 4px' }

  async function save() {
    setBusy(true)
    try {
      await saveWebForm({
        id: form?.id,
        name,
        active,
        config: {
          intro,
          pricing: { one_pickup: price1, two_pickup: price2, on_demand_note: onDemandNote },
          line_items: items.map((li) => ({ description: li.description, price: li.price === '' ? null : Number(li.price) })),
          total_label: totalLabel,
          terms,
        },
      })
      onSaved()
    } catch (e) { onError(e) }
    setBusy(false)
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '18px 16px 60px' }}>
      <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 14 }}>{form ? `Edit "${form.name}"` : 'New web form'}</div>
      <div style={{ background: '#fff', borderRadius: 12, padding: '16px', boxShadow: '0 1px 4px rgba(20,30,24,.07)' }}>
        <div style={{ marginBottom: 12 }}>
          <label style={label}>Form name (internal — customers don't see it in the page title)</label>
          <input style={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard signup, Promo — $25 off" />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={label}>Intro line (subtitle under the logo)</label>
          <input style={inp} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="Residential valet trash signup" />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={label}>Schedule pricing (weekly service)</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <label style={{ ...label, fontWeight: 400 }}>1 pickup / week ($)</label>
              <input style={inp} type="number" min="0" step="0.01" value={price1} onChange={(e) => setPrice1(e.target.value)} placeholder="15.00" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ ...label, fontWeight: 400 }}>2 pickups / week ($)</label>
              <input style={inp} type="number" min="0" step="0.01" value={price2} onChange={(e) => setPrice2(e.target.value)} placeholder="25.00" />
            </div>
          </div>
          <label style={{ ...label, fontWeight: 400 }}>On-Demand note (shown instead of a price)</label>
          <input style={inp} value={onDemandNote} onChange={(e) => setOnDemandNote(e.target.value)} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={label}>Extra line items (optional — fuel surcharge, carry-out, promos…)</label>
          {items.map((li, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input style={{ ...inp, flex: 2 }} value={li.description} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} placeholder="e.g. Weekly valet trash service" />
              <input style={{ ...inp, flex: 1 }} type="number" min="0" step="0.01" value={li.price} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} placeholder="Price $" />
              <button type="button" onClick={() => setItems(items.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: RED, fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>×</button>
            </div>
          ))}
          <button type="button" onClick={() => setItems([...items, { description: '', price: '' }])} style={{ background: 'none', border: 'none', color: GREEN, fontSize: 13, fontWeight: 700, cursor: 'pointer', padding: '4px 0' }}>+ Add line</button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={label}>Total label (optional, e.g. "per month")</label>
          <input style={inp} value={totalLabel} onChange={(e) => setTotalLabel(e.target.value)} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={label}>Agreement text (shown next to the Approve button — this is the contract)</label>
          <textarea style={{ ...inp, minHeight: 90, resize: 'vertical' }} value={terms} onChange={(e) => setTerms(e.target.value)} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ width: 17, height: 17 }} />
          Published (people can sign up with the link)
        </label>
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" disabled={busy || !name.trim()} onClick={save} style={{ flex: 1, padding: '12px', borderRadius: 10, border: 'none', background: GREEN, color: '#fff', fontSize: 15, fontWeight: 800, cursor: 'pointer', opacity: busy || !name.trim() ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save form'}</button>
          <button type="button" onClick={onCancel} style={{ padding: '12px 18px', borderRadius: 10, border: '1.5px solid #d5dcd6', background: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
