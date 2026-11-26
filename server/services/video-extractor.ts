import type { ExtractorBinding, MediaTicket, SourceVideo } from '#shared/extraction'
import { extractorFailure, MediaFailure } from './media'

export interface VideoExtractor {
  inspect(url: string, signal: AbortSignal): Promise<SourceVideo>
  remember(tickets: MediaTicket[]): Promise<string[]>
  download(id: string, signal: AbortSignal): Promise<Response>
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
      return await (await invoke('/inspect', { url }, signal)).json() as SourceVideo
    },
    remember: tickets => binding.remember(tickets),
    async download(id, signal) {
      const ticket = await binding.lookup(id)
      if (!ticket) throw new MediaFailure('EXPIRED')
      return invoke('/download', ticket, signal)
    }
  }
}
