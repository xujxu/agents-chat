import { minimalViewportClient } from './client.ts';
import { createMinimalRecorder } from './recorder.ts';

export function renderMinimalViewportHtml(revision: string | null): string {
  if (revision !== null && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid diagnostic revision.');
  const script = `(${minimalViewportClient.toString()})(${createMinimalRecorder.toString()});`
    .replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title>Native viewport / minimal reproduction</title>
<style>
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 16px; color: #1b242b; background: #f7f5ee; font: 16px/1.4 Georgia, serif; }
h1, p { font-size: 16px; margin: 0 0 12px; }
h1 { border-bottom: 2px solid #1b242b; padding-bottom: 8px; letter-spacing: .02em; }
#reference { box-sizing: border-box; width: 100px; height: 24px; background: #1b242b; margin: 8px 0; }
button { font: 16px/1.3 Georgia, serif; padding: 10px; margin: 0 4px 8px 0; max-width: 100%; border: 1px solid #1b242b; background: #fff; color: #1b242b; }
button:disabled { opacity: .5; }
button:focus-visible { outline: 3px solid #b65024; outline-offset: 2px; }
#status { box-sizing: border-box; height: 110px; overflow: auto; border-top: 1px solid #1b242b; padding-top: 8px; overflow-wrap: anywhere; }
#status[data-error="true"] { color: #9b291e; }
</style>
</head>
<body data-revision="${revision ?? ''}">
<h1>Native viewport / minimal reproduction</h1>
<p id="specimen">Fixed 16px text. This page observes native pinch and rotation; it never restores scale.</p>
<div id="reference" aria-label="100 CSS pixel reference"></div>
<p>Reference: 100 CSS pixels. Start at 1x in landscape, pinch larger and back, release, rotate to portrait, wait 3 seconds, then Stop.</p>
<button id="start" type="button">Start recording</button>
<button id="stop" type="button" disabled>Stop recording</button>
<button id="upload" type="button" disabled>Upload diagnostic log</button>
<div id="status" role="status" aria-live="polite">Ready. Recording stops after 30 seconds. Upload requires administrator access.</div>
<script>${script}</script>
</body>
</html>`;
}
