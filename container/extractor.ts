import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { facebookMediaUrl, formatId, maxMediaBytes, maxVideoSeconds, positiveInteger } from '../shared/extraction.ts'
import type { ExtractorError, MediaTicket, SourceFormat, SourceVideo, VideoLink } from '../shared/extraction.ts'
import { platformNames } from '../shared/types/media.ts'
import { chooseFormats } from '../shared/video-formats.ts'
import type { VideoPlatform } from '../shared/types/media.ts'

export class ExtractionFailure extends Error {
  readonly code: ExtractorError
  readonly diagnostic?: string

  constructor(code: ExtractorError, diagnostic?: string) {
    super(code)
    this.code = code
    this.diagnostic = diagnostic
  }
}

function upstreamFailure(stderr: string): ExtractionFailure {
  const error = stderr.trim().split('\n').findLast(line => line.startsWith('ERROR:')) ?? stderr
  const http = error.match(/(?:HTTP Error|HTTP\/\S+) ([45]\d{2})\b/i)?.[1]
  if (http) return new ExtractionFailure('UPSTREAM_ERROR', `http-${http}`)
  if (/certificate verify|certificate problem|self[- ]signed certificate/i.test(error)) return new ExtractionFailure('UPSTREAM_ERROR', 'certificate')
  if (/timed?\s*out|timeout was reached|curl:\s*\(28\)/i.test(error)) return new ExtractionFailure('UPSTREAM_TIMEOUT', 'network-timeout')
  if (/\b(?:SSL|TLS)\b/i.test(error)) return new ExtractionFailure('UPSTREAM_ERROR', 'tls')
  if (/failed to connect|could not resolve|connection reset|connection refused|server closed connection/i.test(error)) {
    return new ExtractionFailure('UPSTREAM_ERROR', 'connection')
  }
  if (/unable to (?:extract challenge data|solve JS challenge)|missing challenge cookie/i.test(error)) {
    return new ExtractionFailure('UPSTREAM_ERROR', 'challenge')
  }
  if (/unable to extract|unsupported url|video not available|unable to decode/i.test(error)) {
    return new ExtractionFailure('UPSTREAM_ERROR', 'unexpected-content')
  }
  return new ExtractionFailure('UPSTREAM_ERROR', 'unknown')
}

// The cache dir holds yt-dlp's YouTube player data, such as the preprocessed player script. Reusing it skips a
// 2.5 MB player download and the slowest part of the Node challenge solver on every run. It never holds media.
const commonArgs = ['--ignore-config', '--no-plugin-dirs', '--no-playlist',
  '--no-js-runtimes', '--compat-options', 'no-certifi', '--socket-timeout', '15', '--retries', '1', '--fragment-retries', '1']
const thumbnailHosts: Record<VideoPlatform, RegExp> = {
  facebook: /(^|\.)fbcdn\.net$/,
  youtube: /(^|\.)ytimg\.com$/,
  tiktok: /(^|\.)tiktokcdn(?:-us)?\.com$/
}

export interface ExtractorRuntime {
  /** Loopback egress proxy URL. Every yt-dlp run must use it. */
  proxy: string
  /** Temporary yt-dlp cache directory shared by all runs in this container. */
  cacheDir: string
}

function extractorArgs(platform: VideoPlatform, runtime: ExtractorRuntime) {
  const args = [...commonArgs, '--cache-dir', runtime.cacheDir, '--proxy', runtime.proxy]
  return platform === 'youtube' ? [...args, '--js-runtimes', 'node'] : args
}

// Inspection results are kept in memory so the download can reuse them with `--load-info-json` instead of
// extracting the page again. The entries carry the media URLs and the platform cookies that yt-dlp needs.
// If those URLs no longer work, yt-dlp extracts the video's own page again by itself.
const infoLifetime = 10 * 60_000
const maxSavedInfos = 16
const savedInfos = new Map<string, { url: string, json: string, expiresAt: number }>()

function saveInfo(url: string, json: string) {
  const now = Date.now()
  for (const [key, entry] of savedInfos) if (entry.expiresAt <= now) savedInfos.delete(key)
  if (savedInfos.size >= maxSavedInfos) {
    const oldest = savedInfos.keys().next().value
    if (oldest !== undefined) savedInfos.delete(oldest)
  }
  const key = randomUUID()
  savedInfos.set(key, { url, json, expiresAt: now + infoLifetime })
  return key
}

