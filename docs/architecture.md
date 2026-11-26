# Downloader MVP architecture

## Product scope

A guest pastes a Facebook video or Reel link copied from the Facebook mobile app, sees the available qualities, and downloads a playable file. Start with authorized public videos accessible without a Facebook login. A source with a single usable format still gets a download button.

The first release offers only source resolutions the app can package into a playable MP4. Prefer compatible formats with sound where the source has sound, and merge compatible separate tracks when needed. Label portrait and landscape formats with their actual dimensions when a single quality label could be ambiguous.

## Deployment

Keep the web MVP in a single repository and Docker deployment on a Node.js host. Nuxt and Nuxt UI render the mobile screen in the browser. Nitro serves the HTTP routes. Server-side services invoke pinned `yt-dlp` and FFmpeg binaries as subprocesses. `Dockerfile.web` packages the web app, and the original `Dockerfile` builds the standalone extractor prototype for direct checks.

| Area | Responsibility |
| --- | --- |
| `app/` | Paste field, inspection progress, video details, download buttons, and actionable errors. |
| `server/api/` | Validate HTTP parameters and return structured results or the MP4 response. |
| `server/services/` | Validate and resolve Facebook links, choose playable formats, and handle transfer and cleanup. Keep Facebook rules here so additional sources can use the same API contract. |
| `shared/` | Types for the inspected video, its available qualities, and UI-visible errors. |

## HTTP contract

| Endpoint | Expected behavior |
| --- | --- |
| `POST /api/videos/inspect` | Accept `{ "url": "…" }`. Return video metadata where available and a list of quality options. An option includes a short-lived `downloadId`, its width and height, and `sizeBytes` when known. |
| `GET /api/downloads/:id` | Look up the chosen option and return an MP4 attachment. For expiring upstream URLs, resolve the source again and confirm the selected format before sending the file. |

Map invalid or unsupported input to a link error, inaccessible videos to an unavailable error, expired options to **Check this video again**, and transient upstream failures to **Try again**. If the selected resolution is gone after rechecking, return refreshed options through inspection so the user can choose again.

## Data and execution

Keep short-lived download records in bounded memory for the first single-instance deployment. Each record holds the validated source URL, the selected format, and the expiry. Server restarts expire existing IDs, so the browser can inspect the link again. Stage the selected MP4 on temporary disk, validate the streams, send it from the server as a stream, and clear the files when the response closes or preparation fails. The browser buffers this response to show errors before handing it to the save dialog. The first version limits an output file to 64 MiB and known video durations to five minutes.

Before enabling guest traffic, restrict the accepted Facebook link shapes and the media process's outbound access, including redirects and access to private networks. Pass trusted format selections and validated inputs as subprocess arguments. Set request rate, concurrency, file size, runtime, and disk limits. Log outcomes, timings, and transfer sizes to distinguish upstream failures from resource limits.

## Build order

1. Verify the Docker prototype and Nuxt flow with generated fixtures.
2. Complete the [live video and Reel checks](release-checks.md) on the beta host using links copied from the Facebook app.
3. Run a private beta and measure success rate across link types, download time, and outgoing traffic. Use those results to decide release limits and the next platform to evaluate.
