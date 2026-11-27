export interface Resolution {
  width: number
  height: number
}

export type SourceQuality = 'hd' | 'sd'

export const platformNames = { facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok' } as const
export type VideoPlatform = keyof typeof platformNames

export interface DownloadQuality {
  id: string
  resolution: Resolution | null
  sizeBytes: number | null
  sourceQuality?: SourceQuality
}

export interface InspectedVideo {
  platform: VideoPlatform
  title: string
  durationSeconds: number | null
  thumbnail: string | null
  qualities: DownloadQuality[]
}
