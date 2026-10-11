#!/usr/bin/env python3
"""Bound native CI commands and summarize evidence without changing test verdicts."""

import argparse
import datetime
import hashlib
import json
import math
import os
import pathlib
import platform
import re
import signal
import subprocess
import sys
import time
import uuid


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def append_event(directory, event):
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "command-events.jsonl").open("a") as output:
            output.write(json.dumps({"version": 1, "utc": utc_now(), **event}) + "\n")
    except OSError as error:
        # Evidence collection must not replace the command's verdict.
        print(f"Command event unavailable ({type(error).__name__})", file=sys.stderr)


def stop_group(process, initial_signal=signal.SIGTERM):
    # Only signal the group created for this command. Descendants that create
    # another session are outside this scope; only our direct child can be reaped.
    after_leader_exit = process.returncode is not None
    result = {"afterLeaderExit": after_leader_exit, "status": "not-needed"}

    def send(signum):
        try:
            os.killpg(process.pid, signum)
            return True
        except ProcessLookupError:
            return False

    try:
        if send(initial_signal):
            result["status"] = "terminated"
            # Leader exit does not imply that descendants released their pipes.
            deadline = time.monotonic() + 1
            while True:
                process.poll()
                if not send(0):
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    if send(signal.SIGKILL):
                        result["status"] = "killed"
                    break
                time.sleep(min(0.05, remaining))
    except OSError as error:
        result.update(status="signal-failed", errorType=type(error).__name__)
    try:
        process.wait(timeout=1)
        result["leaderReaped"] = True
    except subprocess.TimeoutExpired:
        result["leaderReaped"] = False
        result["status"] = "reap-timed-out"
    return result


def run_command(directory, phase, timeout, command):
    started = time.monotonic()
    deadline = started + timeout
    identity = {"phase": phase, "commandId": uuid.uuid4().hex}
    append_event(directory, {**identity, "status": "started", "timeoutSeconds": timeout})
    process = None
    interrupted = None
    handlers = {}
    cleanup = None
    code, status = 127, "unavailable"

    def cancel(signum, _frame):
        nonlocal interrupted
        # Popen.wait holds a non-reentrant lock at some signal-delivery points.
        # Signal handlers must never wait, reap, write evidence, or signal groups.
        if interrupted is None:
            interrupted = signum

    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            handlers[signum] = signal.signal(signum, cancel)
        if interrupted is not None:
            code, status = 128 + interrupted, "cancelled"
        else:
            process = subprocess.Popen(command, start_new_session=True)
            while True:
                if interrupted is not None:
                    code, status = 128 + interrupted, "cancelled"
                    break
                remaining = deadline - time.monotonic()
                try:
                    code = process.wait(timeout=max(0, min(0.05, remaining)))
                    status = "completed" if code == 0 else "command-failed"
                    if code < 0:
                        code = 128 - code
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() >= deadline:
                        code, status = 124, "timed-out"
                        break
            # Also release inherited pipes when the leader exits normally.
            cleanup = stop_group(process, interrupted or signal.SIGTERM)
        if interrupted is not None:
            code, status = 128 + interrupted, "cancelled"
    except OSError as error:
        # Do not log arguments or the environment, which may carry credentials.
        print(f"{phase}: command unavailable ({type(error).__name__})", file=sys.stderr)
        code, status = 127, "unavailable"
        if interrupted is not None:
            code, status = 128 + interrupted, "cancelled"
    finally:
        try:
            event = {**identity, "status": status, "exitCode": code,
                     "elapsedSeconds": round(time.monotonic() - started, 3)}
            if cleanup and cleanup["status"] != "not-needed":
                event["processGroupCleanup"] = cleanup
            append_event(directory, event)
            if code:
                print(f"{phase}: {status} (exit {code}); see command-events.jsonl", file=sys.stderr)
        finally:
            for signum, handler in handlers.items():
                signal.signal(signum, handler)
    return code


def refuse_command(directory, phase):
    append_event(directory, {"phase": phase, "commandId": uuid.uuid4().hex,
                             "status": "budget-exhausted", "exitCode": 124,
                             "elapsedSeconds": 0})
    print(f"{phase}: budget-exhausted (exit 124); command not started", file=sys.stderr)
    return 124


def command_text(arguments):
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=5)
        return result.stdout.strip() if result.returncode == 0 else "unavailable"
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"


