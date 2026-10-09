#!/usr/bin/env python3
"""Best-effort, once-per-run stack capture for a stalled Debug UI startup probe."""

import json
import pathlib
import re
import signal
import subprocess
import sys
import time
import uuid


stopping = False


def stop(_signal, _frame):
    global stopping
    stopping = True


def command(arguments, timeout=5):
    try:
        result = subprocess.run(arguments, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout)
        return result.stdout, "completed" if result.returncode == 0 else "command-failed"
    except subprocess.TimeoutExpired:
        return "", "timed-out"
    except OSError:
        return "", "unavailable"


def executable(pid):
    output, status = command(["/bin/ps", "-p", str(pid), "-o", "comm="], timeout=2)
    return output.strip() if status == "completed" else ""


def app_identity(path, simulator):
    return (f"/CoreSimulator/Devices/{simulator}/data/Containers/Bundle/Application/" in path
            and path.endswith("/App.app/App"))


def webcontent_identity(path):
    # Both WebKit's XPC service and the newer ExtensionKit runtime layout occur
    # in supported simulator runtimes. Never sample an arbitrary same-name app.
    if "/CoreSimulator/" not in path or ".simruntime/" not in path:
        return False
    return path.endswith((
        "/com.apple.WebKit.WebContent.xpc/com.apple.WebKit.WebContent",
        "/WebContentExtension.appex/com.apple.WebKit.WebContent",
    ))


def webcontent_pid(log, app_pid):
    pattern = re.compile(
        r"\bApp\[(\d+):[0-9a-fA-F]+\]\s+\[com\.apple\.WebKit:Process\]"
        r".*?\[PID=(\d+)\]\s+WebProcessProxy::didFinishLaunching:")
    matches = {int(child) for parent, child in pattern.findall(log)
               if int(parent) == app_pid and int(child) > 1}
    return next(iter(matches)) if len(matches) == 1 else None


def pending_probes(directory):
    for requested in sorted(directory.glob("*-requested.json")):
        try:
            data = json.loads(requested.read_text())
            if not isinstance(data, dict):
                continue
            pid = data.get("appProcessID")
            if (data.get("phase") != "requested" or data.get("isLoading") is not True
                    or type(pid) is not int or pid <= 1
                    or data.get("version") != 1):
                continue
            fixture = str(uuid.UUID(data["fixtureID"])).upper()
            launch = str(uuid.UUID(data["launchID"])).upper()
            if requested.name != f"{fixture}-{launch}-requested.json":
                continue
            completed = directory / f"{fixture}-{launch}-completed.json"
            age = time.time() - requested.stat().st_mtime
            if not 2 <= age <= 45:
                continue
            data["trigger"] = "loading-javascript-callback-pending"
            if completed.exists():
                latest = json.loads(completed.read_text())
                if (not isinstance(latest, dict) or latest.get("phase") != "completed" or latest.get("version") != 1
                        or latest.get("fixtureID") != fixture or latest.get("launchID") != launch
                        or latest.get("appProcessID") != pid or latest.get("isLoading") is not True):
                    continue
                if not any(latest.get(key) is False for key in ("hasSettings", "hasCapacitor", "playerReady")):
                    continue
                data["trigger"] = "loading-document-not-ready"
            yield data, age
        except (OSError, ValueError, KeyError, TypeError):
            continue


def sample_process(pid, kind, simulator, output):
    path = executable(pid)
    verified = app_identity(path, simulator) if kind == "app" else webcontent_identity(path)
    result = {"kind": kind, "processID": pid, "identityVerified": verified}
    if not verified:
        result["status"] = "identity-unavailable-or-mismatched"
        return result
    if stopping:
        result["status"] = "watcher-stopped"
        return result
    diagnostic, result["status"] = command([
        "/usr/bin/sample", str(pid), "1", "-file", str(output / f"startup-sample-{kind}.log")
    ])
    (output / f"startup-sample-{kind}-command.log").write_text(diagnostic)
    return result


def capture(data, age, simulator, output):
    app_pid = data["appProcessID"]
    result = {"diagnosticOnly": True, "status": "stall-observed",
              "fixtureID": data["fixtureID"], "launchID": data["launchID"],
              "trigger": data["trigger"],
              "probeAgeSeconds": round(age, 2), "sampleDurationSeconds": 1,
              "commandTimeoutSeconds": 5, "samples": []}
    result["samples"].append(sample_process(app_pid, "app", simulator, output))
    if stopping or not result["samples"][0]["identityVerified"]:
        result["webContentMapping"] = "app-unavailable-or-watcher-stopped"
        return result
    # Query only this App process's WebKit process-launch events. Retain the
    # numeric association, never raw log lines, process arguments or environment.
    predicate = (f'processID == {app_pid} AND subsystem == "com.apple.WebKit" '
                 'AND category == "Process" AND eventMessage CONTAINS "WebProcessProxy::didFinishLaunching:"')
    log, status = command(["xcrun", "simctl", "spawn", simulator, "log", "show",
                           "--last", "2m", "--style", "compact", "--predicate", predicate])
    child = webcontent_pid(log, app_pid) if status == "completed" else None
    result["webContentMapping"] = "unique" if child else "not-yet-launched-or-not-uniquely-mapped"
    result["mappingCommandStatus"] = status
    if child and not stopping:
        result["samples"].append(sample_process(child, "webcontent", simulator, output))
    return result


def main():
    simulator, directory, output = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
    uuid.UUID(simulator)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    deadline = time.monotonic() + 40 * 60
    result = {"diagnosticOnly": True, "status": "no-live-stalled-probe-matched"}
    captured = False
    while not stopping and time.monotonic() < deadline:
        for data, age in pending_probes(directory):
            # Ignore probes from an already-terminated fixture without consuming
            # the single capture attempt for this test run.
            if app_identity(executable(data["appProcessID"]), simulator):
                result = capture(data, age, simulator, output)
                captured = True
                break
        if captured:
            break
        time.sleep(1)
    (output / "startup-sample.json").write_text(json.dumps(result, indent=2) + "\n")
    # Keep the owned watcher alive until cleanup joins it, avoiding a stale PID
    # after an early capture. No further process queries or samples occur.
    while captured and not stopping and time.monotonic() < deadline:
        time.sleep(1)


if __name__ == "__main__":
    main()
