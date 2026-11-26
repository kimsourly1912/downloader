import { facebookUrl, maxMediaBytes, maxVideoSeconds, positiveInteger } from '#shared/extraction'
import type { ExtractorError, MediaChoice, SourceVideo } from '#shared/extraction'
import type { InspectedVideo } from '#shared/types/media'
import type { VideoExtractor } from './video-extractor'

const messages: Record<ExtractorError, readonly [number, string]> = {
  INVALID_LINK: [400, 'Paste a Facebook video or Reel link.'],
  BUSY: [429, 'Too many requests. Try again in a moment.'],
  EXPIRED: [410, 'These download options expired. Check the link again.'],
  UNAVAILABLE: [422, 'This video is unavailable without signing in. Try a public video.'],
  NO_FORMAT: [422, 'This quality is unavailable. Check the link again or try another quality.'],
  TOO_LONG: [422, 'Choose a video no longer than 5 minutes.'],
  TOOL_UNAVAILABLE: [503, 'The download service is unavailable right now.'],
  UPSTREAM_TIMEOUT: [504, 'Facebook took too long to respond. Try again.'],
  UPSTREAM_ERROR: [502, "We couldn't load this video right now. Try again."]
}

export class MediaFailure extends Error {
  readonly status: number
  constructor(readonly code: ExtractorError) {
    const [status, message] = messages[code]
    super(message)
    this.status = status
  }
}

export function extractorFailure(value: unknown): MediaFailure {
  return new MediaFailure(typeof value === 'string' && Object.hasOwn(messages, value)
    ? value as ExtractorError : 'UPSTREAM_ERROR')
}

const isAac = (codec?: string) => /^(?:aac|mp4a)/.test(codec || '')
const unspecified = (codec?: string) => !codec || codec === 'unknown'
const webProtocols = new Set(['https', 'http_dash_segments', 'm3u8_native'])

export function chooseFormats(source: SourceVideo): MediaChoice[] {
  if (source.live) throw new MediaFailure('UNAVAILABLE')
  if (source.duration !== null && source.duration > maxVideoSeconds) throw new MediaFailure('TOO_LONG')
  const formats = source.formats.filter(item => item.protocol && webProtocols.has(item.protocol)).toReversed()
  const audio = formats.find(item => item.ext === 'm4a' && item.videoCodec === 'none' && isAac(item.audioCodec))
  const knownAudio = formats.some(item => !unspecified(item.audioCodec) && item.audioCodec !== 'none')
  const choices = new Map<string, MediaChoice>()
  for (const format of formats) {
    if (format.ext !== 'mp4' || (!unspecified(format.videoCodec) && !/^(?:avc|h264)/.test(format.videoCodec || ''))) continue
    let selection = format.id
    let sizeBytes = format.sizeBytes ?? null
    let audioRequired = isAac(format.audioCodec)
    if (format.audioCodec === 'none' && audio) {
      selection += `+${audio.id}`
      sizeBytes = sizeBytes && audio.sizeBytes ? sizeBytes + audio.sizeBytes : null
      audioRequired = true
    } else if (!unspecified(format.audioCodec) && !audioRequired && (format.audioCodec !== 'none' || knownAudio)) continue
    if (sizeBytes !== null && sizeBytes > maxMediaBytes) continue

    const resolution = positiveInteger(format.width) && positiveInteger(format.height)
      ? { width: format.width, height: format.height } : null
    const key = resolution ? `${resolution.width}x${resolution.height}` : 'unknown'
    const previous = choices.get(key)
    if (!previous || (audioRequired && !previous.audioRequired)) {
      choices.set(key, { selection, sizeBytes, audioRequired, resolution })
    }
  }
  const dimension = (choice: MediaChoice) => choice.resolution ? Math.min(choice.resolution.width, choice.resolution.height) : 0
  const sorted = [...choices.values()].filter(choice => choice.resolution).sort((a, b) => dimension(b) - dimension(a))
  const unknown = choices.get('unknown')
  if (!sorted.length && unknown) sorted.push(unknown)
  if (!sorted.length) throw new MediaFailure('NO_FORMAT')
  return sorted.slice(0, 8)
}

export async function inspectVideo(input: unknown, extractor: VideoExtractor, signal: AbortSignal): Promise<InspectedVideo> {
  const url = facebookUrl(input)
  if (!url) throw new MediaFailure('INVALID_LINK')
  const source = await extractor.inspect(url, signal)
  const choices = chooseFormats(source)
  const ids = await extractor.remember(choices.map(choice => ({ ...choice, url })))
  return {
    title: source.title,
    durationSeconds: source.duration === null ? null : Math.round(source.duration),
    thumbnail: source.thumbnail,
    qualities: choices.map((choice, i) => ({ id: ids[i]!, sizeBytes: choice.sizeBytes, resolution: choice.resolution }))
  }
}
