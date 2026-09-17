"""Take the research run lock, published atomically, from a directory descriptor.

Run as a subprocess so the caller can stop it. The record is written to a temporary file named by a
nonce, then published with link(), which is atomic: run.lock either does not exist or holds a whole
record. The token that proves ownership arrives on stdin and is written only into the file; nothing
token-bearing is ever printed.

TRUSTED ANCESTRY: protection starts at the opened control directory; the path above it is trusted.
STABLE DIRECTORY: cooperating actors do not replace or rename the control directory while this runs.
  Anchoring holds within one helper; separate helpers do not establish they opened the same one.
COOPERATIVE LOCK: run.lock is created only by this harness and removed only by the run whose token it
  holds, or by the operator. Nothing here defends against a hostile process of the same user.
LOCAL FILESYSTEM: link() is assumed atomic and O_EXCL honoured. NFS semantics are not assumed.
NOT CRASH DURABILITY: the record is whole before it is published, but the directory is not fsync'd,
  so after a power loss either state may be found.

INPUT: one JSON object on stdin, at most 4096 bytes, UTF-8, with exactly runId, pid, startedAt,
  token and nonce. The record written is {version, runId, pid, startedAt, token}; the nonce only
  names the temporary file.

OUTPUT: exactly one JSON line on stdout, exit status 0, after every descriptor is closed.
  {"kind": "acquired", "diagnostics": [DIAGNOSTIC, ...]}   run.lock was published by this run
  {"kind": "held", "diagnostics": [...]}                   something already held run.lock
  {"kind": "refused", "reason": REASON, "errno": str|null, "diagnostics": [...]}
REASON: arguments, capability, directory_missing, directory_unusable, temp_exists, temp_create_failed,
  ownership_unknown, write_failed, fsync_failed, close_failed, link_failed.
DIAGNOSTIC: {"step": str, "errno": str|null}, step one of close_temp, unlink_temp, temp_replaced,
  temp_may_remain, close_directory. `acquired` with diagnostics still means the lock is held: the
  caller must release it, and must keep the diagnostics.
"""

import errno as errnos
import json
import os
import re
import sys
from datetime import datetime

MAX_INPUT = 4096
HEX32 = re.compile(r"[0-9a-f]{32}")
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z")
FIELDS = ("runId", "pid", "startedAt", "token", "nonce")
FLAGS = ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK", "O_CLOEXEC")


def name_of(error):
    return errnos.errorcode.get(error.errno) if error.errno else None


def refused(reason, error=None):
    return {"kind": "refused", "reason": reason, "errno": None if error is None else name_of(error)}


def capable():
    """Checked before any flag is read, so a missing one refuses here instead of raising at import."""
    return (
        all(hasattr(os, name) for name in FLAGS + ("fstat", "fsync"))
        and all(f in os.supports_dir_fd for f in (os.open, os.link, os.unlink, os.stat))
        and all(f in os.supports_follow_symlinks for f in (os.stat, os.link))
    )


