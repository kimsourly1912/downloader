import { bindings, defineConfig, defineContainer, exports } from 'cf/config'

const workerName = 'downloader-beta'
const container = defineContainer({
  name: 'downloader-beta',
  image: { dockerfile: '../Dockerfile.web' },
  instanceType: 'basic',
  maxInstances: 1
})

export default defineConfig({
  containers: [container],
  worker: {
    name: workerName,
    entrypoint: './worker.ts',
    compatibilityDate: '2026-11-27',
    workersDev: true,
    previewUrls: false,
    exports: {
      DownloaderContainer: exports.durableObject({ storage: 'sqlite', container })
    },
    env: {
      DOWNLOADER: bindings.durableObject({ worker: workerName, exportName: 'DownloaderContainer' }),
      BETA_ACCESS_AUD: bindings.text(process.env.DOWNLOADER_ACCESS_AUD?.trim() ?? '')
    }
  }
})
