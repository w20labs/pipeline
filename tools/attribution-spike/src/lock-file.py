"""Take or release the research run lock, from a directory descriptor.

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
  names the temporary file. Release reads the same record: its token is what proves ownership.

OUTPUT: exactly one JSON line on stdout, exit status 0, after every descriptor is closed.
  {"kind": "acquired", "diagnostics": [DIAGNOSTIC, ...]}   run.lock was published by this run
  {"kind": "held", "diagnostics": [...]}                   something already held run.lock
  {"kind": "refused", "reason": REASON, "errno": str|null, "diagnostics": [...]}
REASON (acquire): arguments, capability, directory_missing, directory_unusable, temp_exists,
  temp_create_failed, ownership_unknown, write_failed, fsync_failed, close_failed, link_failed.

RELEASE (--mode release) removes run.lock only while it still holds a whole record carrying this
run's token, rechecked by device and inode immediately before the unlink.
  {"kind": "released"|"missing"|"not_ours"|"unrecognized"|"replaced", "diagnostics": [...]}
  {"kind": "refused", "reason": REASON, "errno": str|null, "diagnostics": [...]}
REASON (release): arguments, capability, directory_missing, directory_unusable, lock_unusable,
  not_regular, fstat_failed, read_failed, too_large, stat_failed, unlink_failed.
Anything but "released" leaves the file exactly as found: same bytes, inode and type.
DIAGNOSTIC: {"step": str, "errno": str|null}, step one of close_temp, unlink_temp, temp_replaced,
  temp_may_remain, close_directory, close_lock, or — from release's cleanup of this run's own
  leftover temporary file — temp_unusable, temp_fstat_failed, temp_read_failed, temp_too_large,
  temp_partial, temp_unrecognized, temp_stat_failed, temp_unlink_failed, temp_close_failed.
  Diagnostics accumulate; none of them changes the outcome. `acquired` with diagnostics still means the lock is held: the
  caller must release it, and must keep the diagnostics.
"""

import errno as errnos
import json
import os
import re
import stat
import sys
from datetime import datetime

MAX_INPUT = 4096
HEX32 = re.compile(r"[0-9a-f]{32}")
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z")
FIELDS = ("runId", "pid", "startedAt", "token", "nonce")
WRITTEN = ("version", "runId", "pid", "startedAt", "token")
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
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None  # deeply nested JSON exhausts the parser: refuse, never crash
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
    if len(argv) != 4 or argv[0::2] != ["--dir", "--mode"] or argv[3] not in ("acquire", "release"):
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
    return directory, argv[3]


def whole_integer(value):
    """A real integer, never a bool: Python counts True as 1, which must not pass for a version."""
    return isinstance(value, int) and not isinstance(value, bool)


def lock_record(data):
    """The record a lock file must hold, or None. Same rules as the record this helper writes."""
    try:
        record = json.loads(data.decode("utf-8"), object_pairs_hook=no_duplicates)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None  # deeply nested JSON exhausts the parser: refuse, never crash
    if not isinstance(record, dict) or tuple(sorted(record)) != tuple(sorted(WRITTEN)):
        return None
    if not (whole_integer(record["version"]) and record["version"] == 1):
        return None
    if not (whole_integer(record["pid"]) and record["pid"] > 0):
        return None
    if not all(isinstance(record[f], str) for f in ("runId", "token")):
        return None
    if not RUN_ID.fullmatch(record["runId"]) or not real_stamp(record["startedAt"]):
        return None
    return record if HEX32.fullmatch(record["token"]) else None


def read_whole(fd, cap):
    """At most cap + 1 bytes, through short reads. More than cap means the file is too large."""
    data = bytearray()
    while len(data) <= cap:
        try:
            chunk = os.read(fd, cap + 1 - len(data))
        except OSError as error:
            return None, refused("read_failed", error)
        if not chunk:
            break
        data += chunk
    return (None, refused("too_large")) if len(data) > cap else (bytes(data), None)