function savedInfo(ticket: MediaTicket) {
  const entry = ticket.infoKey ? savedInfos.get(ticket.infoKey) : undefined
  return entry && entry.url === ticket.url && entry.expiresAt > Date.now() ? entry.json : undefined
}

function run(executable: string, args: string[], timeout: number, signal: AbortSignal, limitFile = false) {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) return reject(new ExtractionFailure('UPSTREAM_ERROR'))
    const command = limitFile ? 'prlimit' : executable
    const parameters = limitFile ? [`--fsize=${maxMediaBytes}`, '--', executable, ...args] : args
    const child = spawn(command, parameters, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let length = 0
    let details = ''
    let failure: ExtractionFailure | undefined
    const stop = (code: ExtractorError, diagnostic: string) => {
      failure ??= new ExtractionFailure(code, diagnostic)
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Process already stopped. */ }
      }
    }
    const abort = () => stop('UPSTREAM_ERROR', 'aborted')
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop('UPSTREAM_TIMEOUT', 'deadline'), timeout)
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 2 * 1024 * 1024) stop('UPSTREAM_ERROR', 'output-limit')
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { details = (details + chunk.toString()).slice(-16_384) })
    child.once('error', () => { failure ??= new ExtractionFailure('TOOL_UNAVAILABLE', 'spawn') })
    child.once('close', (status) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (failure) return reject(failure)
      if (status === 0) return resolve(Buffer.concat(chunks).toString('utf8'))
      if (/confirm (?:that )?you(?:'re| are) not a bot/i.test(details.replaceAll('’', "'"))) {
        return reject(new ExtractionFailure('UPSTREAM_RESTRICTED'))
      }
      if (/login required|log in|logging in|sign in|private video|video is unavailable/i.test(details)) {
        return reject(new ExtractionFailure('UNAVAILABLE'))
      }
      if (/file too large|file size limit/i.test(details)) return reject(new ExtractionFailure('NO_FORMAT', 'file-too-large'))
      if (/requested format is not available/i.test(details)) return reject(new ExtractionFailure('NO_FORMAT', 'format-unavailable'))
      reject(upstreamFailure(details))
    })
  })
}

function metadata(value: string, platform: VideoPlatform): SourceVideo {
  const data = JSON.parse(value) as Record<string, unknown>
  const formats: SourceFormat[] = []
  if (Array.isArray(data.formats)) {
    const rawFormats = data.formats.slice(-128) as Array<Record<string, unknown> | null>
    const hdUrl = rawFormats.find(item => item?.format_id === 'hd')?.url
    for (const item of rawFormats) {
      if (!item || typeof item.format_id !== 'string' || !formatId.test(item.format_id)) continue
      if (platform === 'facebook' && item.format_id === 'sd' && typeof hdUrl === 'string' && hdUrl && item.url === hdUrl) continue
      const str = (key: string) => typeof item[key] === 'string' ? (item[key] as string).slice(0, 64) : undefined
      const mediaUrl = platform === 'facebook' && item.protocol === 'https' && !item.manifest_url && !item.fragments &&
        item.vcodec !== 'none' && item.acodec !== 'none' ? facebookMediaUrl(item.url) : undefined
      // TikTok reports dimensions that can differ from the file it serves, such as 576x1024 for a 540x960 MP4.
      // Leave them out so the quality label stays truthful and the download check does not reject the real file.
      const dimensions = platform !== 'tiktok'
      formats.push({ id: item.format_id, ext: str('ext'), protocol: str('protocol'), videoCodec: str('vcodec'),
        audioCodec: str('acodec'), width: dimensions && positiveInteger(item.width) ? item.width : undefined,
        height: dimensions && positiveInteger(item.height) ? item.height : undefined,
        sizeBytes: positiveInteger(item.filesize) ? item.filesize : undefined,
        approxBytes: typeof item.filesize_approx === 'number' && item.filesize_approx >= 1 && Number.isFinite(item.filesize_approx)
          ? Math.round(item.filesize_approx) : undefined, mediaUrl })
    }
  }
  let thumbnail: string | null = null
  if (typeof data.thumbnail === 'string' && data.thumbnail.length <= 4096) {
    try {
      const url = new URL(data.thumbnail)
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && thumbnailHosts[platform].test(url.hostname)) thumbnail = url.href
    } catch { /* Some sources have no valid thumbnail. */ }
  }
  const duration = typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration > 0 ? data.duration : null
  return { title: typeof data.title === 'string' && data.title.trim() ? data.title.slice(0, 180) : `${platformNames[platform]} video`,
    duration, thumbnail, live: data.is_live === true || data.live_status === 'is_upcoming' || data.live_status === 'post_live', formats }
}

