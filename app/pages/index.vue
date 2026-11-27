<script setup lang="ts">
import { invalidLinkMessage, videoFilename } from '#shared/extraction'
import { platformNames } from '#shared/types/media'
import type { DownloadQuality, InspectedVideo } from '#shared/types/media'

const link = ref('')
const field = ref<HTMLInputElement>()
const video = ref<InspectedVideo>()
const inspecting = ref(false)
const downloading = ref<string>()
const error = ref('')
const status = ref('')
const thumbnailFailed = ref(false)
let inspection: AbortController | undefined
let transfer: AbortController | undefined

watch(link, () => {
  inspection?.abort()
  transfer?.abort()
  video.value = undefined
  error.value = ''
  status.value = ''
})

onBeforeUnmount(() => {
  inspection?.abort()
  transfer?.abort()
})

async function pasteLink() {
  field.value?.focus()
  try {
    const text = await navigator.clipboard.readText()
    if (text.trim()) link.value = text.trim()
  } catch {
    status.value = 'Paste your copied link into the field.'
  }
}

function errorMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== 'object') return fallback
  const data = ('data' in value ? value.data : value) as { statusMessage?: string } | undefined
  return data?.statusMessage || fallback
}

async function inspect() {
  if (!link.value.trim()) {
    error.value = invalidLinkMessage
    field.value?.focus()
    return
  }
  inspection?.abort()
  const current = new AbortController()
  inspection = current
  inspecting.value = true
  error.value = ''
  status.value = ''
  video.value = undefined
  thumbnailFailed.value = false
  try {
    const result = await $fetch<InspectedVideo>('/api/videos/inspect', {
      method: 'POST', body: { url: link.value.trim() }, signal: current.signal
    })
    if (!current.signal.aborted) video.value = result
  } catch (cause) {
    if (!current.signal.aborted) error.value = errorMessage(cause, 'We couldn’t check this link. Try again.')
  } finally {
    if (inspection === current) inspecting.value = false
  }
}

function qualityLabel(quality: DownloadQuality) {
  const size = quality.resolution
  if (size) return `${Math.min(size.width, size.height)}p`
  return quality.sourceQuality?.toUpperCase() ?? 'Source quality'
}

function qualityDetails(quality: DownloadQuality) {
  const size = quality.resolution
  return [
    'MP4',
    size && `${size.width} × ${size.height}`,
    quality.sizeBytes && `${(quality.sizeBytes / 1_048_576).toFixed(1)} MB`
  ].filter(Boolean).join(' · ')
}

function durationLabel(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

async function download(quality: DownloadQuality) {
  if (downloading.value) return
  const current = new AbortController()
  transfer = current
  downloading.value = quality.id
  error.value = ''
  status.value = `Preparing ${qualityLabel(quality)} download…`
  try {
    const response = await fetch(`/api/downloads/${quality.id}`, { signal: current.signal })
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      throw new Error(errorMessage(body, 'We couldn’t download this quality. Try again.'))
    }
    const file = await response.blob()
    const url = URL.createObjectURL(file)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || videoFilename(video.value?.platform)
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    status.value = 'Download sent to your browser.'
  } catch (cause) {
    if (!current.signal.aborted) {
      status.value = ''
      error.value = cause instanceof Error && cause.message !== 'Failed to fetch' && !(cause instanceof TypeError)
        ? cause.message
        : 'We couldn’t download this quality. Try again.'
    }
  } finally {
    downloading.value = undefined
  }
}
</script>

<template>
  <header class="site-header">
    <div class="site-header-inner">
      <a href="/" class="brand" aria-label="Downloader home">
        <span class="brand-mark"><UIcon name="i-lucide-arrow-down-to-line" aria-hidden="true" /></span>
        Downloader
      </a>
      <span class="platform"><span class="platform-dot" />Facebook · YouTube · TikTok</span>
    </div>
  </header>

  <main class="workspace">
    <section class="form-panel" aria-labelledby="page-title">
      <h1 id="page-title">Save a video.</h1>
      <p class="intro">Paste a public video link and download it in an available quality.</p>

      <form class="link-form" @submit.prevent="inspect">
        <label for="video-link">Video link</label>
        <div class="link-entry">
          <UIcon class="input-icon" name="i-lucide-link" aria-hidden="true" />
          <input
            id="video-link" ref="field" v-model="link" type="text" inputmode="url"
            autocomplete="off" autocapitalize="off" :spellcheck="false" maxlength="2048"
            placeholder="Paste your video link here" aria-describedby="link-help"
          >
          <UButton type="button" variant="ghost" color="neutral" size="sm" class="paste-button" @click="pasteLink">
            Paste
          </UButton>
        </div>
        <UButton type="submit" :loading="inspecting" :disabled="!!downloading" class="check-button">
          {{ inspecting ? 'Checking link…' : 'Check video' }}
          <UIcon v-if="!inspecting" name="i-lucide-arrow-right" aria-hidden="true" />
        </UButton>
        <p id="link-help" class="help-text">Copy a public video link from Facebook, YouTube, or TikTok.</p>
      </form>

      <div v-if="error" role="alert" class="notice error-notice">
        <UIcon name="i-lucide-circle-alert" aria-hidden="true" /><span>{{ error }}</span>
      </div>
      <p v-if="status" role="status" class="notice status-notice">{{ status }}</p>
    </section>

    <section class="result-panel" aria-labelledby="result-title" :aria-busy="inspecting || !!downloading">
      <div class="result-header">
        <UIcon name="i-lucide-film" aria-hidden="true" />
        <h2 id="result-title">Download options</h2>
      </div>
      <div v-if="video" class="result-content">
        <div class="video-summary">
          <img
            v-if="video.thumbnail && !thumbnailFailed" :src="video.thumbnail" alt=""
            referrerpolicy="no-referrer" @error="thumbnailFailed = true"
          >
          <span v-else class="video-placeholder"><UIcon name="i-lucide-play" aria-hidden="true" /></span>
          <div>
            <h3>{{ video.title }}</h3>
            <p>{{ platformNames[video.platform] }}<span v-if="video.durationSeconds"> · {{ durationLabel(video.durationSeconds) }}</span></p>
          </div>
        </div>
        <ul class="quality-list" aria-label="Available qualities">
          <li v-for="quality in video.qualities" :key="quality.id" class="quality-row">
            <div>
              <strong>{{ qualityLabel(quality) }}</strong>
              <p>{{ qualityDetails(quality) }}</p>
            </div>
            <UButton
              type="button" variant="outline" color="neutral" class="download-button"
              :loading="downloading === quality.id" :disabled="!!downloading && downloading !== quality.id"
              :aria-label="`Download ${qualityLabel(quality)}`" @click="download(quality)"
            >
              <UIcon v-if="downloading !== quality.id" name="i-lucide-download" aria-hidden="true" />
              Download
            </UButton>
          </li>
        </ul>
      </div>
      <div v-else class="empty-result" role="status">
        <div class="empty-icon" :class="{ 'empty-icon-checking': inspecting }">
          <UIcon :name="inspecting ? 'i-lucide-loader-circle' : 'i-lucide-download'" aria-hidden="true" />
        </div>
        <p>{{ inspecting ? 'Checking the video…' : 'Your video will appear here' }}</p>
        <span>{{ inspecting ? 'Looking for available MP4 qualities.' : 'Check a link to see its download options.' }}</span>
      </div>
    </section>
  </main>
</template>
