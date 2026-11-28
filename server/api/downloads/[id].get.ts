import { videoFilename } from '#shared/extraction'
import { MediaFailure } from '../../services/media'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  try {
    const id = getRouterParam(event, 'id') || ''
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id)) throw new MediaFailure('EXPIRED')
    const { signal, extractor } = mediaRequest(event)
    const { response: download, platform } = await (await extractor()).download(id, signal)
    const headers = new Headers(download.headers)
    headers.set('Content-Disposition', `attachment; filename="${videoFilename(platform)}"`)
    return new Response(download.body, { status: download.status, headers })
  } catch (error) {
    if (error instanceof MediaFailure && error.diagnostic) {
      const { containerMs } = error
      setResponseHeader(event, 'Server-Timing', `container;${containerMs === undefined ? '' : `dur=${containerMs};`}desc="${error.diagnostic}"`)
    }
    throw mediaHttpError(error)
  }
})
