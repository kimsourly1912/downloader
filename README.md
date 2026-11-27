# Downloader

A mobile-first Nuxt app that inspects guest-accessible Facebook video and Reel links and downloads an available MP4 quality. Nitro runs on Cloudflare Workers. A small TypeScript container adapter runs yt-dlp and the native media tools.

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
