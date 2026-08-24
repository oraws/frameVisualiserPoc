import json
import unittest
from pathlib import Path

from mainline_spec_parser import MainlineSpecParser


PROJECT = Path(__file__).resolve().parents[2]


class MainlineProfilePipelineTests(unittest.TestCase):
    def test_page_two_native_geometry_and_vector_calibration(self):
        metadata = MainlineSpecParser(PROJECT / "Verona_Spec_Sheet.pdf", 2).inspect()
        self.assertEqual(metadata["imageCount"], 5)
        selected = next(image for image in metadata["images"] if image["xref"] == metadata["selectedProfileImageXref"])
        self.assertEqual((selected["width"], selected["height"]), (275, 229))
        calibration = metadata["calibration"]
        self.assertAlmostEqual(calibration["widthMm"], 97)
        self.assertAlmostEqual(calibration["depthMm"], 49)
        self.assertAlmostEqual(calibration["rebateMm"], 16)
        self.assertAlmostEqual(calibration["depthPixelTop"], 85.978, places=2)
        self.assertAlmostEqual(calibration["backingBaselinePixel"], 229, places=2)
        self.assertAlmostEqual(calibration["rebatePixelTop"], 184.673, places=2)

    def test_auto_profile_is_review_only_and_sized_for_runtime(self):
        path = PROJECT / "source-material/mainline/POL-4875/profile-analysis/auto/profile-auto.json"
        profile = json.loads(path.read_text())
        self.assertEqual(profile["status"], "experimental-unapproved")
        self.assertFalse(profile["rendererIntegrated"])
        self.assertEqual((profile["widthMm"], profile["depthMm"], profile["rebateMm"]), (97, 49, 16))
        self.assertGreaterEqual(len(profile["points"]), 25)
        self.assertLessEqual(len(profile["points"]), 60)
        self.assertTrue(all(0 <= u <= 97 and 0 <= z <= 49 for u, z in profile["points"]))
        self.assertGreater(len(profile["uncertainRegions"]), 0)

    def test_simple_spin_profile_is_eligible_but_not_integrated(self):
        path = PROJECT / "source-material/mainline/POL-4100/profile-analysis/simple-auto/profile-candidate.json"
        profile = json.loads(path.read_text())
        self.assertEqual(profile["sourceFrame"], "img23")
        self.assertTrue(profile["autoRouteEligible"])
        self.assertFalse(profile["rendererIntegrated"])
        self.assertGreaterEqual(profile["confidence"], 0.72)
        self.assertEqual((profile["widthMm"], profile["depthMm"], profile["rebateMm"]), (41, 13, 9))
        self.assertEqual(profile["points"][0], [0.0, 4.0])
        self.assertEqual(profile["points"][-1], [41.0, 13.0])
        self.assertTrue(all(0 <= u <= 41 and 0 <= z <= 13 for u, z in profile["points"]))
        self.assertEqual((profile["calibration"]["widthPixelStart"], profile["calibration"]["widthPixelEnd"]), (29, 130))

    def test_gemma_candidate_preserves_provenance_and_requires_review(self):
        root = PROJECT / "source-material/mainline/POL-4875/profile-analysis/gemma"
        profile = json.loads((root / "gemma-profile-candidate.json").read_text())
        self.assertEqual(profile["model"], "gemma4:26b")
        self.assertEqual(profile["status"], "awaiting-human-review")
        self.assertFalse(profile["rendererIntegrated"])
        self.assertGreaterEqual(len(profile["points"]), 12)
        self.assertLessEqual(len(profile["points"]), 30)
        self.assertTrue((root / profile["provenance"]["rawResponseFilename"]).exists())
        inspect = (root / "profile-inspect.html").read_text()
        self.assertIn("accepted-gemma", inspect)
        self.assertIn("../manual/manual-trace.html", inspect)

    def test_manual_trace_editors_expose_magnetic_review_and_calibrated_export(self):
        for sku in ("POL-4875", "POL-4100"):
            path = PROJECT / f"source-material/mainline/{sku}/profile-analysis/manual/manual-trace.html"
            editor = path.read_text()
            self.assertIn('data-tool="brush"', editor)
            self.assertIn('data-tool="line"', editor)
            self.assertIn('data-tool="eraser"', editor)
            self.assertIn('data-tool="magnetic"', editor)
            self.assertIn("function shortestPath", editor)
            self.assertIn("accepted-visual-trace", editor)
            self.assertIn("rendererIntegrated:false", editor)
            self.assertIn("coverage<.8", editor)
            self.assertIn("outlineStrokesMm", editor)
            self.assertIn("function densifyStroke", editor)
            self.assertIn("function eraseAt", editor)


if __name__ == "__main__":
    unittest.main()
