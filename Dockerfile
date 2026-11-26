FROM python:3.12-slim-bookworm

ARG YT_DLP_VERSION=2026.11.23
ENV DOWNLOADER_OUTPUT_DIR=/output \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --no-cache-dir "yt-dlp==${YT_DLP_VERSION}" \
    && install -d -m 0755 -o 65532 -g 65532 /output

WORKDIR /app
COPY prototype.py /app/prototype.py
USER 65532:65532
ENTRYPOINT ["python", "/app/prototype.py"]
