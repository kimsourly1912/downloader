"""Verify the built production app and both endpoints without contacting Facebook."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def make_fixtures(directory):
    for width, height in [(320, 180), (640, 360)]:
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate=15",
            "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264",
            "-c:a", "aac", str(directory / f"{height}.mp4"),
        ], check=True)


def check(base, directory):
    def request(path, data=None):
        req = Request(base + path, data=json.dumps(data).encode() if data is not None else None,
                      headers={"Content-Type": "application/json"} if data is not None else {})
        try:
            response = urlopen(req, timeout=8)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    for _ in range(60):
        try:
            status, _, page = request("/")
            break
        except URLError:
            time.sleep(0.1)
    else:
        raise RuntimeError("Production server did not start")
    assert status == 200 and b"Save a Facebook video" in page

    inspect = "/api/videos/inspect"
    for data, expected_status, expected_code in [
        ({"url": "https://example.test/video"}, 400, "INVALID_LINK"),
        ({"url": "https://www.facebook.com/reel/404/"}, 422, "UNAVAILABLE"),
        ({"url": "x" * 4100}, 400, "INVALID_LINK"),
    ]:
        status, _, response = request(inspect, data)
        assert status == expected_status and json.loads(response)["data"]["code"] == expected_code

    status, _, response = request(inspect, {"url": "https://www.facebook.com/share/v/SyntheticFixture/"})
    assert status == 200, response
    payload = json.loads(response)
    qualities = payload["qualities"]
    assert payload["title"] == "Downloader test clip" and len(qualities) == 2
    assert [(q["resolution"]["width"], q["resolution"]["height"]) for q in qualities] == [(640, 360), (320, 180)]
    assert all(set(q) == {"id", "resolution", "sizeBytes"} for q in qualities)

    for quality in qualities:
        status, headers, body = request(f"/api/downloads/{quality['id']}")
        width, height = quality["resolution"]["width"], quality["resolution"]["height"]
        assert status == 200, body
        assert headers["Content-Type"] == "video/mp4" and headers["Cache-Control"] == "no-store"
        assert f"facebook-video-{width}x{height}.mp4" in headers["Content-Disposition"]
        assert body == (directory / f"{height}.mp4").read_bytes()
    status, _, response = request("/api/downloads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    assert status == 410 and json.loads(response)["data"]["code"] == "EXPIRED"
    print("Production page, link validation, unavailable videos, both MP4 qualities, and expired choices passed.")


def main():
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        make_fixtures(directory)
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        server = subprocess.Popen(["node", ".output/server/index.mjs"], env={
            **os.environ, "NITRO_HOST": "127.0.0.1", "NITRO_PORT": str(port),
            "DOWNLOADER_PYTHON": sys.executable, "DOWNLOADER_FIXTURES": temp,
            "PYTHONPATH": str(Path(__file__).resolve().parent / "fixtures"), "TMPDIR": temp,
        })
        try:
            check(f"http://127.0.0.1:{port}", directory)
        finally:
            server.terminate()
            server.wait(timeout=5)


if __name__ == "__main__":
    main()
