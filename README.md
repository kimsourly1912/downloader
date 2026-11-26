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

`npm run dev` is useful for UI development. For local Worker integration with real container tooling, build Nuxt and run `npx cf dev` from `cloudflare/` with Docker running. The [beta guide](docs/cloudflare-beta.md) covers Access configuration and deployment. Use the [architecture](docs/architecture.md) and [release checks](docs/release-checks.md) to understand the system boundaries and hosted verification.
