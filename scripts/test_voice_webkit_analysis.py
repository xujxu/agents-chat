import copy
import unittest

from test_voice_browser_report import fixture as browser_fixture
from voice_browser_cases import CASES
from voice_browser_report import browser_report
from voice_webkit_analysis import analyze

CASE = "linux-webkit-mobile"


def refresh(data):
    samples, attempts, originals, baseline, _ = data
    edge = copy.deepcopy(attempts)
    references = {(r["caseId"], r["id"]): r for r in baseline}
    for row in edge:
        row.update(caseId="win32-edge", platform="win32")
        if row["pipeline"] == "browser":
            row["uploadedAudioSha256"] = references["win32-edge", row["id"]]["uploadedAudioSha256"]
    data[4] = browser_report(samples, attempts + edge, originals, baseline, cases=CASES)
    return data


def fixture():
    samples, rows, original, baseline = browser_fixture()
    for sample in samples[50:60]:
        i = int(sample["id"][1:])
        sample["category"] = "mixed" if i < 58 else "zh" if i == 58 else "en"
    by_id = {s["id"]: s for s in samples}
    by_host = {case["platform"]: name for name, case in CASES.items()}
    for row in rows + original:
        row.update(by_id[row["id"]])
    for row in rows + baseline:
        row["caseId"] = by_host[row["platform"]]
    return refresh([samples, [r for r in rows if r["platform"] == "linux"], original, baseline, None])


class WebkitAnalysisTests(unittest.TestCase):
    def test_exact_eight_four_paths_and_saved_agreement(self):
        result = analyze(*fixture())
        self.assertEqual([s["id"] for s in result["samples"]], [f"s{i:03d}" for i in range(50, 58)])
        self.assertEqual(set(result["summary"]["totals"]), {
            "original_onnx", "original_native", "captured_onnx", "captured_native"})
        self.assertTrue(result["summary"]["matches_saved"])
        self.assertFalse(result["summary"]["release_approved"])
        self.assertEqual(result["summary"]["reference_units"], 24)

    def test_invalid_selection_paths_sources_case_hashes_and_saved_scores(self):
        for mutation in ("selection", "duplicate-source", "missing-attempt", "duplicate-attempt",
                         "missing-original", "duplicate-original", "source", "reference",
                         "baseline-missing", "baseline-case", "baseline-hash", "saved-score", "saved-rate"):
            data = fixture()
            samples, attempts, originals, baseline, saved = data
            if mutation == "selection":
                samples[50]["category"] = "en"
            elif mutation == "duplicate-source":
                samples[-1] = samples[0]
            elif mutation == "missing-attempt":
                attempts.pop()
            elif mutation == "duplicate-attempt":
                attempts[-1] = attempts[0]
            elif mutation == "missing-original":
                originals[:] = [r for r in originals if r["id"] != "s050"]
            elif mutation == "duplicate-original":
                originals.append(copy.deepcopy(originals[50]))
            elif mutation == "source":
                attempts[100]["audio_sha256"] = "f" * 64
            elif mutation == "reference":
                originals[50]["reference"] = "changed"
            elif mutation == "baseline-missing":
                baseline.pop()
            elif mutation == "baseline-case":
                baseline[50]["caseId"] = "win32-edge"
            elif mutation == "baseline-hash":
                baseline[50]["uploadedAudioSha256"] = "f" * 64
            elif mutation == "saved-score":
                item = next(r for r in saved["diagnostics"]["comparisons"] if r["caseId"] == CASE and r["id"] == "s050")
                item["api_score"]["errors"] += 1
            else:
                cell = next(c for c in saved["cells"] if c["caseId"] == CASE and c["pipeline"] == "browser")
                next(q for q in cell["quality"] if q["category"] == "mixed" and q["band"] == "medium")["error_rate"] = .9
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                analyze(*data)

    def test_micro_rates_signed_contributions_and_input_backend_contrasts(self):
        data = fixture()
        samples, attempts, originals, baseline, _ = data
        samples[50]["reference"] = "a b c d e f"
        for row in attempts + originals:
            if row["id"] == "s050":
                row.update(reference="a b c d e f", text="a b c d e f")
                if "apiText" in row:
                    row["apiText"] = row["text"]
        for row in baseline:
            if row["id"] == "s050":
                row["text"] = "a b c d e f"
        attempts[101].update(text="a b c d e", apiText="a b c d e")
        originals[51]["text"] = "wrong"
        result = analyze(*refresh(data))
        summary = result["summary"]
        self.assertEqual(summary["reference_units"], 27)
        self.assertAlmostEqual(summary["totals"]["captured_native"]["error_rate"], 1 / 27)
        by_id = {r["id"]: r for r in result["samples"]}
        self.assertEqual(by_id["s050"]["contrasts"]["primary"]["errors"], 1)
        self.assertEqual(by_id["s051"]["contrasts"]["primary"]["errors"], -3)
        self.assertAlmostEqual(summary["contrasts"]["primary"]["percentage_points"], -200 / 27)
        self.assertAlmostEqual(sum(s["contrasts"]["primary"]["percentage_points"] for s in result["samples"]),
                               summary["contrasts"]["primary"]["percentage_points"])

    def test_failed_delivery_is_reference_deletions_not_api_success(self):
        data = fixture()
        row = data[1][101]
        row.update(failure="ui_not_filled", text=None, seconds=130)
        row["timing"].update(composerAt=None, terminalAt=131000)
        result = analyze(*refresh(data))
        sample = result["samples"][0]
        self.assertEqual(sample["paths"]["captured_native"]["score"]["deletions"], 3)
        self.assertEqual(sample["paths"]["captured_native"]["delivered_tokens"], [])
        self.assertFalse(result["summary"]["primary_pass"])


if __name__ == "__main__":
    unittest.main()
