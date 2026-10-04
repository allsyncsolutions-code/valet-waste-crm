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
//
// NOTE: the iframe fields are SINGLE-USE. After any tokenize() call (success,
// decline, or empty read) Runner masks and consumes what was typed, so every
// later tokenize returns {"account_token":"","expiry":"","bank_account":null,
// "risk_info":null,"card_info":{}} while the form still LOOKS filled. There
// is no reset() API — callers must remount the container element and re-init
// a fresh Runner before the next attempt (see resetCardForm in PayPage etc).
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

// ACH (bank account) payment method availability.
//
// BLOCKED 2026-10-04: the ValetWaste MID (496647545888) is configured card-only
// on Run's side — Runner.js resolves merchant_type_id=1 for our public key and
// renders the CARD tokenizer even for method 'ach' (verified against a local
// harness: the injected iframe is cardconnect's itoke/ajax-tokenizer.html, and
// an ACH /charge returns a bare 400 while a card /charge processes normally).
// Run (integrations@runpayments.io / Francesca) must enable ACH on the MID (or
// issue an ACH-enabled MID + public key). Once they confirm, flip this to true:
// the ACH branch in initRunnerForm + the charge_invoice 'ach' path are already
// built and deployed. When enabled, also add native Account type + Account
// holder fields per the iStream docs (accountTypeField/customerNameField).
export const ACH_ENABLED = false

// Init a Runner.js form for the requested method. 'card' renders the usual
// card number/expiry/CVV iframe fields; 'ach' renders bank-account fields
// (account/routing/confirm + account type + holder name) per Run's docs:
// https://docs.runpayments.io/docs/guides/tokenization/runner-js (ACH section).
export function initRunnerForm(Runner, { element, publicKey, mid, env, method }) {
  const r = new Runner()
  if (method === 'ach') {
    r.init({
      element,
      publicKey,
      mid,
      env,
      accountNumberLabel: 'Account number',
      routingNumberLabel: 'Routing number',
      repeatedAccountNumberLabel: 'Confirm account number',
      accountTypeLabel: 'Account type',
      customerNameLabel: 'Account holder name',
      entryClassCodeLabel: 'Entry class',
      errorType: 'field',
    })
  } else {
    r.init({ element, publicKey, mid, env, useExpiry: true, useCvv: true })
  }
  return r
}
