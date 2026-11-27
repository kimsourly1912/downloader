# Downloader architecture

## Audit

The previous deployment put the Nuxt UI and Nitro API in the same Docker image as a Python driver, a Python CLI prototype, yt-dlp, and FFmpeg. A Cloudflare Worker forwarded the entire app to that image. The repo also maintained a separate npm manifest for the Worker and multiple checks for the prototype. The Vue screen, the two public routes, format rules, download expiry, and the one-container beta model are worth retaining. Moving the native subprocess code out of Nitro is required for the Worker runtime.

## Revised design

| Area | Responsibility |
| --- | --- |
| `app/` | Existing paste, quality selection, error, and download UI. |
| `server/api/` | Nitro HTTP handlers for `POST /api/videos/inspect` and `GET /api/downloads/:id`. |
| `server/services/` | Validate links, choose supported MP4 qualities, and map domain errors. Delegate media operations through the `VideoExtractor` interface. |
| `cloudflare/` | Minimal public deployment entrypoint and one Container-backed Durable Object. The Worker runs Nitro. The object tracks expiring opaque options and per-client request limits. |
| `container/` | Native Node HTTP adapter in TypeScript. Runs the standalone yt-dlp executable, stages bounded files, checks actual media streams, and streams the result. FFmpeg merges tracks when the chosen format needs it. |

Nuxt builds with Nitro's `cloudflare_module` preset. The deployment entrypoint exports the container class alongside the generated Nitro Worker. Visitors can use the app and its API without signing in. The container handles internal inspection and download operations.

The app uses one Basic container with a ten-minute idle timeout. Download tickets expire after ten minutes and may expire early if the Durable Object restarts. Both API and container validate Facebook link shapes. The container uses a deny-by-default outbound allowlist for Facebook and its media domains. Subprocess commands use fixed executables and arguments with no shell expansion, and format IDs must match the internal format grammar. The Node adapter runs at most two jobs at once and applies subprocess deadlines, file-size limits, and cleanup when a request closes. The response is streamed through Nitro. Files live only on the container's temporary disk, so the app needs no R2 bucket or permanent media storage.

Keep the initial product to guest-accessible Facebook videos and Reels. Add a source only after checking real links, runtime permissions, and the outbound domains needed for that source.
