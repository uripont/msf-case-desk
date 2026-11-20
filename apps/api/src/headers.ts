// NOTE: every response of the Worker, assets and API alike, carries
// `Referrer-Policy: no-referrer` (D13), so a page that was opened from a link
// never tells another site where the person came from. Response headers can be
// immutable (assets), so the response is copied.
const REFERRER_POLICY = 'no-referrer'

export const withReferrerPolicy = (response: Response): Response => {
  if (response.headers.get('referrer-policy') === REFERRER_POLICY) {
    return response
  }
  const headers = new Headers(response.headers)
  headers.set('referrer-policy', REFERRER_POLICY)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
