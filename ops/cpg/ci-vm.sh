#!/bin/bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
work="$RUNNER_TEMP/cpg-vm"
mkdir -p "$work"
sudo apt-get update -qq
sudo apt-get install -y -qq qemu-system-x86 qemu-utils cloud-image-utils libguestfs-tools > "$work/install.log" 2>&1
curl --fail --silent --show-error --location \
  https://cloud-images.ubuntu.com/focal/current/focal-server-cloudimg-amd64.img \
  --output "$work/root.qcow2"
qemu-img resize "$work/root.qcow2" 5G
sudo env LIBGUESTFS_BACKEND=direct virt-edit -v -x -a "$work/root.qcow2" /boot/grub/grub.cfg \
  -e 's/^(\s*linux\s+.*)$/$1 systemd.unified_cgroup_hierarchy=0/' > "$work/guestfs.log" 2>&1
python3 - "$source_dir" "$work" "${1:-integration.py}" <<'PY'
import base64
import json
from pathlib import Path
import sys
source, work = map(Path, sys.argv[1:3])
integration = sys.argv[3]
assert integration in ("integration.py", "memory_sampler_integration.py")
files = [{
    "path": "/opt/cpg-test/" + path.name,
    "permissions": "0644",
    "encoding": "b64",
    "content": base64.b64encode(path.read_bytes()).decode(),
} for path in source.glob("*.py")]
config = {
    "write_files": files,
    "runcmd": [["bash", "-c", "python3 /opt/cpg-test/" + integration + " > /var/log/cpg-test.log 2>&1; result=$?; cat /var/log/cpg-test.log > /dev/ttyS0; echo CPG_RESULT=$result > /dev/ttyS0; poweroff"]],
}
(work / "user-data").write_text("#cloud-config\n" + json.dumps(config))
(work / "meta-data").write_text("instance-id: cpg-ci\nlocal-hostname: cpg-ci\n")
PY
cloud-localds "$work/seed.img" "$work/user-data" "$work/meta-data"
accelerator=tcg
if [ -e /dev/kvm ]; then
  sudo chmod a+rw /dev/kvm
  accelerator=kvm
fi
timeout 12m qemu-system-x86_64 -accel "$accelerator" -m 3072 -smp 2 \
  -drive "file=$work/root.qcow2,if=virtio" -drive "file=$work/seed.img,format=raw,if=virtio" \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -display none -serial "file:$work/serial.log" -no-reboot
grep -E 'PASS:|Traceback|Error|CPG_RESULT=' "$work/serial.log" || true
grep -q 'CPG_RESULT=0' "$work/serial.log"
