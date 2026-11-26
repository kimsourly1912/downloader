"""Return only public metadata and verified MP4 output to the web server."""

import argparse
import json
import math
import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from prototype import FORMAT_ID, download, facebook_url, format_selection, run_extractor


MAX_BYTES = 64 * 1024 * 1024
MAX_DURATION = 300


class MediaError(Exception):
    pass


def positive_integer(value):
    return value if type(value) is int and value > 0 else None


def compatible_codec(value, prefixes):
    return isinstance(value, str) and value.startswith(prefixes)


def safe_thumbnail(value):
    if not isinstance(value, str):
        return None
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        if url.scheme == "https" and url.username is None and url.port in (None, 443):
            if host == "fbcdn.net" or host.endswith(".fbcdn.net"):
                return value
    except ValueError:
        pass
    return None


def inspect_metadata(info):
    duration = info.get("duration")
    if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
        duration = None
    if info.get("is_live") or info.get("live_status") == "is_upcoming":
        raise MediaError("UNAVAILABLE")
    if duration is not None and duration > MAX_DURATION:
        raise MediaError("TOO_LONG")

    formats = [item for item in info.get("formats", []) if isinstance(item, dict)
               and re.fullmatch(FORMAT_ID, str(item.get("format_id") or ""))]
    # yt-dlp sorts formats in increasing preference. Try its preferred AAC track first.
    audio = next((item for item in reversed(formats) if item.get("ext") == "m4a"
                  and item.get("vcodec") == "none"
                  and compatible_codec(item.get("acodec"), ("aac", "mp4a"))), None)
    known_audio = any(item.get("acodec") not in (None, "", "none", "unknown") for item in formats)
    choices = {}
    for item in reversed(formats):
        video_codec = item.get("vcodec")
        if item.get("ext") != "mp4" or (video_codec not in (None, "", "unknown")
                                         and not compatible_codec(video_codec, ("avc", "h264"))):
            continue
        selection = str(item["format_id"])
        size = positive_integer(item.get("filesize"))
        audio_codec = item.get("acodec")
        audio_required = compatible_codec(audio_codec, ("aac", "mp4a"))
        if audio_codec == "none" and audio is not None:
            selection = f"{selection}+{audio['format_id']}"
            audio_size = positive_integer(audio.get("filesize"))
            size = size + audio_size if size and audio_size else None
            audio_required = True
        elif audio_codec == "none" and known_audio:
            continue
        elif audio_codec not in (None, "", "none", "unknown") and not audio_required:
            continue
        if size and size > MAX_BYTES:
            continue
        width, height = positive_integer(item.get("width")), positive_integer(item.get("height"))
        dimensions = (width, height) if width and height else (0, 0)
        choice = {
            "selection": selection,
            "resolution": {"width": width, "height": height} if width and height else None,
            "sizeBytes": size,
            "audioRequired": audio_required,
        }
        previous = choices.get(dimensions)
        if previous is None or (audio_required and not previous["audioRequired"]):
            choices[dimensions] = choice

    sized = [choice for dimensions, choice in sorted(choices.items(), key=lambda entry: min(entry[0]), reverse=True)
             if dimensions != (0, 0)]
    if not sized and (0, 0) in choices:
        sized = [choices[(0, 0)]]
    if not sized:
        raise MediaError("NO_FORMAT")

    title = info.get("title")
    return {
        "title": (title[:180] if isinstance(title, str) and title.strip() else "Facebook video"),
        "durationSeconds": round(duration) if duration is not None else None,
        "thumbnail": safe_thumbnail(info.get("thumbnail")),
        "choices": sized[:8],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("inspect", "download"))
    parser.add_argument("url", type=facebook_url)
    parser.add_argument("--format", type=format_selection)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if args.operation == "download" and (args.format is None or args.output_dir is None):
        parser.error("download requires --format and --output-dir")
    try:
        if args.operation == "inspect":
            result = run_extractor(args.url, "--dump-single-json", "--skip-download", timeout=40, capture=True)
            media = inspect_metadata(json.loads(result.stdout))
        else:
            media = download(args.url, args.format, args.output_dir, max_bytes=MAX_BYTES)
        print(json.dumps(media, allow_nan=False))
        return 0
    except MediaError as error:
        code = str(error)
    except subprocess.TimeoutExpired:
        code = "UPSTREAM_TIMEOUT"
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").lower()
        if "requested format is not available" in detail:
            code = "NO_FORMAT"
        elif any(text in detail for text in ("login required", "log in", "logging in", "not available", "private video")):
            code = "UNAVAILABLE"
        elif "no module named yt_dlp" in detail:
            code = "TOOL_UNAVAILABLE"
        else:
            code = "UPSTREAM_ERROR"
    except ValueError:
        code = "NO_FORMAT" if args.operation == "download" else "UPSTREAM_ERROR"
    except OSError:
        code = "TOOL_UNAVAILABLE"
    print(json.dumps({"code": code}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
