import { bindings, defineConfig } from 'cf/config'

export default defineConfig({
  worker: {
    name: 'downloader-facebook-probe',
    entrypoint: './worker.ts',
    compatibilityDate: '2026-11-23',
    domains: ['downloader-worker-preview.angder.app'],
    workersDev: false,
    previewUrls: false,
    env: {
      PROBE_TOKEN_SHA256: bindings.text('f45e2b13217f8a6d2b7e6dbe8e18d60a4b9d9c54bec09e84cf555f9e2ac546f2')
    }
  }
})
