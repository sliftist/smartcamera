import os

import psutil

from paths import REPO_ROOT

VENV_PYTHON = (REPO_ROOT / "python" / ".venv" / "Scripts" / "python.exe").resolve()
SELF_MARKER = "stopStray"


def main() -> None:
    me = os.getpid()
    stopped = 0
    for process in psutil.process_iter(["pid", "exe", "cmdline"]):
        if process.info["pid"] == me:
            continue
        executable = process.info.get("exe")
        if not executable:
            continue
        try:
            if os.path.normcase(executable) != os.path.normcase(str(VENV_PYTHON)):
                continue
            command = " ".join(process.info.get("cmdline") or [])
            if SELF_MARKER in command:
                continue
            print(f"[stop] terminating pid {process.info['pid']}: {command[:110]}")
            process.terminate()
            stopped += 1
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    print(f"[stop] terminated {stopped} stray venv python processes")


if __name__ == "__main__":
    main()
