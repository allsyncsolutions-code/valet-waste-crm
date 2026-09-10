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
