# cpg: terminal-only Copilot memory guard

An independent Linux administration tool, not an agents-chat feature. It protects
only Copilot processes explicitly started with `cpg` and their descendants.
It never changes agents-chat, its agents, SSH configuration, a user slice,
application units, or the original Copilot executable.

## Launch

Use `cpg`, or `cpg --yolo`, from your normal project directory as the configured
ordinary user. Arguments are forwarded literally, without a shell or argument
parser. Working directory, environment, terminal descriptors and the original
user identity are preserved. Authentication/session storage remains the original
Copilot's responsibility. `--yolo` does not disable the kernel memory ceiling.

Calling the original `copilot` still bypasses protection. An already-running CLI
is not retroactively moved: after installation, exit it normally and restart
through `cpg`. Do not run `sudo cpg`.

All protected CLIs and descendants share a **1536 MiB** hard memory ceiling.
This is charged memory, including charged file cache, not the sum of process RSS.
The launcher joins only its forked child to a dedicated cgroup-v1 memory group,
then executes the original Copilot. Its small supervisor and the parent SSH shell
remain outside that group. The kernel can select only in-group tasks for an OOM
caused by this group's ceiling. The supervisor reports a corresponding SIGKILL
and OOM counter increase instead of hiding the failure.

Group-local OOM does not guarantee termination of every descendant; a surviving
tool may remain charged to the group. `cpgctl status` lists remaining group PIDs.
Uninstall never kills them for you. Multiple protected CLI sessions share the
budget and may affect one another. Tools deliberately started through an external
service manager are not automatically descendants in the memory hierarchy.

This is not a security sandbox or a guarantee against global OOM from unrelated
programs. The same user can already signal its own processes; the delegated join
file is not an isolation boundary against malicious code running as that user.
No arbitrary processes are searched for or killed by name. No CPU/disk limits
are imposed on Copilot, and swap configuration is unchanged.

## Installation

Supported target: Linux with a **cgroup-v1 memory controller**, Python 3.8+ and
systemd. Unified cgroup-v2 hosts are deliberately rejected. Use the standalone
artifact from an exact green **CPG terminal guard** Actions revision.

Verify its checksum manifest, then run:

    sudo python3 ./cpg_admin.py install --uid <uid> --copilot /absolute/path/to/original/copilot

Keep all three Python files together for installation. The original binary must
already exist and be executable. Installation checks memory headroom, refuses
conflicting target files/groups, records its own installed file hashes, and
attempts scoped removal on partial failure. It does not restart existing apps.
After a failed partial installation, the staged `cpg_admin.py uninstall` can
retry removal using the installation record; inspect any drift refusal first.

Root creates `/sys/fs/cgroup/memory/cpg-cli` with its limit files root-owned.
Only its `cgroup.procs` join file is writable by the configured user. The launcher
writes only its own forked child's PID; it never moves its caller or SSH shell.
No sudoers rule, polkit rule, setuid binary or runtime privileged broker is needed.
A systemd boot unit recreates this memory-controller-specific group after reboot.
Other controller memberships are unchanged.

Owned files:

- `/usr/local/bin/cpg`: ordinary-user launcher.
- `/usr/local/sbin/cpgctl` and `/usr/local/libexec/cpg/cpg_common.py`: administration and shared policy.
- `/etc/cpg/config.json`: root-owned public configuration; no credentials.
- `/var/lib/cpg/`: root-only installation and alert state.
- `/run/lock/cpg.lock`: lifecycle/startup coordination.
- `cpg-setup.service`, `cpg-monitor.service`, `cpg-monitor.timer`: boot initialization and monitoring.

## Status, disable, enable, uninstall

    sudo cpgctl status
    sudo cpgctl disable
    sudo cpgctl enable
    sudo cpgctl uninstall

**Disable** actually removes the live kernel ceiling and disables boot setup and
monitoring. Existing tasks are not killed. A subsequent `cpg` explicitly warns
that protection is disabled, then launches the original binary without isolation.
**Enable** checks headroom and existing group usage before restoring the ceiling;
CLIs started outside the group while disabled are not moved into it afterward.
**Uninstall** refuses while any group tasks are running. Once they have exited,
it removes only owned files, group, timer and state. Shared journal records remain.
Stop the monitor alone only if you want to stop alerts: it does not remove limits.

If owned files/config have been manually changed, administration refuses destructive
operations rather than overwriting those changes. Failures are explicit; an enabled
launcher never silently falls back to an unprotected process. Do not interpret an
enabled timer alone as proof that the last monitor execution succeeded.

## Monitoring

The timer runs every 30 seconds with two-second scheduling tolerance. The monitor
is bounded to 32 MiB, 5% CPU, eight tasks and ten seconds. Numeric metrics go to
the journal, pressure alerts to `wall`; no prompts, process command lines,
environment values or credentials are logged or uploaded.

Host available-memory thresholds: warning below 512 MiB, critical below 256 MiB.
Group thresholds: 80%/95% of the ceiling, using charge minus inactive file cache as
a working-set estimate, **not RSS**. Unchanged alerts repeat every five minutes;
changed conditions may notify immediately. Recovery is logged. `wall` delivery
depends on terminal settings; the kernel ceiling does not depend on notifications.

    systemctl status cpg-monitor.timer cpg-monitor.service --no-pager
    sudo journalctl -u cpg-monitor.service --since '-10 minutes' --no-pager

The boot setup service can be inactive immediately after installation: the
installer has already initialized the group, and the enabled unit is for reboot.

## Validation

All automated validation is in GitHub Actions. Unit tests run on Ubuntu 20.04.
A disposable Ubuntu 20.04 VM boots a real cgroup-v1 memory controller and verifies
literal `--yolo`/other argument forwarding, identity/cwd/environment, descendant
membership, inability to raise the limit, live enable/disable, active-task uninstall
refusal, actual **1536 MiB** kernel OOM, survival of the outer supervisor and an
unrelated same-user process, group recreation and cleanup. The fixture is not
Copilot and does not use any credentials. Never run the VM fixture or deliberate
OOM test on the production machine.
