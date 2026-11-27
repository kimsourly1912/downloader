import { MediaFailure } from '../../services/media'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  try {
    const id = getRouterParam(event, 'id') || ''
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id)) throw new MediaFailure('EXPIRED')
    const { signal, extractor } = mediaRequest(event)
    return await (await extractor()).download(id, signal)
  } catch (error) {
    throw mediaHttpError(error)
  }
})
