"""Fixed diagnostic cases; actual host identity is never a browser join key."""

import json
from pathlib import Path
import re

from voice_feature_data import read_bounded, sha

ROOT = Path(__file__).resolve().parent.parent
CASES = json.loads((ROOT / "scripts/voice/browser-cases.json").read_text(encoding="utf-8"))
IMPLEMENTATION_FILES = (
    "app/features/composer/voice/voiceRecorder.ts", "app/features/composer/voice/useVoiceInput.ts",
    "public/voice/recorder-worklet.js", "lib/voice/audio.ts", "lib/voice/process.ts",
    "tests/helpers/voiceBrowserCapture.ts", "tests/voice-installed-browser.spec.ts",
    "tests/playwright.config.ts", "tests/playwright.voice-matrix.config.ts",
    "scripts/voice/browser-cases.json", "scripts/voice/browser-cases.ts",
    "scripts/voice/installed-api-run.mjs",
)


def validate_browser(browser, case_id):
    if case_id not in CASES:
        raise ValueError("Unknown browser case")
    case = CASES[case_id]
    if (browser.get("caseId") != case_id or any(browser.get(k) != v for k, v in case.items())
            or not isinstance(browser.get("version"), str) or not browser["version"]
            or not isinstance(browser.get("playwrightVersion"), str) or not browser["playwrightVersion"]
            or browser.get("sourceRate") != 48000):
        raise ValueError("Browser case identity differs")
    settings = browser.get("deviceSettings")
    if (not isinstance(settings, dict) or set(settings) != {
            "viewport", "isMobile", "hasTouch", "deviceScaleFactor", "userAgent"}
            or settings != browser.get("requestedDeviceSettings")):
        raise ValueError("Browser device settings differ")
    if case["channel"] == "msedge":
        executable = browser.get("executable")
        if (not re.search(r"\bEdg/\d", browser.get("userAgent", ""))
                or not isinstance(executable, dict) or not executable.get("path") or not executable.get("version")
                or not re.fullmatch(r"[a-f0-9]{64}", executable.get("sha256", ""))):
            raise ValueError("Actual Edge identity missing")


def validate_implementation(root):
    actual = json.loads(read_bounded(Path(root) / "implementation.json", 65536))
    expected = {name: sha(read_bounded(ROOT / name, 1048576)) for name in IMPLEMENTATION_FILES}
    if actual != expected:
        raise ValueError("Collector implementation fingerprints differ")
