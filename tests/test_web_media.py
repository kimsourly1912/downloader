import unittest

from web_media import MAX_BYTES, MediaError, inspect_metadata


class InspectMetadataTests(unittest.TestCase):
    def test_filters_deduplicates_and_pairs_compatible_formats(self):
        common = {"ext": "mp4", "vcodec": "avc1.123", "width": 1080, "height": 1920}
        result = inspect_metadata({
            "title": "Fixture", "duration": 12.1, "thumbnail": "https://example.test/cover.jpg",
            "formats": [
                {**common, "format_id": "combined", "acodec": "mp4a.40.2"},
                {**common, "format_id": "large", "acodec": "mp4a.40.2", "filesize": MAX_BYTES + 1},
                {**common, "format_id": "portrait", "acodec": "none", "filesize": 1000},
                {"format_id": "sound", "ext": "m4a", "vcodec": "none", "acodec": "aac", "filesize": 150},
                {**common, "format_id": "hevc", "vcodec": "hevc", "acodec": "mp4a.40.2"},
            ],
        })
        self.assertEqual(result, {
            "title": "Fixture", "durationSeconds": 12, "thumbnail": None,
            "choices": [{"selection": "portrait+sound", "resolution": {"width": 1080, "height": 1920},
                         "sizeBytes": 1150, "audioRequired": True}],
        })

    def test_unknown_dimensions_remain_unlabelled(self):
        result = inspect_metadata({"formats": [{"format_id": "sd", "ext": "mp4"}]})
        self.assertEqual(len(result["choices"]), 1)
        self.assertIsNone(result["choices"][0]["resolution"])

    def test_live_long_and_unsupported_formats_have_distinct_failures(self):
        for info, code in [({"is_live": True}, "UNAVAILABLE"), ({"duration": 301}, "TOO_LONG"),
                           ({"formats": [{"format_id": "av1", "ext": "webm"}]}, "NO_FORMAT")]:
            with self.subTest(code=code), self.assertRaisesRegex(MediaError, code):
                inspect_metadata(info)
