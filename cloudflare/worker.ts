import { Container } from '@cloudflare/containers'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { extractionHosts } from '../shared/extraction.ts'
import type { MediaTicket } from '../shared/extraction.ts'
// @ts-expect-error Nitro emits this Worker module during the Nuxt build.
import nitro from '../.output/server/index.mjs'

export { ContainerProxy } from '@cloudflare/containers'

interface Env {
  DOWNLOADER: DurableObjectNamespace<DownloaderContainer>
  BETA_ACCESS_AUD: string
  BETA_ACCESS_TEAM: string
  ASSETS: Fetcher
}

export class DownloaderContainer extends Container<Env> {
  defaultPort = 3000
  sleepAfter = '10m'
  enableInternet = false
  interceptHttps = true
  allowedHosts = extractionHosts
  envVars = { MEDIA_CLOUDFLARE_EGRESS: '1' }

  static {
    this.outbound = request => {
      const url = new URL(request.url)
      if (url.protocol !== 'https:' || url.port || url.username || url.password) return new Response(null, { status: 403 })
      // Return redirects to the container so the interceptor checks every destination.
      return fetch(request, { redirect: 'manual' })
    }
  }

  private readonly options = new Map<string, { ticket: MediaTicket, expiresAt: number }>()
  private readonly requests = new Map<string, { count: number, expiresAt: number }>()

  async consume(client: string) {
    const now = Date.now()
    for (const [key, entry] of this.requests) if (entry.expiresAt <= now) this.requests.delete(key)
    const count = this.requests.get(client) ?? { count: 0, expiresAt: now + 60_000 }
    if (count.count >= 12 || (!this.requests.has(client) && this.requests.size >= 256)) return false
    count.count += 1
    this.requests.set(client, count)
    return true
  }

  async remember(tickets: MediaTicket[]) {
    const now = Date.now()
    for (const [key, entry] of this.options) if (entry.expiresAt <= now) this.options.delete(key)
    const ids: string[] = []
    for (const ticket of tickets) {
      const id = crypto.randomUUID()
      ids.push(id)
      this.options.set(id, { ticket, expiresAt: now + 10 * 60_000 })
    }
    while (this.options.size > 512) {
      const first = this.options.keys().next()
      if (first.done) break
      this.options.delete(first.value)
    }
    return ids
  }

  async lookup(id: string) {
    const entry = this.options.get(id)
    if (!entry || entry.expiresAt <= Date.now()) {
      this.options.delete(id)
      return null
    }
    return entry.ticket
  }
}

let signingKeys: { issuer: string, keys: ReturnType<typeof createRemoteJWKSet> } | undefined

async function authenticated(request: Request, env: Env, ctx: ExecutionContext) {
  const audience = ctx.access?.aud
  if (Array.isArray(audience) ? audience.includes(env.BETA_ACCESS_AUD) : audience === env.BETA_ACCESS_AUD) return true
  // The Static Assets router can remove ctx.access. Validate the signed assertion in that case.
  const hostname = env.BETA_ACCESS_TEAM
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(hostname) || !token) return false
  const issuer = `https://${hostname}`
  if (signingKeys?.issuer !== issuer) signingKeys = { issuer, keys: createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer)) }
  try {
    await jwtVerify(token, signingKeys.keys, { issuer, audience: env.BETA_ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp'] })
    return true
  } catch {
    return false
  }
}

async function boundedBody(request: Request) {
  if (Number(request.headers.get('Content-Length')) > 4096 || !request.body) return null
  const reader = request.body.getReader()
  const bytes = new Uint8Array(4096)
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return bytes.slice(0, length)
      if (length + chunk.value.length > bytes.length) {
        await reader.cancel()
        return null
      }
      bytes.set(chunk.value, length)
      length += chunk.value.length
    }
  } finally {
    reader.releaseLock()
  }
}

export default {
  async fetch(request, env, ctx) {
    if (!env.BETA_ACCESS_AUD) return new Response('Beta access is not configured.', { status: 503, headers: { 'Cache-Control': 'no-store' } })
    if (!await authenticated(request, env, ctx)) return new Response('This beta requires Cloudflare Access.', { status: 403, headers: { 'Cache-Control': 'no-store' } })

    const headers = new Headers(request.headers)
    for (const name of [...headers.keys()]) {
      if (name === 'cookie' || name === 'authorization' || name.startsWith('cf-access-')) headers.delete(name)
    }
    const pathname = new URL(request.url).pathname
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.method !== 'POST' || pathname !== '/api/videos/inspect') return new Response(null, { status: 405 })
      const body = await boundedBody(request).catch(() => null)
      if (!body) return Response.json({ statusMessage: 'Paste a Facebook video or Reel link.', data: { code: 'INVALID_LINK' } },
        { status: 400, headers: { 'Cache-Control': 'no-store' } })
      headers.delete('Content-Length')
      return nitro.fetch(new Request(request.url, { method: request.method, headers, body, signal: request.signal }), env, ctx)
    }
    return nitro.fetch(new Request(request, { headers }), env, ctx)
  }
} satisfies ExportedHandler<Env>
