import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { formatId, maxMediaBytes, maxVideoSeconds, positiveInteger } from '../shared/extraction.ts'
import type { ExtractorError, MediaTicket, SourceFormat, SourceVideo } from '../shared/extraction.ts'

export class ExtractionFailure extends Error {
  readonly code: ExtractorError

  constructor(code: ExtractorError) {
    super(code)
    this.code = code
  }
}

const commonArgs = ['--ignore-config', '--no-cache-dir', '--no-plugin-dirs', '--no-playlist',
  '--no-js-runtimes', '--compat-options', 'no-certifi', '--socket-timeout', '15', '--retries', '1', '--fragment-retries', '1']

export async function loadCloudflareCa() {
  if (process.env.MEDIA_CLOUDFLARE_EGRESS !== '1') return
  const [system, platform] = await Promise.all([
    readFile('/etc/ssl/certs/ca-certificates.crt'),
    readFile('/etc/cloudflare/certs/cloudflare-containers-ca.crt')
  ])
  const bundle = join(await mkdtemp(join(tmpdir(), 'downloader-ca-')), 'ca.pem')
  await writeFile(bundle, Buffer.concat([system, Buffer.from('\n'), platform]))
  process.env.SSL_CERT_FILE = bundle
  process.env.REQUESTS_CA_BUNDLE = bundle
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
    let failure: ExtractorError | undefined
    const stop = (code: ExtractorError) => {
      failure ??= code
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Process already stopped. */ }
      }
    }
    const abort = () => stop('UPSTREAM_ERROR')
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop('UPSTREAM_TIMEOUT'), timeout)
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 2 * 1024 * 1024) stop('UPSTREAM_ERROR')
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { details = (details + chunk.toString()).slice(-16_384) })
    child.once('error', () => { failure ??= 'TOOL_UNAVAILABLE' })
    child.once('close', (status) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (failure) return reject(new ExtractionFailure(failure))
      if (status === 0) return resolve(Buffer.concat(chunks).toString('utf8'))
      if (/login required|log in|logging in|private video|video is unavailable/i.test(details)) {
        return reject(new ExtractionFailure('UNAVAILABLE'))
      }
      if (/requested format is not available|file too large|file size limit/i.test(details)) {
        return reject(new ExtractionFailure('NO_FORMAT'))
      }
      reject(new ExtractionFailure('UPSTREAM_ERROR'))
    })
  })
}

function metadata(value: string): SourceVideo {
  const data = JSON.parse(value) as Record<string, unknown>
  const formats: SourceFormat[] = []
  if (Array.isArray(data.formats)) {
    for (const item of data.formats.slice(-128) as Record<string, unknown>[]) {
      if (!item || typeof item.format_id !== 'string' || !formatId.test(item.format_id)) continue
      const str = (key: string) => typeof item[key] === 'string' ? (item[key] as string).slice(0, 64) : undefined
      formats.push({ id: item.format_id, ext: str('ext'), protocol: str('protocol'), videoCodec: str('vcodec'),
        audioCodec: str('acodec'), width: positiveInteger(item.width) ? item.width : undefined,
        height: positiveInteger(item.height) ? item.height : undefined,
        sizeBytes: positiveInteger(item.filesize) ? item.filesize : undefined })
    }
  }
  let thumbnail: string | null = null
  if (typeof data.thumbnail === 'string' && data.thumbnail.length <= 4096) {
    try {
      const url = new URL(data.thumbnail)
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && /(^|\.)fbcdn\.net$/.test(url.hostname)) thumbnail = url.href
    } catch { /* Some sources have no valid thumbnail. */ }
  }
  const duration = typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration > 0 ? data.duration : null
  return { title: typeof data.title === 'string' && data.title.trim() ? data.title.slice(0, 180) : 'Facebook video',
    duration, thumbnail, live: data.is_live === true || data.live_status === 'is_upcoming', formats }
}

export async function inspect(url: string, signal: AbortSignal) {
  const result = await run(process.env.YTDLP_BIN || 'yt-dlp', [...commonArgs, '--dump-single-json', '--skip-download', '--', url], 40_000, signal)
  return metadata(result)
}

export async function download(ticket: MediaTicket, signal: AbortSignal) {
  const folder = await mkdtemp(join(tmpdir(), 'downloader-'))
  const cleanup = () => rm(folder, { recursive: true, force: true })
  try {
    const template = join(folder.replaceAll('%', '%%'), 'video.%(ext)s')
    const selection = ticket.selection.split('+').map(id => `all[format_id=${id}]`).join('+')
    await run(process.env.YTDLP_BIN || 'yt-dlp', [...commonArgs, '--downloader', 'native', '--fixup', 'never',
      '--max-filesize', String(maxMediaBytes), '--match-filters', `duration <=? ${maxVideoSeconds} & !is_live`,
      '--format', selection, '--merge-output-format', 'mp4', '--output', template, '--', ticket.url], 140_000, signal, true)
    const path = join(folder, 'video.mp4')
    const file = await stat(path).catch(() => null)
    if (!file?.isFile() || file.size <= 0 || file.size > maxMediaBytes) throw new ExtractionFailure('NO_FORMAT')
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-of', 'json', '-show_entries',
      'stream=codec_type,codec_name,width,height:format=duration', path], 12_000, signal)) as {
      streams: Array<{ codec_type: string, codec_name: string, width?: number, height?: number }>
      format: { duration?: string }
    }
    const video = probe.streams.find(track => track.codec_type === 'video')
    const audio = probe.streams.find(track => track.codec_type === 'audio')
    if (Number(probe.format.duration) > maxVideoSeconds + 1) throw new ExtractionFailure('TOO_LONG')
    if (video?.codec_name !== 'h264' || (audio && audio.codec_name !== 'aac') || (ticket.audioRequired && !audio)) {
      throw new ExtractionFailure('NO_FORMAT')
    }
    if (ticket.resolution && (ticket.resolution.width !== video.width || ticket.resolution.height !== video.height)) {
      throw new ExtractionFailure('NO_FORMAT')
    }
    const resolution = video.width && video.height ? `-${video.width}x${video.height}` : ''
    const stream = createReadStream(path, { signal })
    stream.once('close', () => { void cleanup().catch(() => {}) })
    return { stream, size: file.size, name: `facebook-video${resolution}.mp4` }
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}