def write_manifest(directory):
    # Explicit allowlist; never serialize the complete runner environment.
    keys = ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "GITHUB_SHA",
            "GITHUB_HEAD_REF", "GITHUB_BASE_REF", "RUNNER_OS", "RUNNER_ARCH",
            "ImageOS", "ImageVersion", "DEVELOPER_DIR", "NOSTALGIFY_PR_HEAD_SHA",
            "NOSTALGIFY_PR_BASE_SHA", "NOSTALGIFY_STRICT_CONCURRENCY"]
    hashes = {}
    for name in ["package-lock.json", "apps/ipad/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"]:
        path = pathlib.Path(name)
        if path.is_file():
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    harness_hashes = {}
    for name in ["scripts/ios-ci-diagnostics.py", "scripts/ios-ci-harness.sh",
                 "scripts/check-ios-simulator.sh", ".github/workflows/ci.yml"]:
        path = pathlib.Path(name)
        if path.is_file():
            harness_hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    diff = command_text(["git", "diff", "--binary", "HEAD"])
    value = {"version": 1, "startedAtUTC": utc_now(), "architecture": platform.machine(),
             "runner": {key: os.environ[key] for key in keys if key in os.environ},
             "checkoutSHA": command_text(["git", "rev-parse", "HEAD"]),
             "trackedWorkingTreeDirty": None if diff == "unavailable" else bool(diff),
             "trackedDiffSHA256": None if diff == "unavailable" else hashlib.sha256(diff.encode()).hexdigest(),
             "os": command_text(["sw_vers"]), "xcode": command_text(["xcodebuild", "-version"]),
             "swift": command_text(["xcrun", "swift", "--version"]),
             "node": command_text(["node", "--version"]), "lockSHA256": hashes,
             "harnessSHA256": harness_hashes}
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "run-manifest.json").write_text(json.dumps(value, indent=2) + "\n")


