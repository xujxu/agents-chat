# Source deployment and physical upgrade handoff

## Approved scope

Keep the existing Git checkout and `scripts/deploy.sh` deployment method.
The operator executes dependency installation, builds, and service operations
manually. Assistant-run validation remains in GitHub Actions.

First deploy the pinned nonvoice main revision, confirm it is actually serving
the existing site, and only then upgrade to the pinned voice revision.
Do not merge or publish the draft PR, change installers, replace source
deployment with artifacts, or reopen native-engine/licensing investigations.
Fresh installation is a separate, deferred physical acceptance task.

## Revision boundaries

| Role | Revision |
| --- | --- |
| Existing PoC rollback source | `c6319933c870e9a2d5364f27d8df6bb54ef1b7d7` |
| Nonvoice main baseline | `638c553c62406dbb7e6b5aeb41cdddf4cd6de179` |
| Voice upgrade candidate | `95594894566b3f99b0ac43267110b8db70d8faf9` |

These are fixed revisions, not promises about future branch tips. Use dedicated
deployment branches without resetting or deleting the existing PoC branch.
The voice revision remains a candidate: its voice workflow passed, but E2E
run `36290112623` failed in the iPhone WebKit job. Classify that failure before
authorizing the voice upgrade; do not treat it as fully accepted or assume it
has the same cause as earlier repaired tests. This does not block main setup.
Fetch and confirm the target objects before downtime. Use `--no-pull` during
deployment so the installer cannot silently change the selected revision.
Main predates `scripts/upgrade.sh`; its first upgrade requires fetching and
switching to the candidate before invoking the candidate's deploy script.

## Backup and main baseline

1. Check that tracked and ordinary untracked files are clean, the running service
   uses the expected checkout, and sufficient backup space exists.
2. Record the source revision, branch, service state, effective runtime identity
   and Node executable. Do not expose environment contents in logs.
3. Create a new private backup directory outside the checkout. Stop the service
   and confirm it is stopped before copying SQLite files.
4. Preserve `.data`, `.env.local`, any other runtime environment files,
   `agents.json`, `.next`, and `node_modules`. Preserve the systemd unit,
   all its drop-ins, and the optional machine environment file, including
   whether that optional file originally existed.
5. Complete and inspect the backup before switching source. If backup fails
   before source changes, restart the unchanged PoC and stop the procedure.
6. After backup, remove only `VOICE_*` assignments from the project's runtime
   environment file to represent an ordinary installation without previous voice
   configuration. Inspect other environment sources first and stop on
   conflicting overrides. Preserve all unrelated settings and model files.
   Switch to a new branch at the pinned main revision. Run the existing main
   deploy script with `--no-pull`, using the same Node installation as the
   running service. Do not replace or remove the existing runtime drop-in.
7. Confirm the effective service identity and command, service health, and
   browser behavior through the existing trusted HTTPS endpoint.

Baseline acceptance requires login, existing chat history, a working ordinary
chat exchange, and no voice control after a fresh page load. A changed Git HEAD
or a successful build alone does not establish a running nonvoice baseline.
Retain old voice settings in the private backup, not the active baseline
configuration. Existing model files may remain on disk but do not substitute
for a verified installer package.

## Upgrade from the accepted baseline

Take a second stopped-service backup after main acceptance. This is the
immediate rollback point for the voice upgrade; the original PoC backup remains
separate. Preserve any chat changes made while accepting main.

Switch to the pinned voice candidate and invoke its existing deploy script with
`--no-pull` in an interactive terminal, without `--voice keep` or
`--non-interactive`. Use the existing combined menu: keep, enable SenseVoice,
enable Whisper, or disable. The operator approved using this menu rather than
implementing a two-stage enable/model prompt. Selecting a model means enabling
voice; the default keep choice leaves this clean baseline disabled.

Before activation, inspect only allowlisted voice configuration keys and account
for the optional machine-level environment override. The intended model is
Whisper `base-q5_1`, one thread. Explicit model selection currently writes
`standard`, not the old PoC's `legacy-low-memory`. Disclose this before the
operator proceeds; do not claim identical safeguards or silently alter the
installer result.

Whisper selection requires a verified local package and a trusted manifest
checksum, passed as package arguments without preselecting the model. Its
automatic experimental download is not available. Confirm that package source
before scheduling the voice upgrade. Do not bypass package verification or
reuse raw PoC files as though they were an accepted package. This prerequisite
does not prevent preparing and accepting the nonvoice main baseline.

## Recovery

On a deployment or health failure, stop the service before recovery. Switch
back to the recorded source revision without discarding unrelated changes.
Move failed `.next`, `node_modules`, and `.data` directories aside to unique
paths rather than overlaying or recursively deleting them. Restore their saved
copies and runtime configuration with ownership and permissions preserved.
Restore the saved unit, drop-ins and optional machine environment state, reload
systemd, and start the service. Check health and browser behavior.

Do not rerun a build as the primary rollback mechanism. Do not automatically
restore an old database over accepted new user activity: stop and decide how to
preserve that activity before restoring a snapshot.

## Physical acceptance and limits

Use desktop Chrome, iPhone Safari, and iPhone Chrome through trusted HTTPS.
For each client check microphone permission, recording feedback, stop and
transcription, cancellation, transcript insertion/editing, and sending a normal
message. Check permission denial and one retry after cancellation. Voice
inference runs on the server, not on the phone.

Keep recordings sequential and use the selected small model. Record the
effective resource policy rather than assuming it matches the old PoC.
Observe failures explicitly; successful occasional PoC usage is not a memory,
latency, accuracy, or device-compatibility guarantee. Do not overlap deliberate
voice inference with the source build.

This exercise establishes one real source-upgrade path and device observations.
It does not establish fresh-install acceptance, Windows physical acceptance,
all historical-version migrations, or public-release readiness.
