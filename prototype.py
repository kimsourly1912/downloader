"""Inspect and download a single Facebook video from a trusted test fixture."""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4


FACEBOOK_HOSTS = {"facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"}
FACEBOOK_VIDEO_PATH = re.compile(
    r"/(?:reel/[0-9]+|(?:[^/]+/)?videos/[0-9]+|share/[rv]/[A-Za-z0-9_-]+)/?"
)
FORMAT_ID = r"[A-Za-z0-9_.-]+"
DEFAULT_FORMAT = (
    "bv*[ext=mp4][vcodec^=avc]+ba[ext=m4a][acodec^=mp4a]"
    "/b[ext=mp4][vcodec^=avc][acodec^=mp4a]"
)


def facebook_url(value: str) -> str:
    value = value.strip()
    error = argparse.ArgumentTypeError("Paste an HTTPS Facebook video, Reel, or video share link.")
    try:
        url = urlsplit(value)
        valid_origin = (
            url.scheme == "https"
            and url.username is None
            and url.port in (None, 443)
            and not any(character.isspace() or ord(character) < 32 for character in value)
            and "\\" not in value
        )
    except ValueError:
        raise error from None

    if valid_origin and url.hostname == "fb.watch" and re.fullmatch(r"/[A-Za-z0-9_-]+/?", url.path):
        return value
    if valid_origin and url.hostname in FACEBOOK_HOSTS:
        if FACEBOOK_VIDEO_PATH.fullmatch(url.path):
            return value
        if url.path.rstrip("/") in {"/watch", "/video.php"}:
            video_ids = parse_qs(url.query, keep_blank_values=True).get("v", [])
            if len(video_ids) == 1 and re.fullmatch(r"[0-9]+", video_ids[0]):
                return value
    raise error


def format_selection(value: str) -> str:
    if not re.fullmatch(rf"{FORMAT_ID}(?:\+{FORMAT_ID})?", value):
        raise argparse.ArgumentTypeError("Pass a format ID or video ID + audio ID from inspect, with no spaces.")
    return value


def run_extractor(url: str, *options: str, timeout: int) -> None:
    subprocess.run(
        [
            sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-cache-dir", "--no-playlist",
            "--socket-timeout", "15", "--retries", "1", "--fragment-retries", "1",
            *options, "--", url,
        ],
        check=True,
        timeout=timeout,
    )


def download(url: str, selection: str, output_dir: Path) -> None:
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="downloader-", dir=output_dir) as temp_dir:
        staging = Path(temp_dir)
        # yt-dlp treats percent signs in an output template as placeholders.
        template = str(staging).replace("%", "%%") + "/video.%(ext)s"
        run_extractor(url, "--format", selection, "--merge-output-format", "mp4",
                      "--output", template, timeout=300)
        media_path = staging / "video.mp4"
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-of", "json",
                "-show_entries", "stream=codec_type,codec_name,width,height:format=duration",
                str(media_path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        media = json.loads(result.stdout)
        if not any(stream.get("codec_type") == "video" for stream in media.get("streams", [])):
            raise ValueError("The downloaded file has no video stream.")
        destination = output_dir / f"facebook-{uuid4().hex}.mp4"
        media["file"] = str(destination)
        media["sizeBytes"] = media_path.stat().st_size
        media_path.replace(destination)
        print(json.dumps(media, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect", help="List source formats without downloading the video.")
    inspect.add_argument("url", type=facebook_url)
    save = commands.add_parser("download", help="Save one MP4 and report its actual streams.")
    save.add_argument("url", type=facebook_url)
    save.add_argument("--format", type=format_selection, help="Format ID or video+audio IDs from inspect.")
    save.add_argument("--output-dir", type=Path, default=os.getenv("DOWNLOADER_OUTPUT_DIR", "downloads"))
    args = parser.parse_args()

    try:
        if args.command == "inspect":
            run_extractor(args.url, "--list-formats", timeout=60)
        else:
            download(args.url, args.format or DEFAULT_FORMAT, args.output_dir)
    except subprocess.TimeoutExpired:
        print("The operation timed out. Try the same link again.", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        if error.stderr:
            print(error.stderr.rstrip(), file=sys.stderr)
        print(f"{args.command.capitalize()} failed. Check the tool output above.", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"{args.command.capitalize()} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
