"""Fake extractor used only in the offline HTTP smoke check."""

import json
import os
import shutil
import sys
from pathlib import Path


args = sys.argv[1:]
url = args[-1]
if "/reel/404" in url:
    print("ERROR: Facebook says login required", file=sys.stderr)
    raise SystemExit(1)

if "--dump-single-json" in args:
    formats = []
    for width, height in [(320, 180), (640, 360)]:
        formats.append({"format_id": str(height), "width": width, "height": height, "ext": "mp4",
                        "vcodec": "avc1.4d401e", "acodec": "mp4a.40.2"})
    print(json.dumps({"title": "Downloader test clip", "duration": 1, "formats": formats}))
else:
    selection = args[args.index("--format") + 1]
    template = args[args.index("--output") + 1].replace("%(ext)s", "mp4").replace("%%", "%")
    source = Path(os.environ["DOWNLOADER_FIXTURES"]) / f"{selection}.mp4"
    shutil.copyfile(source, template)