// The visionOS client needs no player script and no Node challenge solver, which are most of YouTube's CPU time.
// yt-dlp already adds other clients for "made for kids" videos. When this client gives no usable MP4, the
// inspection runs again with yt-dlp's default clients, so a video is never offered less than before.
const fastYoutubeArgs = ['--extractor-args', 'youtube:player_client=visionos']

async function extract(link: VideoLink, runtime: ExtractorRuntime, signal: AbortSignal, extraArgs: string[], timeout: number) {
  const json = await run(process.env.YTDLP_BIN || 'yt-dlp', [...extractorArgs(link.platform, runtime), ...extraArgs,
    '--dump-single-json', '--skip-download', '--', link.url], timeout, signal)
  return { json, source: metadata(json, link.platform) }
}

export async function inspect(link: VideoLink, runtime: ExtractorRuntime, signal: AbortSignal) {
  let result: Awaited<ReturnType<typeof extract>> | undefined
  let clientFallback = false
  if (link.platform === 'youtube') {
    // Both attempts together stay below the Durable Object's 60-second lookup deadline.
    result = await extract(link, runtime, signal, fastYoutubeArgs, 15_000).catch(() => undefined)
    signal.throwIfAborted()
    if (!result || chooseFormats(result.source) === 'NO_FORMAT') {
      result = undefined
      clientFallback = true
    }
  }
  result ??= await extract(link, runtime, signal, [], 40_000)
  const source: SourceVideo = { ...result.source, infoKey: saveInfo(link.url, result.json) }
  return { source, clientFallback }
}

export async function download(ticket: MediaTicket, platform: VideoPlatform, runtime: ExtractorRuntime, signal: AbortSignal) {
  const folder = await mkdtemp(join(tmpdir(), 'downloader-'))
  const cleanup = () => rm(folder, { recursive: true, force: true })
  try {
    const template = join(folder.replaceAll('%', '%%'), 'video.%(ext)s')
    // yt-dlp reads unquoted numeric format IDs as numbers instead of strings.
    const selection = ticket.selection.split('+').map(id => `all[format_id="${id}"]`).join('+')
    const info = savedInfo(ticket)
    let source = ['--', ticket.url]
    if (info) {
      const infoPath = join(folder, 'info.json')
      await writeFile(infoPath, info, { mode: 0o600 })
      source = ['--load-info-json', infoPath]
    }
    await run(process.env.YTDLP_BIN || 'yt-dlp', [...extractorArgs(platform, runtime), '--downloader', 'native', '--fixup', 'never',
      '--max-filesize', String(maxMediaBytes), '--match-filters', `duration <=? ${maxVideoSeconds} & !is_live`,
      '--format', selection, '--merge-output-format', 'mp4', '--output', template, ...source], 10 * 60_000, signal, true)
    const path = join(folder, 'video.mp4')
    const file = await stat(path).catch(() => null)
    if (!file?.isFile() || file.size <= 0 || file.size > maxMediaBytes) throw new ExtractionFailure('NO_FORMAT', 'missing-file')
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-of', 'json', '-show_entries',
      'stream=codec_type,codec_name,width,height:format=duration', path], 12_000, signal)) as {
      streams: Array<{ codec_type: string, codec_name: string, width?: number, height?: number }>
      format: { duration?: string }
    }
    const video = probe.streams.find(track => track.codec_type === 'video')
    const audio = probe.streams.find(track => track.codec_type === 'audio')
    if (Number(probe.format.duration) > maxVideoSeconds + 1) throw new ExtractionFailure('TOO_LONG', 'media-check')
    if (video?.codec_name !== 'h264' || (audio && audio.codec_name !== 'aac') || (ticket.audioRequired && !audio)) {
      throw new ExtractionFailure('NO_FORMAT', 'media-check')
    }
    if (ticket.resolution && (ticket.resolution.width !== video.width || ticket.resolution.height !== video.height)) {
      throw new ExtractionFailure('NO_FORMAT', 'media-check')
    }
    const stream = createReadStream(path, { signal })
    stream.once('close', () => { void cleanup().catch(() => {}) })
    return { stream, size: file.size }
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}
