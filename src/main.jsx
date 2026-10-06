import React from 'react'
import { createRoot } from 'react-dom/client'
import AuthGate from './AuthGate.jsx'
import PortalPage from './portal/PortalPage.jsx'
import PayPage from './portal/PayPage.jsx'
import SignupPage from './portal/SignupPage.jsx'
import BulkSignupPage from './portal/BulkSignupPage.jsx'

// Customer-portal links (…/?portal=<slug>[&code=…]) bypass the staff AuthGate
// entirely — clients authenticate with an emailed magic link instead.
// ?share=<token> is the read-only homeowner view (no login, no billing).
// ?portal=<slug>&pay_invoice=<id> is a STANDALONE pay page: no portal chrome,
// no sign-in — just that one invoice and a card form (PayPage).
// ?login=client is the generic public login (no per-client slug) — the link
// to put on the marketing website: email → 6-digit code → their portal.
// ?signup=1 is the public web signup (Trashbolt-style agreement → Approve):
// no login, creates the customer + property and texts admins.
// ?signup=bulk is the property-manager bulk intake: contact + billing → CSV
// upload of many service addresses (accept/reject preview) → one optional
// card for the batch → Approve creates one customer + a needs_review property
// per accepted address.
const params = new URLSearchParams(window.location.search)
const portalSlug = params.get('portal')
const shareToken = params.get('share')
const clientLogin = params.get('login') === 'client'
const signupSlug = params.get('signup')
const publicSignup = params.has('signup')
// A magic-link login (?code=…) still goes through the full portal flow even
// if pay_invoice is present — the code must be redeemed for a session there.
const payInvoice = params.get('code') ? null : params.get('pay_invoice')

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {portalSlug && payInvoice ? (
      <PayPage slug={portalSlug} invoiceId={payInvoice} />
    ) : portalSlug || shareToken ? (
      <PortalPage slug={portalSlug} code={params.get('code')} shareToken={shareToken} />
    ) : publicSignup ? (
      String(signupSlug).toLowerCase() === 'bulk' ? <BulkSignupPage /> : <SignupPage slug={signupSlug} />
    ) : clientLogin ? (
      <PortalPage publicLogin />
    ) : (
      <AuthGate />
    )}
  </React.StrictMode>
)
