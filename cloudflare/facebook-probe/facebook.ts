import { facebookUrl } from '../../shared/extraction.ts'
import type { SourceQuality } from '../../shared/types/media.ts'

const fieldPattern = /"(?:browser_native_(?:hd|sd)_url|playable_url(?:_quality_hd)?|progressive_urls)"\s*:/
const redirectCodes = new Set([301, 302, 303, 307, 308])
const textLimit = 4 * 1024 * 1024
const pageHeaders = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
}

export class ProbeFailure extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export function mediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const url = new URL(value)
    const host = url.hostname
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        (host === 'fbcdn.net' || host.endsWith('.fbcdn.net')) && url.pathname.toLowerCase().endsWith('.mp4')) {
      return url.href
    }
  } catch {
    return null
  }
  return null
}

function videoId(url: string) {
  const { pathname, searchParams } = new URL(url)
  const routeId = pathname.match(/\/(?:reel|videos)\/(\d+)\/?$/)?.[1]
  if (routeId) return routeId
  const queryId = searchParams.get('v')
  if (/^\/(?:watch|video\.php)\/?$/.test(pathname) && queryId && /^\d+$/.test(queryId)) return queryId
}

type Fields = Record<string, unknown>
type Choices = Partial<Record<SourceQuality, string>>

function fields(value: unknown): Fields {
  return value && typeof value === 'object' ? value as Fields : {}
}

function optionsForVideo(root: unknown, id: string) {
  const found: Choices = {}
  const stack: object[] = [fields(root)]
  while (stack.length) {
    const item = fields(stack.pop())
    const itemId = item.videoId ?? item.id
    if (itemId === id && !item.is_live_streaming && !item.is_video_broadcast) {
      const legacy = fields(item.videoDeliveryLegacyFields ?? item)
      const result = fields(fields(item.videoDeliveryResponseFragment).videoDeliveryResponseResult)
      found.sd ??= mediaUrl(legacy.browser_native_sd_url ?? legacy.playable_url) ?? undefined
      found.hd ??= mediaUrl(legacy.browser_native_hd_url ?? legacy.playable_url_quality_hd) ?? undefined
      if (Array.isArray(result.progressive_urls)) {
        for (const entry of result.progressive_urls) {
          const quality = fields(fields(entry).metadata).quality
          const url = mediaUrl(fields(entry).progressive_url)
          if (url && typeof quality === 'string') {
            const tier = quality.toLowerCase()
            if (tier === 'sd' || tier === 'hd') found[tier] ??= url
          }
        }
      }
    }
    for (const child of Object.values(item)) if (child && typeof child === 'object') stack.push(child)
  }
  return found
}

export function parsePage(html: string, finalUrl: string) {
  let id = videoId(finalUrl)
  if (!id) {
    const canonical = html.match(/<meta property="og:url" content="([^"]+)"/)?.[1] ??
      html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]
    const canonicalUrl = canonical && facebookUrl(new URL(canonical.replaceAll('&amp;', '&'), finalUrl).href)
    if (canonicalUrl) id = videoId(canonicalUrl)
  }
  if (!id) throw new ProbeFailure('VIDEO_ID_MISSING')
  const choices: Choices = {}
  for (const script of html.matchAll(/<script\b[^>]*\bdata-sjs\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const data = script[1]!
    if (!data.includes(id) || !fieldPattern.test(data)) continue
    try {
      const options = optionsForVideo(JSON.parse(data), id)
      choices.hd ??= options.hd
      choices.sd ??= options.sd
      if (choices.hd && choices.sd) break
    } catch {
      // Skip data script blocks that do not contain valid JSON.
    }
  }
  if (choices.hd === choices.sd) delete choices.sd
  if (!choices.hd && !choices.sd) throw new ProbeFailure('NO_PROGRESSIVE_MP4')
  return { id, choices }
}

async function readPage(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new ProbeFailure('FACEBOOK_EMPTY_PAGE')
  const decoder = new TextDecoder()
  let received = 0
  let html = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return html + decoder.decode()
    received += value.byteLength
    if (received > textLimit) {
      await reader.cancel()
      throw new ProbeFailure('FACEBOOK_PAGE_TOO_LARGE')
    }
    html += decoder.decode(value, { stream: true })
  }
}

export async function inspectFacebook(input: unknown, signal: AbortSignal) {
  const initialUrl = facebookUrl(input)
  if (!initialUrl) throw new ProbeFailure('INVALID_LINK')
  let url = initialUrl
  let hops = 0
  while (hops <= 5) {
    const response = await fetch(url, { headers: pageHeaders, redirect: 'manual', signal })
    if (redirectCodes.has(response.status)) {
      const location = response.headers.get('Location')
      await response.body?.cancel()
      if (!location) throw new ProbeFailure('FACEBOOK_REDIRECT_MISSING')
      const destination = new URL(location, url)
      const next = facebookUrl(destination.href)
      if (!next) {
        const facebook = destination.hostname === 'facebook.com' || destination.hostname.endsWith('.facebook.com')
        const path = destination.pathname
        if (facebook && /^\/(?:login(?:\.php)?|login_require)(?:\/|$)/.test(path)) {
          throw new ProbeFailure('FACEBOOK_LOGIN_REQUIRED')
        }
        if (facebook && /^\/(?:checkpoint|challenge|captcha)(?:\/|$)/.test(path)) {
          throw new ProbeFailure('FACEBOOK_VERIFICATION_REQUIRED')
        }
        throw new ProbeFailure(facebook ? 'FACEBOOK_NON_VIDEO_REDIRECT' : 'FACEBOOK_OTHER_ORIGIN_REDIRECT')
      }
      url = next
      hops++
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new ProbeFailure(`FACEBOOK_HTTP_${response.status}`)
    }
    const html = await readPage(response)
    return { ...parsePage(html, url), hops, htmlCharacters: html.length }
  }
  throw new ProbeFailure('FACEBOOK_TOO_MANY_REDIRECTS')
}

export async function verifyMp4(url: string, signal: AbortSignal) {
  const start = Date.now()
  const response = await fetch(url, { headers: { Range: 'bytes=0-63' }, redirect: 'manual', signal })
  const reader = response.body?.getReader()
  let prefix = ''
  try {
    if (reader && response.ok) {
      const buffer = new Uint8Array(8)
      let offset = 0
      while (offset < buffer.length) {
        const { done, value } = await reader.read()
        if (done) break
        const amount = Math.min(value.length, buffer.length - offset)
        buffer.set(value.subarray(0, amount), offset)
        offset += amount
      }
      prefix = new TextDecoder().decode(buffer.subarray(4, offset))
    }
  } finally {
    await reader?.cancel().catch(() => {})
  }
  return { status: response.status, mp4: prefix === 'ftyp', fetchMs: Date.now() - start }
}
