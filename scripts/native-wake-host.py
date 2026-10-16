#!/usr/bin/python3
"""Minimal, Chrome-authorized native messaging launcher for Paseo.

Chrome's native-host manifest restricts callers to the paired extension ID.
This host accepts no URLs, shell commands, arguments or credentials.
"""
import json
import struct
import subprocess
import sys


def handle(request, launch=subprocess.run):
    if request != {"v": 1, "action": "wake"}:
        return {"ok": False, "error": "INVALID_REQUEST"}
    try:
        # -g starts/activates the installed app without taking keyboard focus.
        launch(["/usr/bin/open", "-g", "-a", "Paseo"],
               check=True, timeout=10, stdout=subprocess.DEVNULL,
               stderr=subprocess.DEVNULL)
        return {"ok": True, "launched": True}  # OS launch accepted, not online proof.
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {"ok": False, "error": "PASEO_START_FAILED"}


def main():
    prefix = sys.stdin.buffer.read(4)
    if len(prefix) != 4:
        return 1
    (size,) = struct.unpack("<I", prefix)
    if size < 1 or size > 512:
        return 1
    data = sys.stdin.buffer.read(size)
    if len(data) != size:
        return 1
    try:
        message = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        message = None
    reply = json.dumps(handle(message), separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(reply)) + reply)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
