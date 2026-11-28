FROM node:24-bookworm-slim AS yt-dlp

# The unpacked yt-dlp release starts faster than the single-file build, which extracts about 95 MB to /tmp on every run.
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && case "$TARGETARCH" in \
      amd64) asset=yt-dlp_linux.zip; executable=yt-dlp_linux; checksum=cc4a3aa98fb438a1dac04a6fb006fe57acbeed00fc12db9ec84e3036dbbe6ccb ;; \
      arm64) asset=yt-dlp_linux_aarch64.zip; executable=yt-dlp_linux_aarch64; checksum=e80b05e7e7ae5e2b7ff480937b51699c733563bfa5c185a19dfceadc4e6191bf ;; \
      *) echo 'Unsupported yt-dlp architecture' >&2; exit 1 ;; \
    esac \
    && curl --fail --silent --show-error --location --retry 2 \
       "https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/$asset" --output /tmp/yt-dlp.zip \
    && echo "$checksum  /tmp/yt-dlp.zip" | sha256sum -c - \
    && unzip -q /tmp/yt-dlp.zip -d /opt/yt-dlp \
    && mv "/opt/yt-dlp/$executable" /opt/yt-dlp/yt-dlp \
    && chmod -R a+rX,go-w /opt/yt-dlp \
    && chmod 0755 /opt/yt-dlp/yt-dlp

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=yt-dlp /opt/yt-dlp /opt/yt-dlp
RUN ln -s /opt/yt-dlp/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app
COPY container ./container
COPY shared ./shared
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
USER node
EXPOSE 3000
CMD ["node", "container/main.ts"]
