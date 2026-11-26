import type { H3Event } from 'h3'
import type { ExtractorBinding } from '#shared/extraction'
import { MediaFailure } from '../services/media'
import { containerExtractor } from '../services/video-extractor'

export function mediaRequest(event: H3Event) {
  const context = (event.context.cloudflare ?? event.context._platform?.cloudflare) as {
    request?: Request, env?: { DOWNLOADER?: { getByName(name: string): ExtractorBinding } }
  } | undefined
  return {
    signal: context?.request?.signal ?? new AbortController().signal,
    extractor: () => containerExtractor(context?.env?.DOWNLOADER?.getByName('beta'),
      context?.request?.headers.get('CF-Connecting-IP') || 'unknown')
  }
}

export async function readLink(event: H3Event): Promise<unknown> {
  try {
    const data = await readBody<{ url?: unknown }>(event)
    return data?.url
  } catch {
    throw new MediaFailure('INVALID_LINK')
  }
}

export function mediaHttpError(error: unknown) {
  const failure = error instanceof MediaFailure ? error : new MediaFailure('UPSTREAM_ERROR')
  return createError({ statusCode: failure.status, statusMessage: failure.message, data: { code: failure.code } })
}
