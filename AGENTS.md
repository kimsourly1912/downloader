# Downloader development guide

- Keep one full-stack Nuxt app and one npm lockfile. Put UI in `app/`, public HTTP routes in `server/api/`, business logic in `server/services/`, and shared contracts or pure validation in `shared/`.
- Nitro runs in Cloudflare Workers. Use Web APIs and Cloudflare bindings in Worker code. Keep process spawning, native binaries, and temporary files in `container/`.
- Use the `VideoExtractor` interface from Nitro. The container is an internal TypeScript adapter around the pinned standalone yt-dlp binary and media tools. Keep the adapter small and avoid shell commands, framework layers, and permanent media storage.
- Preserve the paste-to-download flow, truthful quality labels, and existing error behavior. Validate links and format IDs at their trust boundaries. Keep the container egress allowlist, execution deadlines, capacity limits, and cleanup in place when changing media code. The allowlist lives in `container/egress-proxy.ts` and every yt-dlp run must use it. Do not route container traffic through Worker `fetch()` or HTTPS interception, because YouTube and TikTok reject that egress.
- Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` before delivery. Use `npm run build:cloudflare` on a Docker-capable machine for the full Worker and container build. Report real-link, offline, and hosted tests separately.

See [architecture](docs/architecture.md), [Cloudflare beta setup](docs/cloudflare-beta.md), and [release checks](docs/release-checks.md).
