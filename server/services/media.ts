import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { InspectedVideo, Resolution } from '#shared/types/media'

const maxBytes = 64 * 1024 * 1024
const optionLifetime = 10 * 60_000
const maxOptions = 512
const hosts = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com'])
const videoPath = /^\/(?:reel\/\d+|(?:[^/]+\/)?videos\/\d+|share\/[rv]\/[A-Za-z\d_-]+)\/?$/

const messages = {
  INVALID_LINK: [400, 'Paste a Facebook video or Reel link.'],
  BUSY: [429, 'Too many requests. Try again in a moment.'],
  EXPIRED: [410, 'These download options expired. Check the link again.'],
  UNAVAILABLE: [422, 'This video is unavailable without signing in. Try a public video.'],
  NO_FORMAT: [422, 'This quality is unavailable. Check the link again or try another quality.'],
  TOO_LONG: [422, 'Choose a video no longer than 5 minutes.'],
  TOOL_UNAVAILABLE: [503, 'The download service is unavailable right now.'],
  UPSTREAM_TIMEOUT: [504, 'Facebook took too long to respond. Try again.'],
  UPSTREAM_ERROR: [502, 'We couldn’t load this video right now. Try again.']
} as const

type MediaCode = keyof typeof messages

export class MediaFailure extends Error {
  status: number

  constructor(readonly code: MediaCode) {
    const [status, message] = messages[code]
    super(message)
    this.status = status
  }
}

interface MediaChoice {
  selection: string
  resolution: Resolution | null
  sizeBytes: number | null
  audioRequired: boolean
}

interface DownloadOption extends MediaChoice {
  url: string
  expiresAt: number
}

interface MediaInspection extends Omit<InspectedVideo, 'qualities'> {
  choices: MediaChoice[]
}

interface MediaOutput {
  file: string
  streams: Array<{ codec_type: string, codec_name: string, width?: number, height?: number }>
}

const options = new Map<string, DownloadOption>()
const requests = new Map<string, { count: number, expiresAt: number }>()
let active = 0

export function limitRequests(ip: string | undefined) {
  const now = Date.now()
  for (const [key, request] of requests) {
    if (request.expiresAt <= now) requests.delete(key)
  }
  const key = ip || 'unknown'
  const request = requests.get(key) || { count: 0, expiresAt: now + 60_000 }
  if (request.count >= 12 || (!requests.has(key) && requests.size >= 256)) {
    throw new MediaFailure('BUSY')
  }
  request.count += 1
  requests.set(key, request)
}

function facebookLink(input: unknown) {
  if (typeof input !== 'string' || input.length > 2048 || /[\s\\]/.test(input.trim())) {
    throw new MediaFailure('INVALID_LINK')
  }
  try {
    const url = new URL(input.trim())
    const watch = /^\/(?:watch|video\.php)\/?$/.test(url.pathname)
      && url.searchParams.getAll('v').length === 1
      && /^\d+$/.test(url.searchParams.get('v') || '')
    const supported = url.hostname === 'fb.watch'
      ? /^\/[a-z\d_-]+\/?$/i.test(url.pathname)
      : hosts.has(url.hostname) && (videoPath.test(url.pathname) || watch)
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && supported) {
      url.hash = ''
      return url.toString()
    }
  } catch {
    throw new MediaFailure('INVALID_LINK')
  }
  throw new MediaFailure('INVALID_LINK')
}

function acquireSlot() {
  if (active >= 3) throw new MediaFailure('BUSY')
  active += 1
  return () => { active -= 1 }
}

function runMedia<T>(args: string[], timeout: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.env.DOWNLOADER_PYTHON || 'python3', [resolve('web_media.py'), ...args], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    const chunks: Buffer[] = []
    let length = 0
    let failure: MediaFailure | undefined
    function stop(code: MediaCode) {
      failure ||= new MediaFailure(code)
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill()
        else process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The process group can have already exited.
      }
    }
    const abort = () => stop('UPSTREAM_ERROR')
    const timer = setTimeout(() => stop('UPSTREAM_TIMEOUT'), timeout)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 262_144) stop('UPSTREAM_ERROR')
      else chunks.push(chunk)
    })
    child.once('error', () => { failure ||= new MediaFailure('TOOL_UNAVAILABLE') })
    child.once('close', (status) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (failure) return reject(failure)
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (status === 0) return resolveResult(data as T)
        const code: MediaCode = Object.hasOwn(messages, data.code) ? data.code : 'UPSTREAM_ERROR'
        reject(new MediaFailure(code))
      } catch {
        reject(new MediaFailure('UPSTREAM_ERROR'))
      }
    })
  })
}

export async function inspectVideo(input: unknown, signal: AbortSignal): Promise<InspectedVideo> {
  const url = facebookLink(input)
  const release = acquireSlot()
  try {
    const { choices, ...video } = await runMedia<MediaInspection>(['inspect', url], 45_000, signal)
    const now = Date.now()
    for (const [id, option] of options) {
      if (option.expiresAt <= now) options.delete(id)
    }
    const qualities = choices.map((choice) => {
      const id = randomUUID()
      options.set(id, { ...choice, url, expiresAt: now + optionLifetime })
      return { id, resolution: choice.resolution, sizeBytes: choice.sizeBytes }
    })
    while (options.size > maxOptions) {
      const first = options.keys().next()
      if (first.done) break
      options.delete(first.value)
    }
    return { ...video, qualities }
  } finally {
    release()
  }
}

export async function prepareDownload(id: string, signal: AbortSignal) {
  const option = options.get(id)
  if (!option || option.expiresAt <= Date.now()) {
    options.delete(id)
    throw new MediaFailure('EXPIRED')
  }
  const release = acquireSlot()
  let folder: string | undefined
  const cleanup = async () => {
    try {
      if (folder) await rm(folder, { recursive: true, force: true })
    } finally {
      release()
    }
  }
  try {
    folder = await mkdtemp(join(tmpdir(), 'downloader-'))
    const result = await runMedia<MediaOutput>([
      'download', option.url, '--format', option.selection, '--output-dir', folder
    ], 160_000, signal)
    const path = resolve(result.file)
    if (dirname(path) !== folder || !path.endsWith('.mp4')) throw new MediaFailure('UPSTREAM_ERROR')
    const video = result.streams.find(stream => stream.codec_type === 'video')
    const audio = result.streams.find(stream => stream.codec_type === 'audio')
    if (video?.codec_name !== 'h264' || (audio && audio.codec_name !== 'aac') || (option.audioRequired && !audio)) {
      throw new MediaFailure('NO_FORMAT')
    }
    if (option.resolution && (video.width !== option.resolution.width || video.height !== option.resolution.height)) {
      throw new MediaFailure('NO_FORMAT')
    }
    const file = await stat(path)
    if (!file.isFile() || file.size <= 0 || file.size > maxBytes) throw new MediaFailure('NO_FORMAT')
    const stream = createReadStream(path, { signal })
    stream.once('close', () => { void cleanup().catch(() => {}) })
    const label = video.width && video.height ? `-${video.width}x${video.height}` : ''
    return { stream, size: file.size, name: `facebook-video${label}.mp4` }
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}
