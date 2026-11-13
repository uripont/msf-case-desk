// NOTE: How an RPC handler sets the session cookie (D13): the token never
// travels in a response body, so the Worker sets or clears the cookie itself.
// `withSink` gives each request a private slot, named by an internal header
// that the app writes (and any copy sent by the client is overwritten); the
// handler puts the cookie in the slot, and the app appends it to the response.
// One isolate handles one request at a time per app, and the slot is removed
// when the response is made.

export const SINK_HEADER = 'x-quoroom-sink'

const sinks = new Map<string, Array<string>>()

export const setCookie = (
  headers: Readonly<Record<string, string | undefined>>,
  cookie: string,
): void => {
  const slot = sinks.get(headers[SINK_HEADER] ?? '')
  if (slot !== undefined) slot.push(cookie)
}

export const withSink = async (
  request: Request,
  handle: (request: Request) => Promise<Response>,
): Promise<Response> => {
  const id = crypto.randomUUID()
  const headers = new Headers(request.headers)
  headers.set(SINK_HEADER, id)
  const slot: Array<string> = []
  sinks.set(id, slot)
  try {
    const response = await handle(new Request(request, { headers }))
    if (slot.length === 0) return response
    const out = new Headers(response.headers)
    slot.forEach(cookie => out.append('set-cookie', cookie))
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: out,
    })
  } finally {
    sinks.delete(id)
  }
}
