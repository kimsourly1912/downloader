FROM node:24-bookworm-slim

ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
      amd64) asset=yt-dlp_linux; checksum=249ddb058234276bc449b9cd9492aad9f133bda5923c61a9e39983ae114ef17d ;; \
      arm64) asset=yt-dlp_linux_aarch64; checksum=fb847a2e4a9ddc8cf5fcfb4bb7f42ba8969ecf72068def0278074f9d300bd13c ;; \
      *) echo 'Unsupported yt-dlp architecture' >&2; exit 1 ;; \
    esac \
    && curl --fail --silent --show-error --location --retry 2 \
       "https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/$asset" --output /usr/local/bin/yt-dlp \
    && echo "$checksum  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/yt-dlp

WORKDIR /app
COPY container ./container
COPY shared ./shared
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["node", "container/main.ts"]
