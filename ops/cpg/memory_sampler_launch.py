"""Opt-in launcher setup; no shell, privilege changes or CLI patching."""
import os
from pathlib import Path
import socket
import stat

PRELOAD = Path("/usr/local/libexec/cli-memory-sampler/memory_sampler_preload.cjs")


def socket_path(uid):
    return Path("/run/cli-memory-sampler-{}/runtime.sock".format(uid))


def check_preload():
    for path in (PRELOAD, *PRELOAD.parents):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("Internal sampler requires root-owned, non-writable installation")
    if not PRELOAD.is_file():
        raise RuntimeError("Internal sampler preload is not installed")


def check_collector(path, uid):
    parent = path.parent.lstat()
    info = path.lstat()
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != uid
            or stat.S_IMODE(parent.st_mode) != 0o700
            or not stat.S_ISSOCK(info.st_mode) or info.st_uid != uid
            or stat.S_IMODE(info.st_mode) != 0o600):
        raise RuntimeError("Unsafe internal sampler socket")
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(2)
        connection.connect(str(path))
        greeting = b""
        while len(greeting) < 13:
            part = connection.recv(13 - len(greeting))
            if not part:
                break
            greeting += part
        if greeting != b"CPG_MEMORY/1\n":
            raise RuntimeError("External sampler handshake failed")


def environment(uid, pid, original=None):
    check_preload()
    path = socket_path(uid)
    check_collector(path, uid)
    env = dict(os.environ if original is None else original)
    if "CPG_MEMORY_PID" in env or "CPG_MEMORY_SOCKET" in env:
        raise RuntimeError("Nested internal sampler environment is not supported")
    env["CPG_MEMORY_PID"] = str(pid)
    env["CPG_MEMORY_SOCKET"] = str(path)
    return env


def node_option():
    return "--node-options=--require=" + str(PRELOAD)
