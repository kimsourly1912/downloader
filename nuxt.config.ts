export default defineNuxtConfig({
  ssr: false,
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: { fonts: false, colorMode: false },
  icon: {
    clientBundle: {
      icons: ['lucide:arrow-down-to-line', 'lucide:arrow-right', 'lucide:circle-alert', 'lucide:download',
        'lucide:film', 'lucide:link', 'lucide:loader-circle', 'lucide:play']
    }
  },
  app: {
    head: {
      title: 'Downloader | Save a video',
      htmlAttrs: { lang: 'en' },
      meta: [{ name: 'description', content: 'Check a public Facebook, YouTube, or TikTok video link and download an available MP4 quality.' }]
    }
  },
  nitro: { preset: 'cloudflare_module', cloudflare: { deployConfig: false } },
  compatibilityDate: '2026-11-23',
  telemetry: false
})
