import { ProbeFailure, inspectFacebook, verifyMp4 } from './facebook.ts'

interface Env {
  PROBE_TOKEN_SHA256: string
}

export default {
  async fetch(request, env) {
    const headers = { 'Cache-Control': 'no-store' }
    const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
    if (!token || request.method !== 'POST' || new URL(request.url).pathname !== '/probe') {
      return new Response(null, { status: 404, headers })
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== env.PROBE_TOKEN_SHA256) return new Response(null, { status: 404, headers })
    if (Number(request.headers.get('Content-Length')) > 4096) return new Response(null, { status: 413, headers })

    const start = Date.now()
    const colo = request.cf?.colo
    try {
      const body = await request.json<{ url?: unknown }>()
      const result = await inspectFacebook(body.url, AbortSignal.timeout(25_000))
      const inspectMs = Date.now() - start
      const qualities = await Promise.all(Object.entries(result.choices).flatMap(([quality, url]) => url
        ? [verifyMp4(url, AbortSignal.timeout(10_000)).then(result => ({ quality, ...result }))]
        : []))
      return Response.json({ colo, videoId: result.id, hops: result.hops, htmlCharacters: result.htmlCharacters,
        inspectMs, qualities }, { headers })
    } catch (error) {
      const reason = error instanceof ProbeFailure ? error.code : error instanceof SyntaxError
        ? 'INVALID_BODY' : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED'
      return Response.json({ colo, reason, elapsedMs: Date.now() - start }, { status: 422, headers })
    }
  }
} satisfies ExportedHandler<Env>
