import { maxMediaBytes, maxVideoSeconds, positiveInteger } from './extraction.ts'
import type { ExtractorError, MediaChoice, SourceVideo } from './extraction.ts'

const isAac = (codec?: string) => /^(?:aac|mp4a)/.test(codec || '')
const unspecified = (codec?: string) => !codec || codec === 'unknown'
const webProtocols = new Set(['https', 'http_dash_segments', 'm3u8_native'])

export function chooseFormats(source: SourceVideo): MediaChoice[] | ExtractorError {
  if (source.live) return 'UNAVAILABLE'
  if (source.duration !== null && source.duration > maxVideoSeconds) return 'TOO_LONG'
  const formats = source.formats.filter(item => item.protocol && webProtocols.has(item.protocol)).toReversed()
  const audio = formats.find(item => item.ext === 'm4a' && item.videoCodec === 'none' && isAac(item.audioCodec))
  const knownAudio = formats.some(item => !unspecified(item.audioCodec) && item.audioCodec !== 'none')
  const choices = new Map<string, MediaChoice>()
  for (const format of formats) {
    if (format.ext !== 'mp4' || (!unspecified(format.videoCodec) && !/^(?:avc|h264)/.test(format.videoCodec || ''))) continue
    let selection = format.id
    let sizeBytes = format.sizeBytes ?? null
    // An estimated size can only remove a format, so an unknown or exact size is never replaced by a guess.
    let estimate = sizeBytes ?? format.approxBytes ?? null
    let audioRequired = isAac(format.audioCodec)
    if (format.audioCodec === 'none' && audio) {
      selection += `+${audio.id}`
      sizeBytes = sizeBytes && audio.sizeBytes ? sizeBytes + audio.sizeBytes : null
      const audioEstimate = audio.sizeBytes ?? audio.approxBytes
      estimate = estimate && audioEstimate ? estimate + audioEstimate : estimate
      audioRequired = true
    } else if (!unspecified(format.audioCodec) && !audioRequired && (format.audioCodec !== 'none' || knownAudio)) continue
    if ((sizeBytes ?? estimate ?? 0) > maxMediaBytes) continue

    const resolution = positiveInteger(format.width) && positiveInteger(format.height)
      ? { width: format.width, height: format.height } : null
    const sourceQuality = format.id === 'hd' || format.id === 'sd' ? format.id : undefined
    const key = resolution ? `${resolution.width}x${resolution.height}` : sourceQuality ?? 'unknown'
    const previous = choices.get(key)
    if (!previous || (audioRequired && !previous.audioRequired)) {
      const mediaUrl = selection === format.id ? format.mediaUrl : undefined
      choices.set(key, { selection, sizeBytes, audioRequired, resolution, sourceQuality, mediaUrl })
    }
  }
  const dimension = (choice: MediaChoice) => choice.resolution ? Math.min(choice.resolution.width, choice.resolution.height) : 0
  const sorted = [...choices.values()].filter(choice => choice.resolution).sort((a, b) => dimension(b) - dimension(a))
  if (!sorted.length) {
    for (const tier of ['hd', 'sd']) {
      const choice = choices.get(tier)
      if (choice) sorted.push(choice)
    }
    const unknown = choices.get('unknown')
    if (!sorted.length && unknown) sorted.push(unknown)
  }
  if (!sorted.length) return 'NO_FORMAT'
  return sorted.slice(0, 8)
}
