// Print just the marked invoice document (.print-doc — see the print styles
// in index.html). Used by the staff invoice detail, the portal pay page and
// the client portal's invoice rows: browsers offer "Save as PDF" in the
// dialog, which is how customers + staff download invoices as PDFs.
//
// The `printing` class is only present WHILE printing, so a normal Ctrl+P
// anywhere else in the app is untouched. The tab title is swapped first so
// the saved file defaults to "Invoice <number>.pdf".
export function printInvoiceDoc(label) {
  const prevTitle = document.title
  document.title = `Invoice ${label || ''}`.trim()
  document.body.classList.add('printing')
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    document.title = prevTitle
    document.body.classList.remove('printing')
    window.removeEventListener('afterprint', restore)
  }
  window.addEventListener('afterprint', restore)
  window.print()
  setTimeout(restore, 60_000) // afterprint isn't fired everywhere
}

// One-click download of the same document as a real PDF — no print dialog.
// Rasterizes the .print-doc node with html2canvas (screen styles; the
// body.pdf-capturing class hides .print-hide action buttons — see index.html)
// and saves through jsPDF. Photo <img>s come from the public Supabase bucket,
// which serves CORS headers, so useCORS keeps them in the snapshot; a photo
// that still fails to load is skipped by html2canvas rather than aborting.
export async function downloadInvoicePdf(label) {
  const el = document.querySelector('.print-doc')
  if (!el) throw new Error('Open an invoice first — nothing to download.')
  document.body.classList.add('pdf-capturing')
  try {
    const html2pdf = (await import('html2pdf.js')).default
    await html2pdf()
      .set({
        margin: [10, 10, 12, 10],
        filename: `Invoice ${label || ''}`.trim(),
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
        jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      })
      .from(el)
      .save()
  } finally {
    document.body.classList.remove('pdf-capturing')
  }
}
