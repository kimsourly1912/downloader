# Downloader

A mobile-first Nuxt app that checks public Facebook videos and Reels, YouTube videos and Shorts, and TikTok videos. It shows the compatible MP4 qualities available from the source, up to five minutes and 64 MiB per file. Nitro runs on Cloudflare Workers. A small TypeScript container adapter runs yt-dlp and the native media tools.

## Check the project

Use Node.js 24 and npm.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run test:runtime
```

`npm run dev` is useful for UI development. For local Worker integration, build Nuxt and run `npx cf dev` from the repository root with Docker running. See the [deployment guide](docs/cloudflare-beta.md), [architecture](docs/architecture.md), and [release checks](docs/release-checks.md) for deployment and verification.
