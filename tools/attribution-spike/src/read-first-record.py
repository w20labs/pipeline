"""Read the first record of one file, reached from a root directory descriptor.

Node has no descriptor-relative open, so this does the one read that has to be anchored: the root
is opened as a directory, each component is opened relative to the descriptor before it with
O_NOFOLLOW, and the file is read through the last one. Once a component is held, swapping or
restoring pathnames cannot redirect the read outside the root.

TRUSTED ROOT: protection starts from the opened root descriptor. Nothing here proves the root's
pathname was unchanged before it was opened; that path is created and recorded by the harness.

Output is one JSON object on stdout, always, with exit status 0. The caller validates it.
"""

import base64
import json
import os
import stat
import sys
import time



def emit(result):
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


def fail(step, error, close_errors=(), **extra):
    emit({"ok": False, "step": step, "error": error, "closeErrors": list(close_errors), **extra})


def capable():
    missing = [
        name
        for name, present in (
            ("dir_fd for os.open", os.open in os.supports_dir_fd),
            ("O_NOFOLLOW", hasattr(os, "O_NOFOLLOW")),
            ("O_DIRECTORY", hasattr(os, "O_DIRECTORY")),
            ("O_NONBLOCK", hasattr(os, "O_NONBLOCK")),
            ("O_CLOEXEC", hasattr(os, "O_CLOEXEC")),
        )
        if not present
    ]
    return missing


def valid_component(part):
    return (
        part not in ("", ".", "..")
        and "/" not in part
        and "\\" not in part
        and "\0" not in part
        and not os.path.isabs(part)
    )


def barrier(directory, point):
    """Test-only. Announce reaching `point`, then wait to be released. Never set in production."""
    if directory is None:
        return
    open(os.path.join(directory, point + ".ready"), "w").close()
    go = os.path.join(directory, point + ".go")
    while not os.path.exists(go):
        time.sleep(0.01)  # bounded by the caller, which terminates this process at its deadline


def main(argv):
    missing = capable()
    if missing:
        return fail("capability", "this Python lacks: " + ", ".join(missing))

    root, components, cap, barrier_dir = None, [], None, None
    it = iter(argv)
    try:
        for flag in it:
            if flag == "--root":
                root = next(it)
            elif flag == "--component":
                components.append(next(it))
            elif flag == "--cap":
                cap = int(next(it))
            elif flag == "--barrier":
                barrier_dir = next(it)
            else:
                return fail("arguments", "unknown argument " + flag)
    except (StopIteration, ValueError) as error:
        return fail("arguments", "malformed arguments: " + str(error))
    if root is None or not os.path.isabs(root) or not components or cap is None or cap <= 0:
        return fail("arguments", "a root, at least one component and a positive cap are required")
    bad = [part for part in components if not valid_component(part)]
    if bad:
        return fail("arguments", "invalid components: " + json.dumps(bad))

    held, close_errors = [], []
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC

    def release():
        for fd in reversed(held):
            try:
                os.close(fd)
            except OSError as error:
                close_errors.append(os.strerror(error.errno) if error.errno else str(error))
        held.clear()

    try:
        try:
            held.append(os.open(root, directory_flags))
        except OSError as error:
            release()
            return fail("root", os.strerror(error.errno), close_errors)
        barrier(barrier_dir, "root")

        for index, part in enumerate(components[:-1]):
            try:
                held.append(os.open(part, directory_flags, dir_fd=held[-1]))
            except OSError as error:
                release()
                return fail("component", part + ": " + os.strerror(error.errno), close_errors)
            barrier(barrier_dir, "component-" + str(index))

        barrier(barrier_dir, "file")
        name = components[-1]
        file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
        try:
            fd = os.open(name, file_flags, dir_fd=held[-1])
        except OSError as error:
            release()
            return fail("file", name + ": " + os.strerror(error.errno), close_errors)
        held.append(fd)

        try:
            mode = os.fstat(fd).st_mode
        except OSError as error:
            release()
            return fail("type", name + ": " + os.strerror(error.errno), close_errors)
        if not stat.S_ISREG(mode):
            release()
            return fail("type", name + " is not a regular file", close_errors)

        data = bytearray()
        newline = False
        try:
            while len(data) < cap:
                byte = os.read(fd, 1)  # one byte at a time: nothing past the first newline is touched
                if not byte:
                    break
                data += byte
                if byte == b"\n":
                    newline = True
                    break
        except OSError as error:
            release()
            return fail("read", os.strerror(error.errno), close_errors, count=len(data))

        release()
        emit(
            {
                "ok": True,
                "count": len(data),
                "bytes": base64.b64encode(bytes(data)).decode("ascii"),
                "newline": newline,
                "closeErrors": close_errors,
            }
        )
    finally:
        release()


if __name__ == "__main__":
    main(sys.argv[1:])
