# Release verification

| Check | Evidence or next action |
| --- | --- |
| Offline Worker flow | Build Nuxt, then run `npm run test:runtime` to exercise public Worker routing, the extractor binding, and MP4 streaming through the actual Worker runtime. |
| Standalone image | Run `npm run build:cloudflare` and the GitHub build check. The image pins and verifies the yt-dlp release bundle and contains no Python application layer. |
| Real Facebook links | The supplied Facebook share link resolved through the local Worker runtime and TypeScript adapter. The resulting 720 × 1280 MP4 decoded with audio and video. Verify that Reel and a separate regular Facebook video through the deployed Worker to check Cloudflare egress. |
| Real YouTube and TikTok links | Run `DOWNLOADER_TEST_URL=<public-video-url> npm run test:runtime` for each platform using the pinned extractor. Then check the same links on the public deployment and decode the downloaded MP4s with audio and video. Check at least one short share URL and an unavailable video. |
| Public homepage | The deployment workflow checks that the custom domain serves Downloader without credentials. See the [deployment guide](cloudflare-beta.md). |
| Hosted lifecycle | Verify YouTube and TikTok inspection no longer report a bot check or `network-timeout` in `Server-Timing`, Facebook still streams from its CDN, and a cold container starts. The egress proxy's refusal of disallowed hosts and private addresses is covered by `npm test`. Check iOS and Android playback, time to download, and bandwidth. Compare `platform_lookup` for a first and a second YouTube link on a warm container. The second link reuses the cached player data. Also check that YouTube and TikTok downloads start without a second full extraction. |

Keep sample URLs and credentials out of commits and logs. Downloads are staged temporarily inside the container and removed when the request ends. Notice that container restarts or Durable Object eviction can expire an inspection result early.
