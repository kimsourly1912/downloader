import { createServer } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { facebookUrl, positiveInteger, validSelection } from '../shared/extraction.ts'
import type { MediaTicket } from '../shared/extraction.ts'
import { download, ExtractionFailure, inspect, loadCloudflareCa } from './extractor.ts'

await loadCloudflareCa()
let active = 0

const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200).end('ready')
    return
  }
  if (request.method !== 'POST' || !['/inspect', '/download'].includes(request.url || '')) {
    response.writeHead(404).end()
    return
  }
  if (active >= 2) {
    response.writeHead(429, { 'X-Downloader-Error': 'BUSY' }).end()
    return
  }

  active += 1
  const controller = new AbortController()
  response.once('close', () => controller.abort())
  const deadline = setTimeout(() => { controller.abort(); response.destroy() }, 180_000)
  try {
    const parts: Buffer[] = []
    let length = 0
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > 8192) { request.resume(); throw new ExtractionFailure('INVALID_LINK') }
      parts.push(bytes)
    }
    const data = JSON.parse(Buffer.concat(parts).toString('utf8')) as Partial<MediaTicket>
    const url = facebookUrl(data?.url)
    if (!url) throw new ExtractionFailure('INVALID_LINK')
    if (request.url === '/inspect') {
      const source = await inspect(url, controller.signal)
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(source))
      return
    }

    if (!validSelection(data.selection) || typeof data.audioRequired !== 'boolean' ||
        (data.resolution !== null && (!positiveInteger(data.resolution?.width) || !positiveInteger(data.resolution?.height)))) {
      throw new ExtractionFailure('NO_FORMAT')
    }
    const result = await download({ url, selection: data.selection, audioRequired: data.audioRequired,
      resolution: data.resolution, sizeBytes: null }, controller.signal)
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': result.size,
      'Content-Disposition': `attachment; filename="${result.name}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
    await pipeline(result.stream, response)
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      const code = error instanceof ExtractionFailure ? error.code : error instanceof SyntaxError ? 'INVALID_LINK' : 'UPSTREAM_ERROR'
      response.writeHead(422, { 'X-Downloader-Error': code, 'Cache-Control': 'no-store' }).end()
    } else if (!response.destroyed) response.destroy()
  } finally {
    clearTimeout(deadline)
    active -= 1
  }
})

server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1')
