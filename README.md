# Downloader

Downloader is a mobile-first web app for turning a pasted public Facebook video or Reel link into downloadable quality options. This folder contains the command-line prototype for the first milestone and the [MVP architecture](docs/architecture.md). The prototype is for trusted operators testing videos they have permission to download.

## Run the prototype on Windows

Open PowerShell in this folder with Docker Desktop running in Linux container mode.

```powershell
docker build -t downloader-prototype .
$link = Read-Host 'Paste a public Facebook video or Reel link'
docker run --rm downloader-prototype inspect "$link"

$outputDir = (New-Item -ItemType Directory -Force downloads).FullName
docker run --rm --mount "type=bind,source=$outputDir,target=/output" downloader-prototype download "$link"
```

`inspect` prints the formats the extractor finds. `download` saves an MP4 under `downloads` and prints its video dimensions, codecs, duration, and file size. The default selects a compatible MP4 with audio. If you want to test an exact quality, copy its MP4 format ID from `inspect` and pass `--format ID` after the pasted link. If the selected video row is video-only and the source has audio, pass the video and M4A audio IDs together as `--format VIDEO_ID+AUDIO_ID`.

## Repeat on the beta host

Build the same image in the same folder on the Linux host. Run `docker run --rm downloader-prototype inspect "$link"` with `link` set to your test URL. For downloads, run this as your regular host user so the container can write to the bind mount.

```bash
mkdir -p downloads
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD/downloads,target=/output" \
  downloader-prototype download "$link"
```

The Dockerfile pins `yt-dlp`. Change the version explicitly with `docker build --build-arg YT_DLP_VERSION=VERSION -t downloader-prototype .` when evaluating an extractor update.

## Acceptance checks

Use a public video and a **different** public Reel with recognizable content. Copy the share links in the Facebook mobile app and keep each full post URL as a comparison. Choose fixtures with sound so an accidentally silent download is easy to catch.

| Check | Pass condition |
| --- | --- |
| Public video and public Reel | The copied links and full URLs open the same intended clips, with the correct sound. |
| Multiple formats | Download two distinct, compatible source resolutions where available. The reported dimensions and playback match each selected format. |
| Single format | One compatible source resolution is enough to produce a playable file. |
| Missing or login-required clip | The command exits with an error and leaves no completed MP4 for that attempt. |
| Unsupported link | A URL outside the supported Facebook video shapes fails before it is passed to the extractor. |

Record the extractor version, link type, selected format, elapsed time, and success or failure reason on both hosts. Open the resulting MP4 on a phone to verify playback. Prototype success means the intended deployment host produces playable files from the links copied in the Facebook app. The web app can then reuse the proven download behaviors.