def release_lock(record, dir_fd, held):
    """Remove run.lock, but only while it is still the whole record this run's token published.

    RACE: between the device and inode recheck and the unlink, the name could still be replaced, so
    the unlink could remove a different file. POSIX offers no unlink-by-descriptor to close that
    window. Under the cooperative assumptions it cannot arise; outside them the recheck narrows it.
    """
    lock_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        fd = os.open("run.lock", lock_flags, dir_fd=dir_fd)
    except OSError as error:
        if error.errno == errnos.ENOENT:
            return {"kind": "missing"}
        return refused("lock_unusable", error)
    held.append(("close_lock", fd))

    try:
        owned = os.fstat(fd)
    except OSError as error:
        return refused("fstat_failed", error)
    if not stat.S_ISREG(owned.st_mode):
        return refused("not_regular")
    data, failure = read_whole(fd, MAX_INPUT)
    if failure is not None:
        return failure
    held_record = lock_record(data)
    if held_record is None:
        return {"kind": "unrecognized"}
    if held_record["token"] != record["token"]:
        return {"kind": "not_ours"}

    # the same file, right now: a name that has been replaced is never unlinked
    try:
        now = os.stat("run.lock", dir_fd=dir_fd, follow_symlinks=False)
    except OSError as error:
        return refused("stat_failed", error)
    if (now.st_dev, now.st_ino) != (owned.st_dev, owned.st_ino):
        return {"kind": "replaced"}
    try:
        os.unlink("run.lock", dir_fd=dir_fd)
    except OSError as error:
        return refused("unlink_failed", error)
    return {"kind": "released"}




def drop_leftover(temp, token, dir_fd, diagnostics):
    """Remove a temporary file this run left behind — and nothing else.

    Only a regular file holding a whole record with this run's token is removed, and only while its
    device and inode still match what was read. Anything else is left exactly as found and reported.
    Diagnostics accumulate: a close failure is added beside whatever was already reported.
    """
    temp_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    def note(step, error=None):
        diagnostics.append({"step": step, "errno": None if error is None else name_of(error)})
    try:
        fd = os.open(temp, temp_flags, dir_fd=dir_fd)
    except OSError as error:
        return None if error.errno == errnos.ENOENT else note("temp_unusable", error)
    try:
        try:
            owned = os.fstat(fd)
        except OSError as error:
            return note("temp_fstat_failed", error)
        if not stat.S_ISREG(owned.st_mode):
            return note("temp_unusable")
        data, failure = read_whole(fd, MAX_INPUT)
        if failure is not None:
            too_large = failure["reason"] == "too_large"
            return diagnostics.append(
                {"step": "temp_too_large" if too_large else "temp_read_failed", "errno": failure["errno"]}
            )
        left = lock_record(data)
        if left is None:
            return note("temp_partial")
        if left["token"] != token:
            return note("temp_unrecognized")
        try:
            now = os.stat(temp, dir_fd=dir_fd, follow_symlinks=False)
        except OSError as error:
            return note("temp_stat_failed", error)
        if (now.st_dev, now.st_ino) != (owned.st_dev, owned.st_ino):
            return note("temp_replaced")
        try:
            os.unlink(temp, dir_fd=dir_fd)
        except OSError as error:
            note("temp_unlink_failed", error)
    finally:
        try:
            os.close(fd)
        except OSError as error:
            note("temp_close_failed", error)


def release(directory, record, held, diagnostics):
    """Anchor the directory, release the lock, then clean up this run's own leftover file.

    Cleanup runs only once the directory is anchored, so a refusal for arguments, a capability or the
    directory itself touches nothing. Whatever it finds is a diagnostic: the outcome stays the lock's.
    """
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        held.append(("close_directory", os.open(directory, dir_flags)))
    except OSError as error:
        kind = "directory_missing" if error.errno == errnos.ENOENT else "directory_unusable"
        return refused(kind, error)
    dir_fd = held[0][1]
    outcome = release_lock(record, dir_fd, held)
    drop_leftover("run.lock.tmp-" + record["nonce"], record["token"], dir_fd, diagnostics)
    return outcome


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

    body = json.dumps({"version": 1, **{f: record[f] for f in WRITTEN[1:]}}).encode("utf-8") + b"\n"
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
    parsed = parse(argv)
    record = read_record() if parsed is not None else None
    held, diagnostics = [], []
    if parsed is None or record is None:
        result = refused("arguments")
    elif not capable():
        result = refused("capability")
    else:
        directory, mode = parsed
        try:
            run = acquire if mode == "acquire" else release
            result = run(directory, record, held, diagnostics)
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
