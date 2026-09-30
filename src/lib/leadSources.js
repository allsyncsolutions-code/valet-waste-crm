// Lead sources — where a customer came from. Stored on customers.lead_source
// as the value; labels render in the UI. 'web_form' is set automatically by
// the public signup page (portal fn public_signup) — don't reuse it for
// anything else. NULL/unknown rows show as "Not set" in reports.
export const LEAD_SOURCES = [
  { value: 'web_form', label: 'Web Form' },
  { value: 'website', label: 'Website' },
  { value: 'google', label: 'Google Search' },
  { value: 'facebook', label: 'Facebook / Instagram' },
  { value: 'referral', label: 'Referral' },
  { value: 'property_manager', label: 'Property Manager' },
  { value: 'flyer', label: 'Flyer / Door Hanger' },
  { value: 'phone', label: 'Phone Call' },
  { value: 'other', label: 'Other' },
]

export const leadSourceLabel = (v) =>
  LEAD_SOURCES.find((s) => s.value === v)?.label || (v ? String(v) : 'Not set')
