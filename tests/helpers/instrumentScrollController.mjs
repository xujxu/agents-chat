import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const controllerSha = '3ebb63ffe07e976b9f0c3154206418a5691dd3c3a5f96f69d3af1d63eb69f94e';
const digest = source => createHash('sha256').update(source).digest('hex');
const patches = [];
const change = (before, after) => patches.push({ before, after });
const after = (before, addition) => change(before, before + addition);
const enter = (signature, kind, target = '') => after(signature, `\n    observe('${kind}'${target});`);

change("import { captureReadingAnchor,", "import type { ControllerDiagnosticChannel } from '../../../../tests/helpers/controllerStateRecorder';\nimport { captureReadingAnchor,");
after('  const notify = () => onBottomChange(jumping || atBottom());', `

  const diagnostic: ControllerDiagnosticChannel | undefined = window.__chatScrollDiagnostic;
  if (!diagnostic) throw new Error('Missing controller diagnostic initialization');
  const recorder: ControllerDiagnosticChannel = diagnostic;
  const controllerId = recorder.nextId++;
  function observe(kind: string, requestedTop?: number) {
    recorder.record(controllerId, kind, () => ({
      following, userIntent, jumping, suspended, disposed, multiTouch, scrollbarDrag,
      correctionPending: correctionFrame !== 0, anchorPresent: anchor !== null,
      expectedTop, lastTop, cached: { ...geometry }, current: measure(),
      scrollTop: container.scrollTop, ...(requestedTop === undefined ? {} : { requestedTop }),
    }));
  }
  observe('controller:created');`);

enter('  function writeTop(top: number) {', 'write:enter', ', top');
after('    geometry = measure();\n    notify();', "\n    observe('write:complete', top);");
enter('  function captureUserPosition() {', 'capture:enter');
after('    expectedTop = null;\n    userIntent = false;\n    notify();', "\n    observe('capture:complete');");
enter('  function correctLayout() {', 'correct:enter');
change('    if (disposed || suspended || multiTouch || userIntent || container.clientHeight === 0) return;',
  "    if (disposed || suspended || multiTouch || userIntent || container.clientHeight === 0) { observe('correct:blocked'); return; }");
after('    if (!jumping && isIndependentScroll(geometry, measure(), lastTop, container.scrollTop)) {',
  "\n      observe('correct:independent');");
change('    if (following) writeTop(maximum);',
  "    if (following) { observe('correct:following'); writeTop(maximum); }");
after('    else if (anchor) {', "\n      observe('correct:anchor');");
after('    } else {\n      writeTop(clampScrollTop(container.scrollTop, maximum));',
  "\n      observe('correct:no-anchor');");
enter('  function scheduleCorrection() {', 'schedule:enter');
after('      correctionFrame = requestAnimationFrame(correctLayout);',
  "\n      observe('schedule:queued');");
enter('  function markUserIntent() {', 'intent:enter');
change('    deferIntentEnd();\n  }\n\n  function endUserIntent()',
  "    deferIntentEnd();\n    observe('intent:marked');\n  }\n\n  function endUserIntent()");
enter('  function endUserIntent() {', 'intent-end:enter');
after('    if (geometryChanged(geometry, measure())) scheduleCorrection();',
  "\n    observe('intent-end:complete');");
enter('  function onScroll() {', 'scroll:enter');
after('    if (userIntent || scrollbarDrag) {', "\n      observe('scroll:user-intent');");
after('    if (geometryChanged(geometry, current)) {', "\n      observe('scroll:geometry');");
change('      if (isIndependentScroll(geometry, current, lastTop, container.scrollTop)) captureUserPosition();\n      else scheduleCorrection();',
  "      if (isIndependentScroll(geometry, current, lastTop, container.scrollTop)) { observe('scroll:independent'); captureUserPosition(); }\n      else { observe('scroll:layout'); scheduleCorrection(); }");
after('    if (jumping) {\n      lastTop = container.scrollTop;', "\n      observe('scroll:jumping');");
after('    if (expectedTop !== null && Math.abs(container.scrollTop - expectedTop) <= 1) {',
  "\n      observe('scroll:expected');");
change('    if (Math.abs(container.scrollTop - lastTop) <= 0.25) return;\n    captureUserPosition();',
  "    if (Math.abs(container.scrollTop - lastTop) <= 0.25) { observe('scroll:unchanged'); return; }\n    observe('scroll:capture');\n    captureUserPosition();");
enter('  function onTouchStart(event: TouchEvent) {', 'touch-start:enter');
enter('  function onTouchEnd(event: TouchEvent) {', 'touch-end:enter');
change('  const resizeObserver = new ResizeObserver(scheduleCorrection);',
  "  const resizeObserver = new ResizeObserver(() => { observe('resize:callback'); scheduleCorrection(); });");
change('  const mutationObserver = new MutationObserver(scheduleCorrection);',
  "  const mutationObserver = new MutationObserver(() => { observe('mutation:callback'); scheduleCorrection(); });");
enter('    jumpToLatest() {', 'jump:enter');
after("      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });\n      notify();",
  "\n      observe('jump:complete');");
enter('    suspend() {', 'suspend:enter');
after('      suspended = true;', "\n      observe('suspend:marked');");
enter('    dispose() {', 'dispose:enter');
after('      disposed = true;', "\n      observe('dispose:marked');");

function replaceOnce(source, before, replacement) {
  if (source.split(before).length !== 2) throw new Error('Non-unique diagnostic insertion');
  return source.replace(before, () => replacement);
}

export function instrumentController(source) {
  if (digest(source) !== controllerSha) throw new Error('Unexpected controller revision');
  for (const { before } of patches) replaceOnce(source, before, before);
  return patches.reduce((text, { before, after }) => replaceOnce(text, before, after), source);
}

export function restoreController(source) {
  return [...patches].reverse().reduce((text, { before, after }) => replaceOnce(text, after, before), source);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Instrumentation is Actions-only');
  if (process.argv.length !== 3) throw new Error('Expected pinned product root');
  const root = path.resolve(process.argv[2]);
  const file = path.join(root, 'app/features/chat/runtime/chatScrollController.ts');
  const original = await readFile(file, 'utf8');
  const instrumented = instrumentController(original);
  if (restoreController(instrumented) !== original) throw new Error('Instrumentation is not reversible');
  const provenanceFile = path.join(root, 'artifacts/provenance.json');
  const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
  provenance.controller = { originalSha256: digest(original), instrumentedSha256: digest(instrumented) };
  await writeFile(file, instrumented);
  await writeFile(provenanceFile, JSON.stringify(provenance, null, 2));
}