def read_object(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def test_identity(value):
    match = re.fullmatch(r"-\[(\S+) (\S+)\]", value)
    if match:
        return match[1].rsplit(".", 1)[-1] + "/" + match[2] + "()"
    return value


def phase_evidence(log):
    active, latest, thrown, before_teardown = {}, {}, {}, {}
    try:
        with log.open(errors="replace") as source:
            for line in source:
                marker = "NOSTALGIFY_TEST_PHASE "
                if marker not in line:
                    continue
                try:
                    event = json.loads(line.split(marker, 1)[1])
                    if not isinstance(event, dict) or not all(isinstance(event[key], str) and event[key] for key in
                               ["testId", "fixtureId", "phaseId", "phase", "status"]):
                        continue
                    if event["status"] not in ("started", "finished", "threw"):
                        continue
                    test = test_identity(event["testId"])
                    identifier = (event["fixtureId"], event["phaseId"])
                except (ValueError, KeyError, TypeError):
                    continue
                pending = active.setdefault(test, {})
                if event["phase"] == "teardown" and event["status"] == "started":
                    before_teardown[test] = {
                        "event": latest.get(test), "pending": list(pending.values()),
                        "thrown": thrown.get(test)}
                latest[test] = event
                if event["status"] == "started":
                    pending[identifier] = event
                else:
                    pending.pop(identifier, None)
                if event["status"] == "threw":
                    thrown.setdefault(test, event)
    except OSError:
        pass
    evidence = {}
    for test, event in latest.items():
        earlier = before_teardown.get(test, {})
        # Preserve the original action failure even if cleanup subsequently
        # completes or fails too. A teardown-only hang still reports termination.
        if earlier.get("thrown"):
            selected, status = earlier["thrown"], "threw"
        elif earlier.get("pending"):
            selected, status = earlier["pending"][-1], "unfinished"
        elif test in thrown:
            selected, status = thrown[test], "threw"
        elif active[test]:
            selected, status = list(active[test].values())[-1], "unfinished"
        else:
            selected = earlier.get("event") or event
            status = selected["status"]
        evidence[test] = {"phase": selected["phase"], "status": status}
    return evidence


def markdown(value):
    return str(value).replace("\n", " ").replace("\r", " ").replace("|", "\\|").replace("`", "'").replace("<", "&lt;")


def command_evidence(path):
    issues, pending, malformed = [], {}, 0
    try:
        with path.open(errors="replace") as source:
            for line in source:
                try:
                    event = json.loads(line)
                    if not isinstance(event, dict) or not all(
                            isinstance(event.get(key), str) and event[key] for key in ("phase", "status")):
                        raise ValueError("invalid command event")
                    identifier = event.get("commandId", event["phase"])
                    if not isinstance(identifier, str):
                        raise ValueError("invalid command identity")
                except (ValueError, TypeError):
                    malformed += 1
                    continue
                if event["status"] == "started":
                    pending[identifier] = event
                    continue
                pending.pop(identifier, None)
                expected_stream_stop = event["phase"] in ("app-log-stream", "startup-watcher") and event["status"] == "cancelled"
                if event["status"] != "completed" and not expected_stream_stop:
                    issues.append(event)
                cleanup = event.get("processGroupCleanup")
                if isinstance(cleanup, dict) and cleanup.get("status") in ("signal-failed", "reap-timed-out"):
                    issues.append({"phase": event["phase"], "status": "group-cleanup-incomplete",
                                   "exitCode": event.get("exitCode"), "processGroupCleanup": cleanup})
    except OSError:
        pass
    # A summary runs inside its own wrapper; that wrapper cannot finish until
    # this read completes. Its later failed terminal event is still reportable.
    issues.extend({**event, "status": "unfinished"} for event in pending.values()
                  if event["phase"] not in ("initial-summary", "final-summary"))
    return issues, malformed


def atomic_write(path, text):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(text)
        temporary.replace(path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def summarize(directory, exit_code):
    result = read_object(directory / "test-summary.json")
    evidence = phase_evidence(directory / "tests.log")
    failures = {}
    malformed_failures = 0
    records = result.get("testFailures", [])
    if not isinstance(records, list):
        records, malformed_failures = [], 1
    for failure in records:
        if not isinstance(failure, dict):
            malformed_failures += 1
            continue
        identity = failure.get("testIdentifierString") or failure.get("testName", "unknown")
        target, message = failure.get("targetName", "unknown"), failure.get("failureText", "No failure text available")
        if not all(isinstance(value, str) for value in (identity, target, message)):
            malformed_failures += 1
            continue
        key = (target, identity)
        entry = failures.setdefault(key, {"target": key[0], "test": identity, "messages": [],
                                          "lastPhase": evidence.get(identity)})
        entry["messages"].append(message)
    commands, malformed_commands = command_evidence(directory / "command-events.jsonl")
    counts = {key: result.get(key) if type(result.get(key)) is int and result[key] >= 0 else None
              for key in ["totalTestCount", "passedTests", "failedTests", "skippedTests"]}
    value = {"version": 1, "validationExitCode": exit_code, "resultAvailable": bool(result),
             "counts": counts, "failedTests": list(failures.values()), "commandIssues": commands,
             "malformedRecords": {"testFailures": malformed_failures, "commandEvents": malformed_commands}}
    directory.mkdir(parents=True, exist_ok=True)
    atomic_write(directory / "validation-summary.json", json.dumps(value, indent=2) + "\n")
    lines = ["## iPad native validation", "", f"Validation exit code: **{exit_code}**. Evidence: `{directory.name}`.", ""]
    if result:
        display_counts = {key: "unknown" if count is None else count for key, count in counts.items()}
        lines += [f"Tests: {display_counts['totalTestCount']} total; {display_counts['passedTests']} passed; "
                  f"{display_counts['failedTests']} failed; {display_counts['skippedTests']} skipped.", ""]
        if counts["totalTestCount"] == 0:
            lines += ["**No tests executed.** Inspect build/launch errors and raw logs; zero failed cases does not establish success.", ""]
        elif counts["totalTestCount"] is None:
            lines += ["**Test count unavailable.** The partial result does not establish how many tests executed.", ""]
    else:
        lines += ["Test result summary unavailable. This is **not a passing test result**; inspect command events and raw logs.", ""]
    if failures:
        lines += ["| Failed test | Last observed UI phase | Result-bundle failure |", "| --- | --- | --- |"]
        for failure in failures.values():
            phase = failure["lastPhase"]
            label = f"{phase['phase']} ({phase['status']})" if phase else "No UI phase evidence"
            lines.append(f"| {markdown(failure['target'] + '/' + failure['test'])} | {markdown(label)} | "
                         f"{markdown('; '.join(failure['messages']))[:1200]} |")
        lines += ["", "Phases are progress evidence, not automatic root-cause classifications. Multiple assertions may belong to one failed test.", ""]
    if malformed_failures or malformed_commands:
        lines += [f"Skipped malformed evidence records: {malformed_failures} test failures; "
                  f"{malformed_commands} command events. Inspect the raw files.", ""]
    if commands:
        lines += ["Command/collector issues (the original validation exit code is preserved):", ""]
        lines += [f"- `{markdown(event['phase'])}`: {markdown(event['status'])}, exit {markdown(event.get('exitCode', 'unknown'))}"
                  for event in commands]
        lines.append("")
    run_id, attempt = os.environ.get("GITHUB_RUN_ID"), os.environ.get("GITHUB_RUN_ATTEMPT")
    if run_id and attempt:
        artifact = f"ios-xcode-{os.environ.get('NOSTALGIFY_XCODE_VERSION', 'unknown')}-{run_id}-{attempt}"
        lines += [f"Download `{markdown(artifact)}` from this run's artifacts for `.xcresult`, logs, phases, and attachments.", ""]
    output = "\n".join(lines)
    atomic_write(directory / "validation-summary.md", output)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(output + "\n")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["run", "refuse", "manifest", "summarize"])
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--phase")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--exit-code", type=int, default=0)
    arguments, command = parser.parse_known_args()
    if command[:1] == ["--"]:
        command.pop(0)
    if arguments.action == "run":
        if not command or not arguments.phase or not math.isfinite(arguments.timeout) or arguments.timeout <= 0:
            parser.error("run requires --phase, a positive --timeout, and -- command")
        return run_command(arguments.output, arguments.phase, arguments.timeout, command)
    if command:
        parser.error("unexpected arguments")
    if arguments.action == "refuse":
        if not arguments.phase:
            parser.error("refuse requires --phase")
        return refuse_command(arguments.output, arguments.phase)
    if arguments.action == "manifest":
        write_manifest(arguments.output)
    else:
        summarize(arguments.output, arguments.exit_code)
    return 0


if __name__ == "__main__":
    sys.exit(main())
