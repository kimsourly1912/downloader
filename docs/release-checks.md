# Release verification

| Check | Evidence or next action |
| --- | --- |
| Offline Worker flow | Build Nuxt, then run `npm run test:runtime` to exercise Worker routing, Access enforcement, the extractor binding, and MP4 streaming through the actual Worker runtime. |
| Standalone image | Run `npm run build:cloudflare` and the GitHub build check. The image pins and verifies yt-dlp and contains no Python application layer. |
| Real Facebook links | The supplied Facebook share link resolved through the local Worker runtime and TypeScript adapter. The resulting 720 × 1280 MP4 decoded with audio and video. Verify that Reel and a separate regular Facebook video through the deployed Worker to check Cloudflare egress. |
| Cloudflare access | The connected Cloudflare session previously denied Worker, Containers, and Access management. Publishing requires authorized deployment access and the Access audience/team configuration in the [beta guide](cloudflare-beta.md). |
| Hosted lifecycle | Verify the Cloudflare HTTPS intercept trusts its runtime CA, disallowed destination requests fail, and a cold container starts. Check iOS and Android playback, time to download, and bandwidth. Confirm the beta's cost under actual traffic before widening access. |

Keep sample URLs and credentials out of commits and logs. Downloads are staged temporarily inside the container and removed when the request ends. Notice that container restarts or Durable Object eviction can expire an inspection result early.
