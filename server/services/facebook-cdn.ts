import { facebookMediaUrl, maxMediaBytes, maxTransferMs, maxVideoSeconds, positiveInteger } from '#shared/extraction'
import type { MediaTicket } from '#shared/extraction'

const metadataLimit = 512 * 1024
const redirectStatuses = new Set([301, 302, 303, 307, 308])

interface Box {
  type: string
  data: number
  end: number
}

function boxAt(view: DataView, start: number): Box {
  const size = view.getUint32(start)
  if (size < 8) throw new Error('Unsupported MP4 box size')
  const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + start + 4, 4))
  return { type, data: start + 8, end: start + size }
}

function* children(view: DataView, box: Box) {
  for (let offset = box.data; offset + 8 <= box.end;) {
    const child = boxAt(view, offset)
    if (child.end > box.end) throw new Error('Invalid MP4 metadata')
    yield child
    offset = child.end
  }
}

function child(view: DataView, box: Box, type: string) {
  return children(view, box).find(entry => entry.type === type)
}

function compatibleTracks(view: DataView, movie: Box, ticket: MediaTicket) {
  const header = child(view, movie, 'mvhd')
  if (!header || header.end - header.data < 20) return false
  const version = view.getUint8(header.data)
  if (version > 1 || (version === 1 && header.end - header.data < 32)) return false
  const scale = view.getUint32(header.data + (version ? 20 : 12))
  const ticks = version ? Number(view.getBigUint64(header.data + 24)) : view.getUint32(header.data + 16)
  const duration = ticks / scale
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxVideoSeconds + 1) return false

  let hasVideo = false
  let hasAudio = false
  for (const track of children(view, movie).filter(entry => entry.type === 'trak')) {
    const media = child(view, track, 'mdia')
    const info = media && child(view, media, 'minf')
    const table = info && child(view, info, 'stbl')
    const samples = table && child(view, table, 'stsd')
    if (!samples || samples.end - samples.data < 16 || view.getUint32(samples.data + 4) !== 1) return false
    const codec = boxAt(view, samples.data + 8)
    if (codec.end > samples.end) return false
    if (codec.type === 'mp4a') {
      hasAudio = true
    } else if (codec.type === 'avc1' || codec.type === 'avc3') {
      if (codec.end - codec.data < 28) return false
      const width = view.getUint16(codec.data + 24)
      const height = view.getUint16(codec.data + 26)
      if (!width || !height || (ticket.resolution &&
          (width !== ticket.resolution.width || height !== ticket.resolution.height))) return false
      hasVideo = true
    } else {
      return false
    }
  }
  return hasVideo && hasAudio
}

/** Check the front-loaded MP4 metadata. Other MP4 layouts use the native fallback. */
function checkPrefix(prefix: Uint8Array, length: number, ticket: MediaTicket): boolean | undefined {
  const view = new DataView(prefix.buffer, prefix.byteOffset, length)
  for (let offset = 0; offset + 8 <= length;) {
    const box = boxAt(view, offset)
    if ((!offset && box.type !== 'ftyp') || box.type === 'mdat' || box.end > metadataLimit) return false
    if (box.end > length) return
    if (box.type === 'moov') return compatibleTracks(view, box, ticket)
    offset = box.end
  }
}

async function openMedia(url: string, signal: AbortSignal) {
  for (let hop = 0; hop <= 2; hop++) {
    const response = await fetch(url, { redirect: 'manual', cache: 'no-store', signal })
    if (!redirectStatuses.has(response.status)) return response
    const location = response.headers.get('Location')
    await response.body?.cancel()
    const next = location && facebookMediaUrl(new URL(location, url).href)
    if (!next) return
    url = next
  }
}

export async function streamFacebookMp4(ticket: MediaTicket, signal: AbortSignal) {
  const url = facebookMediaUrl(ticket.mediaUrl)
  if (!url) return { fallback: 'no_url' } as const
  const started = performance.now()
  const connection = new AbortController()
  const headerDeadline = setTimeout(() => connection.abort(), 10_000)
  const upstreamSignal = AbortSignal.any([connection.signal, signal, AbortSignal.timeout(maxTransferMs)])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let streaming = false
  try {
    const upstream = await openMedia(url, upstreamSignal)
    reader = upstream?.body?.getReader()
    const length = Number(upstream?.headers.get('Content-Length'))
    if (!upstream || upstream.status !== 200) return { fallback: 'upstream_status' } as const
    if (!reader || !positiveInteger(length) || length > maxMediaBytes ||
        upstream.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'video/mp4' ||
        ![null, 'identity'].includes(upstream.headers.get('Content-Encoding'))) return { fallback: 'response_headers' } as const

    const source = reader
    const prefix = new Uint8Array(Math.min(length, metadataLimit))
    const buffered: Uint8Array[] = []
    let bytes = 0
    while (bytes < prefix.length) {
      const { value, done } = await source.read()
      if (done || value.length + bytes > length) return { fallback: 'response_body' } as const
      buffered.push(value)
      prefix.set(value.subarray(0, prefix.length - bytes), bytes)
      bytes += value.length
      const valid = checkPrefix(prefix, Math.min(bytes, prefix.length), ticket)
      if (valid === false) return { fallback: 'mp4_metadata' } as const
      if (valid) {
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const pending = buffered.shift()
            if (pending) {
              controller.enqueue(pending)
              return
            }
            const { value: chunk, done: eof } = await source.read()
            if (eof) {
              if (bytes !== length) throw new Error('Incomplete video')
              controller.close()
              return
            }
            bytes += chunk.length
            if (bytes > length) {
              await source.cancel()
              throw new Error('Unexpected video size')
            }
            controller.enqueue(chunk)
          },
          cancel: reason => source.cancel(reason)
        })
        const response = new Response(body, { headers: {
          'Content-Type': 'video/mp4', 'Content-Length': String(length), 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Server-Timing': `facebook_cdn;dur=${Math.round(performance.now() - started)}`
        } })
        streaming = true
        return { response }
      }
    }
    return { fallback: 'mp4_metadata' } as const
  } catch {
    return { fallback: 'fetch_failed' } as const
  } finally {
    clearTimeout(headerDeadline)
    if (!streaming) {
      connection.abort()
      await reader?.cancel().catch(() => {})
    }
  }
}
