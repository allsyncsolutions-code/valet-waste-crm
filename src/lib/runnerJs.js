// Loads the Run Payments Runner.js tokenization library once and resolves with
// the global `Runner` constructor. Runner.js renders card fields inside an
// iframe it owns, so the PAN never reaches our server or the edge function —
// only the resulting account_token + expiry do.
//
// Docs: https://docs.runpayments.io/docs/guides/tokenization/runner-js
const RUNNER_SRC = 'https://javelin.runpayments.io/javascripts/1.5.5/runner.js'

let loader = null
export function loadRunner() {
  if (loader) return loader
  loader = new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.Runner) return resolve(window.Runner)
    const s = document.createElement('script')
    s.src = RUNNER_SRC
    s.async = true
    s.onload = () => (window.Runner ? resolve(window.Runner) : reject(new Error('Runner.js failed to initialize.')))
    s.onerror = () => reject(new Error('Could not load the Run Payments card form. Check your connection and try again.'))
    document.head.appendChild(s)
  })
  return loader
}

// Tokenize with the CardPointe iframe quirk handled: Runner debounces its
// field state, so a tokenize() fired the instant our button is clicked (which
// blurs the iframe) can read the fields as empty. Wait for the debounce to
// settle, and retry once — only then is an empty result a real "incomplete".
export async function tokenizeCard(runner, { settleMs = 800, retryMs = 1200 } = {}) {
  const once = () => new Promise((resolve) => runner.tokenize(resolve))
  await new Promise((r) => setTimeout(r, settleMs))
  let res = await once()
  if (!res || (!res.account_token && !res.token)) {
    await new Promise((r) => setTimeout(r, retryMs))
    res = await once()
  }
  return res
}
