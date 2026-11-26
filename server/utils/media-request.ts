import type { H3Event } from 'h3'
import { MediaFailure } from '../services/media'

export function mediaSignal(event: H3Event) {
  const controller = new AbortController()
  event.node.res.once('close', () => controller.abort())
  return controller.signal
}

export function mediaHttpError(error: unknown) {
  const failure = error instanceof MediaFailure ? error : new MediaFailure('UPSTREAM_ERROR')
  return createError({
    statusCode: failure.status,
    statusMessage: failure.message,
    data: { code: failure.code }
  })
}
