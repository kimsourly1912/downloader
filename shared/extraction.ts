import type { Resolution, SourceQuality } from './types/media.ts'

export const maxMediaBytes = 64 * 1024 * 1024
export const maxVideoSeconds = 300
export const extractionHosts = ['facebook.com', '*.facebook.com', 'fb.watch', 'fbcdn.net', '*.fbcdn.net', 'fbsbx.com', '*.fbsbx.com']
const acceptedHosts = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com'])
const linkPath = /^\/(?:reel\/\d+|(?:[^/]+\/)?videos\/\d+|share\/[rv]\/[A-Za-z\d_-]+)\/?$/

export function facebookUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    const id = url.searchParams.getAll('v')
    const watch = /^\/(?:watch|video\.php)\/?$/.test(url.pathname) && id.length === 1 && /^\d+$/.test(id[0]!)
    const supported = url.hostname === 'fb.watch'
      ? /^\/[A-Za-z\d_-]+\/?$/.test(url.pathname)
      : acceptedHosts.has(url.hostname) && (linkPath.test(url.pathname) || watch)
    if (!supported) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
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

export function facebookVideoFilename(): string {
  return `facebook-video-${crypto.randomUUID()}.mp4`
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
}

export interface MediaTicket extends MediaChoice {
  url: string
}

export type ExtractorError = 'INVALID_LINK' | 'BUSY' | 'EXPIRED' | 'UNAVAILABLE' | 'NO_FORMAT' | 'TOO_LONG' | 'TOOL_UNAVAILABLE' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_ERROR'

export interface ExtractorBinding {
  consume(client: string): Promise<boolean>
  remember(tickets: MediaTicket[]): Promise<string[]>
  lookup(id: string): Promise<MediaTicket | null>
  fetch(input: Request): Promise<Response>
}
