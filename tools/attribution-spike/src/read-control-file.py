"""Read one small control file from a control directory, bounded and without following links.

Run as a subprocess so the caller can stop it: a descriptor opened after the caller gave up dies with
this process. The directory is opened with O_DIRECTORY|O_NOFOLLOW; the file relative to it with
O_NOFOLLOW|O_NONBLOCK, so a symlink is refused by the kernel and a FIFO opens without blocking and is
then refused as not regular. At most cap + 1 bytes are ever read.

TRUSTED ANCESTRY: the control directory's parent path is trusted; protection starts at its descriptor.

OUTPUT: exactly one JSON line on stdout, exit status 0, written after every descriptor is closed.
  {"kind": "read", "base64": str, "diagnostics": []}
  {"kind": "missing", "diagnostics": []}                     the file does not exist
  {"kind": "refused", "reason": REASON, "errno": str|null, "diagnostics": [DIAGNOSTIC, ...]}
REASON is one of: arguments, capability, directory_missing, directory_unusable, symlink, open_failed,
  fstat_failed, not_regular, too_large, read_failed, close_failed.
DIAGNOSTIC is {"step": "close_file"|"close_directory", "errno": str|null}. `diagnostics` is always
present; on "read" and "missing" it is always empty, because any close failure turns the result
into {"kind": "refused", "reason": "close_failed"} and discards the bytes. Nothing from the file's
contents or name ever appears outside "base64".
"""

import base64
import errno as errnos
import json
import os
import stat
import sys

MAX_CAP = 1 << 20


def name_of(error):
    return errnos.errorcode.get(error.errno) if error.errno else None


def valid_name(name):
    return name not in ("", ".", "..") and not any(c in name for c in ("/", "\\", "\0"))


def valid_directory(path):
    """A lexically normalized absolute path whose last component is the directory's own name.

    O_NOFOLLOW applies only to the final component, so "link/" or "link/." would resolve through the
    link first. This check is lexical, so nothing can change between it and the open; it does not
    prove the path is physically canonical, and the directory's ancestry remains trusted.
    """
    return (
        os.path.isabs(path)
        and "\0" not in path
        and not path.startswith("//")
        and os.path.normpath(path) == path
        and os.path.basename(path) not in ("", ".", "..")
    )


def capable():
    return (
        os.open in os.supports_dir_fd
        and all(hasattr(os, flag) for flag in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK", "O_CLOEXEC"))
    )


def parse(argv):
    if len(argv) != 6 or argv[0::2] != ["--dir", "--name", "--cap"]:
        return None
    directory, name, cap = argv[1], argv[3], argv[5]
    if not valid_directory(directory) or not valid_name(name):
        return None
    # bounded before converting: Python refuses to convert very long digit strings at all
    if not cap.isascii() or not cap.isdigit() or len(cap) > len(str(MAX_CAP)):
        return None
    if not 0 < int(cap) <= MAX_CAP:
        return None
    return directory, name, int(cap)


def refused(reason, error=None):
    return {"kind": "refused", "reason": reason, "errno": None if error is None else name_of(error)}


def read_file(directory, name, cap, held):
    try:
        held.append(("close_directory", os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)))
    except OSError as error:
        return refused("directory_missing" if error.errno == errnos.ENOENT else "directory_unusable", error)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        fd = os.open(name, flags, dir_fd=held[0][1])
    except OSError as error:
        if error.errno == errnos.ENOENT:
            return {"kind": "missing"}
        return refused("symlink" if error.errno == errnos.ELOOP else "open_failed", error)
    held.append(("close_file", fd))
    try:
        mode = os.fstat(fd).st_mode
    except OSError as error:
        return refused("fstat_failed", error)
    if not stat.S_ISREG(mode):
        return refused("not_regular")
    data = bytearray()
    try:
        while len(data) <= cap:
            chunk = os.read(fd, cap + 1 - len(data))  # short reads loop; never past cap + 1
            if not chunk:
                break
            data += chunk
    except OSError as error:
        return refused("read_failed", error)
    if len(data) > cap:
        return refused("too_large")
    return {"kind": "read", "base64": base64.b64encode(bytes(data)).decode("ascii")}


def main(argv):
    parsed = parse(argv)
    held, diagnostics = [], []
    if parsed is None:
        result = refused("arguments")
    elif not capable():
        result = refused("capability")
    else:
        try:
            result = read_file(*parsed, held)
        finally:
            for step, fd in reversed(held):
                try:
                    os.close(fd)
                except OSError as error:
                    diagnostics.append({"step": step, "errno": name_of(error)})
    if diagnostics and result["kind"] != "refused":
        result = refused("close_failed")  # the bytes are discarded
    result["diagnostics"] = diagnostics
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main(sys.argv[1:])
