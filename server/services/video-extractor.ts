import { resolveVideoLink } from '#shared/extraction'
import type { ExtractorBinding, InspectionResult, MediaTicket, SourceVideo } from '#shared/extraction'
import type { VideoPlatform } from '#shared/types/media'
import { chooseFormats } from '#shared/video-formats'
import { streamFacebookMp4 } from './facebook-cdn'
import { extractorFailure, MediaFailure } from './media'

export interface VideoExtractor {
  inspect(url: string, signal: AbortSignal): Promise<InspectionResult>
  remember(tickets: MediaTicket[]): Promise<string[]>
  download(id: string, signal: AbortSignal): Promise<{ response: Response, platform: VideoPlatform }>
}

export async function containerExtractor(binding: ExtractorBinding | undefined, client: string): Promise<VideoExtractor> {
  if (!binding) throw new MediaFailure('TOOL_UNAVAILABLE')
  if (!await binding.consume(client)) throw new MediaFailure('BUSY')

  async function invoke(path: string, body: object, signal: AbortSignal) {
    const response = await binding!.fetch(new Request(`http://extractor.internal${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal
    }))
    if (!response.ok) {
      const failure = extractorFailure(response.headers.get('X-Downloader-Error'))
      await response.body?.cancel()
      throw failure
    }
    return response
  }

  return {
    async inspect(url, signal) {
      signal.throwIfAborted()
      try {
        const response = await invoke('/inspect-cached', { url }, signal)
        const result = await response.json() as InspectionResult
        if (result.timing && ('video' in result || result.failure)) return result
      } catch {
        signal.throwIfAborted()
      }
      const start = performance.now()
      const response = await invoke('/inspect', { url }, signal)
      const source = await response.json() as SourceVideo
      const choices = chooseFormats(source)
      const timing = { cache: 'miss' as const, containerMs: Math.round(performance.now() - start) }
      if (typeof choices === 'string') return { failure: choices, timing }
      return { video: { title: source.title, thumbnail: source.thumbnail, duration: source.duration, choices }, timing }
    },
    remember: tickets => binding.remember(tickets),
    async download(id, signal) {
      const ticket = await binding.lookup(id)
      if (!ticket) throw new MediaFailure('EXPIRED')
      const link = resolveVideoLink(ticket.url)
      if (!link) throw new MediaFailure('EXPIRED')
      const { platform } = link
      const direct = platform === 'facebook' ? await streamFacebookMp4(ticket, signal) : undefined
      if (direct?.response) return { response: direct.response, platform }
      signal.throwIfAborted()
      const start = performance.now()
      const response = await invoke('/download', ticket, signal)
      const headers = new Headers(response.headers)
      const detail = direct ? `;desc="${direct.fallback}"` : ''
      headers.set('Server-Timing', `container;dur=${Math.round(performance.now() - start)}${detail}`)
      return { response: new Response(response.body, { status: response.status, headers }), platform }
    }
  }
}
