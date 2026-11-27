export interface Resolution {
  width: number
  height: number
}

export type SourceQuality = 'hd' | 'sd'

export interface DownloadQuality {
  id: string
  resolution: Resolution | null
  sizeBytes: number | null
  sourceQuality?: SourceQuality
}

export interface InspectedVideo {
  title: string
  durationSeconds: number | null
  thumbnail: string | null
  qualities: DownloadQuality[]
}
