# Downloader architecture

## Audit

The previous deployment put the Nuxt UI and Nitro API in the same Docker image as a Python driver, a Python CLI prototype, yt-dlp, and FFmpeg. A Cloudflare Worker forwarded the entire app to that image. The repo also maintained a separate npm manifest for the Worker and multiple checks for the prototype. The Vue screen, the two public routes, format rules, download expiry, and the one-container beta model are worth retaining. Moving the native subprocess code out of Nitro is required for the Worker runtime.

## Revised design

| Area | Responsibility |
| --- | --- |
| `app/` | Existing paste, quality selection, error, and download UI. |
| `server/api/` | Nitro HTTP handlers for `POST /api/videos/inspect` and `GET /api/downloads/:id`. |
| `server/services/` | Validate links, choose supported MP4 qualities, and map domain errors. Delegate media operations through the `VideoExtractor` interface. |
| `shared/` | Validate platform URL shapes and select compatible source formats. |
| `cloudflare/` | Minimal public deployment entrypoint and one Container-backed Durable Object. The Worker runs Nitro. The object tracks expiring opaque options and per-client request limits. |
| `container/` | Native Node HTTP adapter in TypeScript. Runs the standalone yt-dlp executable, stages bounded files, checks actual media streams, and streams the result. FFmpeg merges tracks when the chosen format needs it. |

Nuxt builds with Nitro's `cloudflare_module` preset. The deployment entrypoint exports the container class alongside the generated Nitro Worker. Visitors can use the app and its API without signing in. The container handles internal inspection and download operations.

Inspection keeps eligible Facebook CDN URLs on the server in the same short-lived tickets as format selections. During a Facebook download, the Worker checks the CDN response size and the MP4's initial metadata, then streams the body as it arrives. It uses the container when the URL is missing or expired, the file needs separate tracks merged, or the metadata is incompatible with direct streaming. YouTube and TikTok use the container download path. The public API exposes the source platform and quality options with opaque ticket IDs.

The app uses one Basic container with a two-minute idle timeout by default. The Durable Object shares overlapping lookups for the same URL and caches successful results for up to one minute, or less when Facebook provides an earlier media expiry. Failed lookups can be retried. The inspection response reports cache status, extractor time, and container overhead through `Server-Timing`. Container overhead includes startup on cold requests and transport time.

Download tickets expire after ten minutes and survive container shutdown and Durable Object restarts in SQLite. The database keeps at most 512 tickets and removes expired entries on new issuance. A known expired CDN URL triggers the container download fallback. The API and container validate HTTPS link shapes for each supported platform. The container uses a deny-by-default outbound allowlist for the platforms and their media domains. Subprocess commands use fixed executables and arguments with no shell expansion, and format IDs must match the internal format grammar. The Node adapter runs at most two jobs at once and applies subprocess deadlines, file-size limits, and cleanup when a request closes. The response is streamed through Nitro. Files live only on the container's temporary disk, so the app needs no R2 bucket or permanent media storage.

YouTube watch links, Shorts, and youtu.be shares normalize to a single watch URL per video. TikTok video and share links discard tracking parameters. The container enables its existing Node runtime for yt-dlp's bundled YouTube scripts. Lists and live streams are outside the download flow. Platforms may restrict access to individual videos or requests from a hosting provider, and the app displays the extraction error.
