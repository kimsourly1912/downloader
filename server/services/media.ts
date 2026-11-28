import { invalidLinkMessage, resolveVideoLink } from '#shared/extraction'
import type { ExtractorError, InspectionTiming } from '#shared/extraction'
import type { InspectedVideo } from '#shared/types/media'
import type { VideoExtractor } from './video-extractor'

const messages: Record<ExtractorError, readonly [number, string]> = {
  INVALID_LINK: [400, invalidLinkMessage],
  BUSY: [429, 'Too many requests. Try again in a moment.'],
  EXPIRED: [410, 'These download options expired. Check the link again.'],
  UNAVAILABLE: [422, 'This video is unavailable without signing in. Try a public video.'],
  NO_FORMAT: [422, 'This quality is unavailable. Check the link again or try another quality.'],
  TOO_LONG: [422, 'Choose a video no longer than 2 hours.'],
  TOOL_UNAVAILABLE: [503, 'The download service is unavailable right now.'],
  UPSTREAM_TIMEOUT: [504, 'The video platform took too long to respond. Try again.'],
  UPSTREAM_RESTRICTED: [503, 'The video platform asked our server to sign in. Try another public link.'],
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

export async function inspectVideo(input: unknown, extractor: VideoExtractor, signal: AbortSignal, onTiming: (timing: InspectionTiming) => void): Promise<InspectedVideo> {
  const link = resolveVideoLink(input)
  if (!link) throw new MediaFailure('INVALID_LINK')
  const { platform, url } = link
  const result = await extractor.inspect(url, signal)
  onTiming(result.timing)
  if ('failure' in result) throw extractorFailure(result.failure)
  const { choices, infoKey, ...source } = result.video
  const ids = await extractor.remember(choices.map(choice => ({ ...choice, url, infoKey })))
  return {
    platform,
    title: source.title,
    durationSeconds: source.duration === null ? null : Math.round(source.duration),
    thumbnail: source.thumbnail,
    qualities: choices.map((choice, i) => ({ id: ids[i]!, sizeBytes: choice.sizeBytes,
      resolution: choice.resolution, sourceQuality: choice.sourceQuality }))
  }
}
