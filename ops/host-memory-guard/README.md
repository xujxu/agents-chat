# Host memory guard

Administrative containment for a roughly 4 GiB, single-user Linux host running
systemd with a **cgroup-v1 memory controller**. This is independent of application
features. It does not install swap, reboot, restart PROD, or grant sudo privileges.

The system manager applies persistent 1536 MiB hard limits to both
`user-<uid>.slice` (all that user's login/CLI sessions combined) and
`agents-chat.service` (the application and every descendant agent/transcriber
combined). Group-local OOM remains enabled. Exceeding a ceiling can terminate
CLI tasks, SSH sessions, or PROD agent work. Other system services remain outside
these two budgets; this is containment, not an absolute guarantee against host OOM.
PROD restart attempts are restricted to three starts per five minutes.

## Installation

Review the installer and use the artifact from the exact green **Host memory
guard** Actions revision. Run `sha256sum -c SHA256SUMS` in the artifact directory.
Then run `sudo python3 ./host_memory_guard.py install --uid <numeric-user-id>`.
The script refuses an inactive target, conflicting files, an existing lower
memory ceiling, insufficient host RAM/headroom, or group charge within 128 MiB
of the new ceiling. Close unnecessary tasks before retrying a headroom refusal;
do not bypass it or raise the approved limit.

Installation adds only its own `70-host-memory-guard.conf` drop-ins, timer,
monitor service, and `/usr/local/libexec/host-memory-guard.py`. Existing runtime,
authentication, and application settings are not rewritten. It records original
limits and owned file hashes in root-only
`/var/lib/host-memory-guard/installation.json`.

Persistent drop-ins and system-manager runtime properties apply the memory
limits immediately. The installer reads the actual cgroup-v1
`memory.limit_in_bytes` values (1610612736), hierarchical accounting and OOM
settings, checks that PROD's main PID did not change, and attempts scoped rollback
on failure. Runtime properties survive service restarts; the persistent drop-ins
reapply limits after reboot. No cgroup hierarchy migration is attempted.

## Monitoring and verification

`sudo python3 /usr/local/libexec/host-memory-guard.py status` verifies installed
file hashes, kernel limits and loaded restart policy. Also check:

- `systemctl status host-memory-guard.timer host-memory-guard.service --no-pager`
- `sudo journalctl -u host-memory-guard.service --since '-10 minutes' --no-pager`
- The current CLI's `/proc/<pid>/cgroup` belongs below the limited user slice.
- PROD is healthy and its main PID did not change.

The timer checks every 30 seconds (two-second scheduling tolerance). Journal
records contain only group names, cgroup paths and numeric metrics, never
conversation text, process command lines, environments or credentials. `wall`
notifies logged-in terminals of changed pressure conditions and repeats ongoing
alerts at most once per five minutes; terminal settings may suppress delivery.
Recovery is reported to the journal.

Host available-memory thresholds are 512 MiB (warning) and 256 MiB (critical).
Group warning/critical thresholds are 80%/95% of the ceiling, using charge minus
inactive file cache as a working-set estimate. **This is not process RSS**; the
actual hard ceiling includes all charged cache. Containment drift, group-local
OOM and inactive PROD also generate alerts. A 30-second monitor may miss brief
spikes; the kernel hard limit does not depend on the monitor. The existing
flight recorder remains useful for forensic evidence.

The monitor itself is bounded to 32 MiB, 5% CPU, eight tasks and a ten-second
deadline. Check failed monitor runs rather than assuming timer activity alone
proves successful monitoring.

## Rollback

Run `sudo python3 /usr/local/libexec/host-memory-guard.py rollback`.
It verifies ownership hashes and current limits, stops/disables its own timer,
restores previous live limits, removes only owned files, reloads systemd, and
checks kernel values. It does not restart PROD. Original effective limits are
restored with runtime properties; original persistent configuration takes over
on reboot. The root-only installation record and alert history are retained.

If a partial installation fails, use the original reviewed installer with the
`rollback` action. Drift is a deliberate hard failure: inspect changed files or
live limits before doing any manual recovery. An existing installation record
prevents a new installation from silently replacing the rollback baseline.

## Validation

All automated validation runs in GitHub Actions, including Python tests and unit
syntax verification under Ubuntu 20.04/systemd 245. It does not simulate a real
cgroup-v1 OOM. Installation must still verify the host's actual kernel values;
there is no intentional host OOM test or local validation workload.
