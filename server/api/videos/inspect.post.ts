import { inspectVideo } from '../../services/media'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  try {
    const { signal, extractor } = mediaRequest(event)
    const url = await readLink(event)
    return await inspectVideo(url, await extractor(), signal, timing => {
      const metrics = [`inspect_cache;desc="${timing.cache}"`]
      if (timing.extractorMs !== undefined) {
        const detail = timing.diagnostic ? `;desc="${timing.diagnostic}"` : ''
        metrics.push(`platform_lookup;dur=${timing.extractorMs}${detail}`)
      }
      if (timing.containerMs !== undefined) {
        const overhead = Math.max(0, timing.containerMs - (timing.extractorMs ?? 0))
        const detail = timing.container ? `;desc="${timing.container}"` : ''
        metrics.push(`${timing.extractorMs === undefined ? 'container_total' : 'container_overhead'};dur=${overhead}${detail}`)
      }
      setResponseHeader(event, 'Server-Timing', metrics.join(', '))
    })
  } catch (error) {
    throw mediaHttpError(error)
  }
})
