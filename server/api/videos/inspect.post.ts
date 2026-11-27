import { inspectVideo } from '../../services/media'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  try {
    const { signal, extractor } = mediaRequest(event)
    const url = await readLink(event)
    return await inspectVideo(url, await extractor(), signal)
  } catch (error) {
    throw mediaHttpError(error)
  }
})
