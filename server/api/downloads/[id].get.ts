import { limitRequests, prepareDownload, MediaFailure } from '../../services/media'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  try {
    limitRequests(getRequestIP(event))
    const id = getRouterParam(event, 'id') || ''
    if (!/^[a-f\d-]{36}$/.test(id)) throw new MediaFailure('EXPIRED')
    const file = await prepareDownload(id, mediaSignal(event))
    setResponseHeaders(event, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(file.size),
      'Content-Disposition': `attachment; filename="${file.name}"`,
      'X-Content-Type-Options': 'nosniff'
    })
    return sendStream(event, file.stream)
  } catch (error) {
    throw mediaHttpError(error)
  }
})
