import React from 'react'
import { createRoot } from 'react-dom/client'
import AuthGate from './AuthGate.jsx'
import PortalPage from './portal/PortalPage.jsx'

// Customer-portal links (…/?portal=<slug>[&code=…]) bypass the staff AuthGate
// entirely — clients authenticate with an emailed magic link instead.
const params = new URLSearchParams(window.location.search)
const portalSlug = params.get('portal')

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {portalSlug ? <PortalPage slug={portalSlug} code={params.get('code')} /> : <AuthGate />}
  </React.StrictMode>
)
