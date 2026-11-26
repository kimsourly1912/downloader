"""Exercise the prototype and the installed media tools using local fixtures."""

import json
import subprocess
import sys
import tempfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from prototype import DEFAULT_FORMAT, download


def make_fixture(path: Path, *options: str) -> None:
    subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            *options, str(path),
        ],
        check=True,
    )


def check_download(url: str, output: Path) -> None:
    download(url, DEFAULT_FORMAT, output)
    [media] = output.iterdir()
    streams = subprocess.check_output(
        ["ffprobe", "-v", "error", "-of", "json", "-show_streams", str(media)],
        text=True,
    )
    tracks = {track["codec_type"]: track for track in json.loads(streams)["streams"]}
    assert tracks["video"]["codec_name"] == "h264"
    assert (tracks["video"]["width"], tracks["video"]["height"]) == (320, 180)
    assert tracks["audio"]["codec_name"] == "aac"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(media), "-f", "null", "-"],
        check=True,
    )


def main() -> None:
    rejected = subprocess.run(
        [sys.executable, "prototype.py", "inspect", "https://example.com/video"],
        capture_output=True,
        text=True,
    )
    assert rejected.returncode == 2 and "Paste an HTTPS Facebook" in rejected.stderr

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "source"
        source.mkdir()
        make_fixture(source / "combined.mp4")
        make_fixture(source / "split.mpd", "-f", "dash")
        handler = partial(SimpleHTTPRequestHandler, directory=source)
        with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                check_download(f"{base}/combined.mp4", root / "combined")
                check_download(f"{base}/split.mpd", root / "split")
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    main()
