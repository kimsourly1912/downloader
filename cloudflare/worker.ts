import { Container } from '@cloudflare/containers'
import { extractionHosts, facebookMediaExpiry, facebookMediaUrl, facebookUrl } from '../shared/extraction.ts'
import type { InspectionResult, InspectionTiming, MediaTicket, SourceVideo } from '../shared/extraction.ts'
import { chooseFormats } from '../shared/facebook-formats.ts'
// @ts-expect-error Nitro emits this Worker module during the Nuxt build.
import nitro from '../.output/server/index.mjs'

export { ContainerProxy } from '@cloudflare/containers'

interface Env {
  DOWNLOADER: DurableObjectNamespace<DownloaderContainer>
  ASSETS: Fetcher
  DOWNLOADER_IDLE_MINUTES: string
}

type ResolvedVideo = Extract<InspectionResult, { video: unknown }>['video']

export class DownloaderContainer extends Container<Env> {
  defaultPort = 3000
  sleepAfter = this.env.DOWNLOADER_IDLE_MINUTES === '10' ? '10m' : '2m'
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

  private readonly inspections = new Map<string, { video: ResolvedVideo, expiresAt: number }>()
  private readonly pending = new Map<string, Promise<InspectionResult>>()
  private readonly requests = new Map<string, { count: number, expiresAt: number }>()

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS download_tickets (
      id TEXT PRIMARY KEY, ticket_json TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`)
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/inspect-cached') return super.fetch(request)
    const { url } = await request.json<{ url?: unknown }>()
    return Response.json(await this.inspectCached(url), { headers: { 'Cache-Control': 'no-store' } })
  }

  private async inspectCached(input: unknown): Promise<InspectionResult> {
    const url = facebookUrl(input)
    const timing: InspectionTiming = { cache: 'miss' }
    if (!url) return { failure: 'INVALID_LINK', timing }

    const now = Date.now()
    for (const [key, entry] of this.inspections) if (entry.expiresAt <= now) this.inspections.delete(key)
    const cached = this.inspections.get(url)
    if (cached) return { video: cached.video, timing: { cache: 'hit' } }
    const existing = this.pending.get(url)
    if (existing) return { ...await existing, timing: { cache: 'shared' } }
    if (this.pending.size >= 8) return { failure: 'BUSY', timing }

    const task = this.resolveInspection(url, timing).finally(() => { this.pending.delete(url) })
    this.pending.set(url, task)
    // The lookup has its own deadline so one disconnected client cannot abort other waiters.
    this.ctx.waitUntil(task)
    return task
  }

  private async resolveInspection(url: string, timing: InspectionTiming): Promise<InspectionResult> {
    const start = performance.now()
    const running = this.ctx.container?.running
    if (running !== undefined) timing.container = running ? 'warm' : 'cold'
    try {
      const result = await super.fetch(new Request('http://extractor.internal/inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }), signal: AbortSignal.timeout(60_000)
      }))
      timing.containerMs = Math.round(performance.now() - start)
      const measured = result.headers.get('X-Extractor-Ms')
      if (measured && /^\d{1,6}$/.test(measured)) timing.extractorMs = Number(measured)
      if (!result.ok) {
        await result.body?.cancel()
        return { failure: result.headers.get('X-Downloader-Error'), timing }
      }
      const source = await result.json<SourceVideo & { extractorMs?: number }>()
      if (typeof source.extractorMs === 'number' && Number.isInteger(source.extractorMs) &&
          source.extractorMs >= 0 && source.extractorMs <= 60_000) timing.extractorMs = source.extractorMs
      const choices = chooseFormats(source)
      if (typeof choices === 'string') return { failure: choices, timing }
      const video = { title: source.title, duration: source.duration, thumbnail: source.thumbnail, choices }

      const now = Date.now()
      let expiresAt = now + 60_000
      for (const choice of choices) {
        const direct = facebookMediaUrl(choice.mediaUrl)
        if (!direct) continue
        const expiry = facebookMediaExpiry(direct)
        if (expiry !== undefined) expiresAt = Math.min(expiresAt, expiry - 15_000)
      }
      if (expiresAt > now) {
        if (this.inspections.size >= 64) {
          const oldest = this.inspections.keys().next().value
          if (oldest !== undefined) this.inspections.delete(oldest)
        }
        this.inspections.set(url, { video, expiresAt })
      }
      return { video, timing }
    } catch (error) {
      console.error('Downloader internal lookup failed', error instanceof Error ? error.name : 'UnknownError')
      timing.containerMs ??= Math.round(performance.now() - start)
      return { failure: null, timing }
    }
  }

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
    const { sql } = this.ctx.storage
    return this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM download_tickets WHERE expires_at <= ?', now)
      const ids = tickets.map(ticket => {
        const id = crypto.randomUUID()
        sql.exec('INSERT INTO download_tickets (id, ticket_json, expires_at) VALUES (?, ?, ?)',
          id, JSON.stringify(ticket), now + 10 * 60_000)
        return id
      })
      sql.exec('DELETE FROM download_tickets WHERE rowid IN (SELECT rowid FROM download_tickets ORDER BY rowid DESC LIMIT -1 OFFSET 512)')
      return ids
    })
  }

  async lookup(id: string) {
    const { sql } = this.ctx.storage
    const now = Date.now()
    const row = sql.exec<{ ticket_json: string }>('SELECT ticket_json FROM download_tickets WHERE id = ? AND expires_at > ?', id, now)
      .toArray()[0]
    if (!row) return null
    const ticket = JSON.parse(row.ticket_json) as MediaTicket
    const direct = facebookMediaUrl(ticket.mediaUrl)
    const expiry = direct ? facebookMediaExpiry(direct) : undefined
    if (expiry !== undefined && expiry <= now) delete ticket.mediaUrl
    return ticket
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
    const pathname = new URL(request.url).pathname
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.method !== 'POST' || pathname !== '/api/videos/inspect') return new Response(null, { status: 405 })
      const body = await boundedBody(request).catch(() => null)
      if (!body) return Response.json({ statusMessage: 'Paste a Facebook video or Reel link.', data: { code: 'INVALID_LINK' } },
        { status: 400, headers: { 'Cache-Control': 'no-store' } })
      const headers = new Headers(request.headers)
      headers.delete('Content-Length')
      return nitro.fetch(new Request(request.url, { method: request.method, headers, body, signal: request.signal }), env, ctx)
    }
    return nitro.fetch(request, env, ctx)
  }
} satisfies ExportedHandler<Env>
