import { inspectVideo, limitRequests, MediaFailure } from '../../services/media'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  try {
    limitRequests(getRequestIP(event))
    const length = Number(getRequestHeader(event, 'content-length'))
    if (length > 4096) throw new MediaFailure('INVALID_LINK')
    let body: { url?: unknown } | undefined
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      const request = event.node.req
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 4096) {
          request.resume()
          throw new MediaFailure('INVALID_LINK')
        }
        chunks.push(buffer)
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new MediaFailure('INVALID_LINK')
    }
    return await inspectVideo(body?.url, mediaSignal(event))
  } catch (error) {
    throw mediaHttpError(error)
  }
})