def no_duplicates(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError("duplicate key")
        seen[key] = value
    return seen


def real_stamp(value):
    if not isinstance(value, str) or not STAMP.fullmatch(value):
        return False
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ" if "." in value else "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False  # an impossible date, such as February 30
    return parsed.year >= 1  # parsed at all means every field was in range


def read_record():
    """The launch record from stdin, or None if anything about it is wrong. Never echoed."""
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        return None
    try:
        record = json.loads(data.decode("utf-8"), object_pairs_hook=no_duplicates)
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(record, dict) or tuple(sorted(record)) != tuple(sorted(FIELDS)):
        return None
    if not (isinstance(record["pid"], int) and not isinstance(record["pid"], bool) and record["pid"] > 0):
        return None
    if not all(isinstance(record[f], str) for f in ("runId", "token", "nonce")):
        return None
    if not RUN_ID.fullmatch(record["runId"]) or not real_stamp(record["startedAt"]):
        return None
    if not HEX32.fullmatch(record["token"]) or not HEX32.fullmatch(record["nonce"]):
        return None
    return record


def parse(argv):
    if len(argv) != 4 or argv[0::2] != ["--dir", "--mode"] or argv[3] != "acquire":
        return None
    directory = argv[1]
    if (
        not os.path.isabs(directory)
        or "\0" in directory
        or directory.startswith("//")
        or os.path.normpath(directory) != directory
        or os.path.basename(directory) in ("", ".", "..")
    ):
        return None
    return directory


def write_all(fd, data):
    """Every byte, through short writes. A write of nothing is a failure, never a loop."""
    written = 0
    while written < len(data):
        try:
            count = os.write(fd, data[written:])
        except OSError as error:
            return refused("write_failed", error)
        if count <= 0:
            return refused("write_failed")  # no progress: refuse rather than loop
        written += count
    return None


def acquire(directory, record, held, diagnostics):
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    temp_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        held.append(("close_directory", os.open(directory, dir_flags)))
    except OSError as error:
        return refused("directory_missing" if error.errno == errnos.ENOENT else "directory_unusable", error)
    dir_fd = held[0][1]
    temp = "run.lock.tmp-" + record["nonce"]
    try:
        fd = os.open(temp, temp_flags, 0o600, dir_fd=dir_fd)
    except OSError as error:
        return refused("temp_exists" if error.errno == errnos.EEXIST else "temp_create_failed", error)
    held.append(("close_temp", fd))

    # the only evidence that lets this helper remove that name again
    try:
        owned = os.fstat(fd)
    except OSError as error:
        diagnostics.append({"step": "temp_may_remain", "errno": None})
        return refused("ownership_unknown", error)

    def drop_temp():
        """Remove the temporary file, but only while it is still the file this helper created."""
        try:
            now = os.stat(temp, dir_fd=dir_fd, follow_symlinks=False)
        except OSError as error:
            return diagnostics.append({"step": "unlink_temp", "errno": name_of(error)})
        if (now.st_dev, now.st_ino) != (owned.st_dev, owned.st_ino):
            return diagnostics.append({"step": "temp_replaced", "errno": None})
        try:
            os.unlink(temp, dir_fd=dir_fd)
        except OSError as error:
            diagnostics.append({"step": "unlink_temp", "errno": name_of(error)})

    body = json.dumps(
        {"version": 1, **{f: record[f] for f in ("runId", "pid", "startedAt", "token")}}
    ).encode("utf-8") + b"\n"
    failure = write_all(fd, body)
    if failure is None:
        try:
            os.fsync(fd)
        except OSError as error:
            failure = refused("fsync_failed", error)
    try:
        os.close(fd)
        held.pop()  # closed here, so cleanup below does not close it twice
    except OSError as error:
        held.pop()
        # an earlier failure keeps the reason; the close still has to be visible, never dropped
        if failure is None:
            failure = refused("close_failed", error)
        else:
            diagnostics.append({"step": "close_temp", "errno": name_of(error)})
    if failure is not None:
        drop_temp()
        return failure

    try:
        os.link(temp, "run.lock", src_dir_fd=dir_fd, dst_dir_fd=dir_fd, follow_symlinks=False)
    except OSError as error:
        published = refused("link_failed", error) if error.errno != errnos.EEXIST else {"kind": "held"}
        drop_temp()
        return published
    drop_temp()  # published: whatever happens now, the lock is held
    return {"kind": "acquired"}


def main(argv):
    directory = parse(argv)
    record = read_record() if directory is not None else None
    held, diagnostics = [], []
    if directory is None or record is None:
        result = refused("arguments")
    elif not capable():
        result = refused("capability")
    else:
        try:
            result = acquire(directory, record, held, diagnostics)
        finally:
            for step, fd in reversed(held):
                try:
                    os.close(fd)
                except OSError as error:
                    diagnostics.append({"step": step, "errno": name_of(error)})
    result["diagnostics"] = diagnostics
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main(sys.argv[1:])
