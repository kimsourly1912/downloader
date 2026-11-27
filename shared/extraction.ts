import type { Resolution, SourceQuality, VideoPlatform } from './types/media.ts'

export const maxMediaBytes = 64 * 1024 * 1024
export const maxVideoSeconds = 300
export const extractionHosts = [
  'facebook.com', '*.facebook.com', 'fb.watch', 'fbcdn.net', '*.fbcdn.net', 'fbsbx.com', '*.fbsbx.com',
  'youtube.com', '*.youtube.com', 'youtu.be', 'youtubei.googleapis.com', '*.googlevideo.com',
  'tiktok.com', '*.tiktok.com', '*.tiktokcdn.com', '*.tiktokcdn-us.com'
]
const dnsName = /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/

/** Matches a DNS name against `extractionHosts`, where `*.example.com` covers subdomains only. */
export function allowedExtractionHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!dnsName.test(host)) return false
  return extractionHosts.some(pattern => pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern)
}

export const invalidLinkMessage ='Paste a public Facebook, YouTube, or TikTok video link.'
const facebookHosts = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com'])
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])
const tiktokHosts = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'])
const facebookVideoPath = /^\/(?:reel\/\d+|(?:[^/]+\/)?videos\/\d+|share\/[rv]\/[A-Za-z\d_-]+)\/?$/
const youtubeId = /^[A-Za-z\d_-]{11}$/

function parseLink(input: unknown): URL | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function isFacebookVideo(url: URL): boolean {
  if (url.hostname === 'fb.watch') return /^\/[A-Za-z\d_-]+\/?$/.test(url.pathname)
  if (!facebookHosts.has(url.hostname)) return false
  const ids = url.searchParams.getAll('v')
  return facebookVideoPath.test(url.pathname) ||
    (/^\/(?:watch|video\.php)\/?$/.test(url.pathname) && ids.length === 1 && /^\d+$/.test(ids[0]!))
}

export function facebookUrl(input: unknown): string | null {
  const url = parseLink(input)
  return url && isFacebookVideo(url) ? url.href : null
}

export interface VideoLink {
  platform: VideoPlatform
  url: string
}

export function resolveVideoLink(input: unknown): VideoLink | null {
  const url = parseLink(input)
  if (!url) return null
  const { hostname, pathname } = url
  if (isFacebookVideo(url)) return { platform: 'facebook', url: url.href }
  if (hostname === 'youtu.be' || youtubeHosts.has(hostname)) {
    const ids = url.searchParams.getAll('v')
    const id = hostname === 'youtu.be'
      ? pathname.match(/^\/([A-Za-z\d_-]{11})\/?$/)?.[1]
      : /^\/watch\/?$/.test(pathname) && ids.length === 1
        ? ids[0]
        : pathname.match(/^\/shorts\/([A-Za-z\d_-]{11})\/?$/)?.[1]
    return id && youtubeId.test(id) ? { platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}` } : null
  }
  if (tiktokHosts.has(hostname)) {
    const path = pathname.replace(/\/$/, '')
    if (/^\/@[A-Za-z\d._]+\/video\/\d+$/.test(path)) return { platform: 'tiktok', url: `https://www.tiktok.com${path}` }
    if (/^\/t\/\w+$/.test(path)) return { platform: 'tiktok', url: `https://www.tiktok.com${path}/` }
  }
  if ((hostname === 'vm.tiktok.com' || hostname === 'vt.tiktok.com') && /^\/\w+\/?$/.test(pathname)) {
    return { platform: 'tiktok', url: `https://${hostname}${pathname.replace(/\/$/, '')}/` }
  }
  return null
}

export const formatId = /^[A-Za-z0-9_.-]{1,100}(?![\s\S])/
export function validSelection(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 201) return false
  const tracks = value.split('+')
  return tracks.length <= 2 && tracks.every(track => formatId.test(track))
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function videoFilename(platform?: VideoPlatform): string {
  return `${platform ? `${platform}-` : ''}video-${crypto.randomUUID()}.mp4`
}

export function facebookMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return
  try {
    const url = new URL(value)
    const cdn = url.hostname.endsWith('.fbcdn.net')
    if (url.protocol === 'https:' && cdn && !url.username && !url.password && !url.port &&
        !url.hash && url.pathname.toLowerCase().endsWith('.mp4')) return url.href
  } catch {
    return
  }
}

export function facebookMediaExpiry(url: string): number | undefined {
  const expires = new URL(url).searchParams.get('oe')
  if (expires && /^[a-f\d]{8}$/i.test(expires)) return Number.parseInt(expires, 16) * 1000
}

export interface SourceFormat {
  id: string
  ext?: string
  protocol?: string
  videoCodec?: string
  audioCodec?: string
  width?: number
  height?: number
  sizeBytes?: number
  mediaUrl?: string
}

export interface SourceVideo {
  title: string
  duration: number | null
  thumbnail: string | null
  live: boolean
  formats: SourceFormat[]
}

export interface MediaChoice {
  selection: string
  resolution: Resolution | null
  sizeBytes: number | null
  audioRequired: boolean
  sourceQuality?: SourceQuality
  mediaUrl?: string
}

export interface MediaTicket extends MediaChoice {
  url: string
}

export type ExtractorError = 'INVALID_LINK' | 'BUSY' | 'EXPIRED' | 'UNAVAILABLE' | 'NO_FORMAT' | 'TOO_LONG' | 'TOOL_UNAVAILABLE' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_ERROR' | 'UPSTREAM_RESTRICTED'

export const extractorDiagnostic = /^(?:http-[45]\d{2}|network-timeout|certificate|tls|connection|challenge|unexpected-content|unknown)$/

export interface InspectionTiming {
  cache: 'hit' | 'miss' | 'shared'
  container?: 'warm' | 'cold'
  containerMs?: number
  extractorMs?: number
  diagnostic?: string
}

export type InspectionResult = { timing: InspectionTiming } & (
  { video: Omit<SourceVideo, 'formats' | 'live'> & { choices: MediaChoice[] } } | { failure: string | null }
)

export interface ExtractorBinding {
  consume(client: string): Promise<boolean>
  remember(tickets: MediaTicket[]): Promise<string[]>
  lookup(id: string): Promise<MediaTicket | null>
  fetch(input: Request): Promise<Response>
}
