export interface Resolution {
  width: number
  height: number
}

export interface DownloadQuality {
  id: string
  resolution: Resolution | null
  sizeBytes: number | null
}

export interface InspectedVideo {
  title: string
  durationSeconds: number | null
  thumbnail: string | null
  qualities: DownloadQuality[]
}
