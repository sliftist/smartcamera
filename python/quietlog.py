import contextlib
import os
import sys


@contextlib.contextmanager
def redirect_fds(path):
    sys.stdout.flush()
    sys.stderr.flush()
    saved_out = os.dup(1)
    saved_err = os.dup(2)
    log = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    try:
        os.dup2(log, 1)
        os.dup2(log, 2)
        yield
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)
        os.close(log)


def tail(path, lines: int = 40) -> str:
    try:
        text = open(str(path), "r", encoding="utf-8", errors="replace").read()
    except FileNotFoundError:
        return ""
    return "\n".join(text.splitlines()[-lines:])
