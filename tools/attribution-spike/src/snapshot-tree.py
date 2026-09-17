"""Record metadata for every entry under a root, reached through directory descriptors.

TRUSTED ROOT: protection starts at the opened root descriptor; nothing proves the root's pathname
was unchanged before it was opened. A snapshot is a sequence of observations over time, not an
atomic view of the tree.

Only directories are opened, and only to list them, each relative to its parent descriptor with
O_DIRECTORY|O_NOFOLLOW and checked against the device and inode stat'd a moment before. Files are
never opened; link targets are never resolved.

PROTOCOL, one JSON object per line on stdout, exit status 0:
  {"type": "entry", "path": str, "kind": "file"|"dir"|"symlink"|"other",
   "size": str, "mtimeNs": str, "dev": str, "ino": str}
      path: relative to the root, "/"-separated, no empty, "." or ".." segments.
      size, mtimeNs (integer nanoseconds since the epoch), dev, ino: non-negative decimal
      integers as strings, so no value loses precision in JSON.
  {"type": "diagnostic", "message": str}
  {"type": "done", "entries": int, "diagnostics": int, "complete": bool}
      exactly once, last, after every descriptor was closed; counts include all lines before it.
"""

import json
import os
import stat
import sys

counts = {"entries": 0, "diagnostics": 0}
complete = True


def emit(record):
    sys.stdout.write(json.dumps(record) + "\n")
    sys.stdout.flush()


def diagnose(message):
    global complete
    complete = False
    counts["diagnostics"] += 1
    emit({"type": "diagnostic", "message": message})


def kind_of(mode):
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def missing_capabilities():
    checks = (
        ("scandir on a file descriptor", os.scandir in os.supports_fd),
        ("stat with dir_fd", os.stat in os.supports_dir_fd),
        ("stat with follow_symlinks=False", os.stat in os.supports_follow_symlinks),
        ("open with dir_fd", os.open in os.supports_dir_fd),
        ("O_NOFOLLOW", hasattr(os, "O_NOFOLLOW")),
        ("O_DIRECTORY", hasattr(os, "O_DIRECTORY")),
        ("O_NONBLOCK", hasattr(os, "O_NONBLOCK")),
        ("O_CLOEXEC", hasattr(os, "O_CLOEXEC")),
    )
    return [name for name, present in checks if not present]


class CapReached(Exception):
    pass


def close(fd, what):
    try:
        os.close(fd)
    except OSError as error:
        diagnose(what + ": close failed: " + os.strerror(error.errno))


def walk(fd, prefix, cap, flags):
    # Enumeration itself is bounded: at most one name past what the cap still allows is read from
    # this directory, so a huge directory cannot be materialised. Memory is then bounded by
    # (cap + 1) names per directory level being walked. Order is sorted within what was read.
    budget = cap - counts["entries"] + 1
    names = []
    try:
        with os.scandir(fd) as listing:
            for entry in listing:
                names.append(entry.name)
                if len(names) >= budget:
                    break
    except OSError as error:
        return diagnose((prefix or ".") + ": cannot list: " + os.strerror(error.errno))
    names.sort()
    for name in names:
        path = prefix + "/" + name if prefix else name
        if counts["entries"] >= cap:
            raise CapReached()
        try:
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except OSError as error:
            diagnose(path + ": cannot stat: " + os.strerror(error.errno))
            continue
        kind = kind_of(st.st_mode)
        counts["entries"] += 1
        emit({"type": "entry", "path": path, "kind": kind, "size": str(st.st_size),
              "mtimeNs": str(st.st_mtime_ns), "dev": str(st.st_dev), "ino": str(st.st_ino)})
        if kind != "dir":
            continue
        try:
            child = os.open(name, flags, dir_fd=fd)
        except OSError as error:
            diagnose(path + ": cannot open directory: " + os.strerror(error.errno))
            continue
        try:
            try:
                opened = os.fstat(child)
            except OSError as error:
                diagnose(path + ": cannot stat the opened directory: " + os.strerror(error.errno))
                continue
            if (opened.st_dev, opened.st_ino) != (st.st_dev, st.st_ino):
                diagnose(path + ": changed between stat and open")
            else:
                walk(child, path, cap, flags)
        finally:
            close(child, path)  # runs on every path above, the fstat failure included


def main(argv):
    if len(argv) != 4 or argv[0] != "--root" or argv[2] != "--cap":
        diagnose("usage: --root <absolute path> --cap <positive integer>")
    else:
        missing = missing_capabilities()
        root, cap_text = argv[1], argv[3]
        if missing:
            diagnose("this Python lacks: " + ", ".join(missing))
        elif not os.path.isabs(root) or not cap_text.isdigit() or int(cap_text) <= 0:
            diagnose("the root must be absolute and the cap a positive integer")
        else:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
            try:
                fd = os.open(root, flags)
            except OSError as error:
                diagnose("cannot open root: " + os.strerror(error.errno))
            else:
                try:
                    walk(fd, "", int(cap_text), flags)
                except CapReached:
                    diagnose("cap_reached: stopped after " + cap_text + " entries")
                finally:
                    close(fd, "root")
    # after every descriptor is closed, so these counts include any close diagnostics
    emit({"type": "done", "entries": counts["entries"], "diagnostics": counts["diagnostics"],
          "complete": complete})


if __name__ == "__main__":
    main(sys.argv[1:])
