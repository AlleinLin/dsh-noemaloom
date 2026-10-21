export function qualityQuery(review: boolean, tab: string) {
  if (tab === 'workflow' && !review) return { domain: 'quality', action: 'lifecycle/status', params: {} };
  if (tab === 'rules') return review
    ? { domain: 'scope', action: 'settings', params: { feature: 'review' } }
    : { domain: 'quality', action: 'catalog', params: {} };
  if (tab === 'coverage') return review
    ? { domain: 'review', action: 'report', params: {} }
    : { domain: 'quality', action: 'evidence', params: { operation: 'list' } };
  return { domain: review ? 'review' : 'quality', action: 'status', params: {} };
}
