import React from 'react'
import { createRoot } from 'react-dom/client'
import AuthGate from './AuthGate.jsx'
import PortalPage from './portal/PortalPage.jsx'

// Customer-portal links (…/?portal=<slug>[&code=…]) bypass the staff AuthGate
// entirely — clients authenticate with an emailed magic link instead.
// ?share=<token> is the read-only homeowner view (no login, no billing).
const params = new URLSearchParams(window.location.search)
const portalSlug = params.get('portal')
const shareToken = params.get('share')

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {portalSlug || shareToken ? <PortalPage slug={portalSlug} code={params.get('code')} shareToken={shareToken} /> : <AuthGate />}
  </React.StrictMode>
)
