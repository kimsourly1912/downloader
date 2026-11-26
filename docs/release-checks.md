# Live verification and deployment

The Nuxt MVP runs locally with offline fixtures and requires no GitHub or Facebook sign-in for its guest flow. The supplied `/share/v/` link resolved to a public Reel. The locally built production app inspected that exact link and downloaded a 720 × 1280 MP4 with H.264 video and AAC audio. FFmpeg decoded the entire 154-second file. The source advertised one compatible quality without dimensions, so the app offered it as **Source quality**.

| Deferred check | What is needed | How to verify |
| --- | --- | --- |
| Repeat the Reel download on a hosted runner | A repository maintainer can start the **Live Facebook check** GitHub Actions workflow. | Pass the original copied URL as the workflow input. Compare the result with the local run. Keep fixture URLs out of commits and avoid printing raw extractor output. |
| Live standard video download | A public Facebook video distinct from a Reel, with permission to use it as a fixture. | Repeat with the mobile share URL and compare the resulting file with the post. Verify one and multiple source qualities where available. |
| Private beta deployment | An identified Node/Docker host with access to deploy. Repository or host credentials stay with the operator or authorized deployment connection. | Build `Dockerfile.web`, deploy privately, and repeat both live checks from that host. Verify downloads on iOS and Android and measure transfer size and elapsed time. |
| Public beta infrastructure | Hosting network and proxy configuration. | Block worker connections to private, loopback, link-local, and metadata addresses across redirects. Set hard process and temporary disk limits, max HTTP request-body size, and only trust forwarded client IPs from the chosen proxy. Review bandwidth and concurrency on the target host before enabling public traffic. |

GitHub authorization is only for starting a maintainer-operated verification run. Visitors and the media subprocess use guest access to Facebook.
