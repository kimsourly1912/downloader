import { bindings, defineConfig, defineContainer, exports } from 'cf/config'

const workerName = 'downloader-beta'
const container = defineContainer({
  name: 'downloader-beta',
  image: { dockerfile: './Dockerfile' },
  instanceType: 'basic',
  maxInstances: 1
})

export default defineConfig({
  containers: [container],
  worker: {
    name: workerName,
    entrypoint: './cloudflare/worker.ts',
    compatibilityDate: '2026-11-23',
    compatibilityFlags: ['nodejs_compat'],
    domains: ['downloader.angder.app'],
    workersDev: false,
    previewUrls: false,
    assets: { runWorkerFirst: true },
    exports: {
      DownloaderContainer: exports.durableObject({ storage: 'sqlite', container })
    },
    env: {
      DOWNLOADER: bindings.durableObject({ worker: workerName, exportName: 'DownloaderContainer' }),
      ASSETS: bindings.assets()
    }
  }
})
