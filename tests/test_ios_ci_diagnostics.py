"""Regressions for native CI verdict preservation and evidence collection."""

import importlib.util
import hashlib
import io
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts/ios-ci-diagnostics.py"
SPEC = importlib.util.spec_from_file_location("ios_ci_diagnostics", SCRIPT)
diagnostics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diagnostics)


class NativeCIDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)

    def events(self):
        return [json.loads(line) for line in (self.root / "command-events.jsonl").read_text().splitlines()]

    def assert_process_stopped(self, pid):
        # An orphan zombie can remain until init reaps it, but cannot hold pipes.
        result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="],
                                capture_output=True, text=True, timeout=2)
        self.assertIn(result.returncode, (0, 1), result.stderr)
        status = result.stdout.strip()
        self.assertTrue(not status or status.startswith("Z"), status)

    def cleanup_supervisor(self, wrapper, group_file):
        # The wrapper gives its command a separate session. Kill both owned
        # groups on an assertion/timeout so a broken implementation cannot leak.
        if group_file.exists():
            try:
                os.killpg(int(group_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
        if wrapper.poll() is None:
            os.killpg(wrapper.pid, signal.SIGKILL)
        wrapper.communicate(timeout=3)

    def supervised(self, command, group_file):
        wrapper = subprocess.Popen(command, start_new_session=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(self.cleanup_supervisor, wrapper, group_file)
        return wrapper

    def test_command_preserves_exit_code_and_does_not_log_arguments(self):
        result = diagnostics.run_command(self.root, "test-command", 5,
                                         [sys.executable, "-c", "raise SystemExit(17)", "secret-value"])
        self.assertEqual(result, 17)
        self.assertEqual([event["status"] for event in self.events()], ["started", "command-failed"])
        self.assertEqual(self.events()[-1]["exitCode"], 17)
        self.assertNotIn("secret-value", (self.root / "command-events.jsonl").read_text())

    def test_timeout_kills_command_and_descendant_that_ignore_termination(self):
        pid_file = self.root / "child.pid"
        group_file = self.root / "group.pid"
        child = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
        parent = """
import os, pathlib, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path(sys.argv[3]).write_text(str(os.getpid()))
child = subprocess.Popen([sys.executable, '-c', sys.argv[2]])
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
time.sleep(60)
"""
        started = time.monotonic()
        wrapper = self.supervised([sys.executable, "-B", str(SCRIPT), "run", "--output", str(self.root),
                                   "--phase", "blocked", "--timeout", "2", "--",
                                   sys.executable, "-c", parent, str(pid_file), child, str(group_file)], group_file)
        output, _ = wrapper.communicate(timeout=8)
        self.assertEqual(wrapper.returncode, 124, output)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(self.events()[-1]["status"], "timed-out")
        self.assert_process_stopped(int(pid_file.read_text()))
        self.assert_process_stopped(int(group_file.read_text()))

    def test_cancellation_flushes_terminal_event_and_reaps_command(self):
        pid_file = self.root / "command.pid"
        child = "import os, pathlib, sys, time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)"
        wrapper = self.supervised([sys.executable, "-B", str(SCRIPT), "run", "--output", str(self.root),
                                    "--phase", "stream", "--timeout", "20", "--",
                                    sys.executable, "-c", child, str(pid_file)], pid_file)
        deadline = time.monotonic() + 5
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(pid_file.exists())
        wrapper.send_signal(signal.SIGTERM)
        output, _ = wrapper.communicate(timeout=5)
        self.assertEqual(wrapper.returncode, 143, output)
        self.assertEqual(self.events()[-1]["status"], "cancelled")
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid_file.read_text()), 0)

    def test_signal_inside_popen_wait_lock_cannot_reenter_wait(self):
        group_file = self.root / "group.pid"
        # Inject at the real _try_wait call made while CPython holds its
        # non-reentrant _waitpid_lock, not at a timing-dependent sleep.
        supervisor_code = """
import importlib.util, os, pathlib, signal, subprocess, sys, time
spec = importlib.util.spec_from_file_location('diagnostics', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ready = pathlib.Path(sys.argv[3])
original = subprocess.Popen._try_wait
sent = False
def inject(process, wait_flags):
    global sent
    if not sent:
        sent = True
        deadline = time.monotonic() + 2
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(.005)
        if not ready.exists():
            raise RuntimeError('command did not become ready')
        os.kill(os.getpid(), signal.SIGTERM)
        os.kill(os.getpid(), signal.SIGINT)
    return original(process, wait_flags)
subprocess.Popen._try_wait = inject
child = ('import os,pathlib,signal,sys,time;'
         'signal.signal(signal.SIGTERM,signal.SIG_IGN);'
         'pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(20)')
sys.exit(module.run_command(pathlib.Path(sys.argv[2]), 'reentrant-cancel', 10,
                           [sys.executable, '-c', child, str(ready)]))
"""
        wrapper = self.supervised([sys.executable, "-B", "-c", supervisor_code,
                                   str(SCRIPT), str(self.root), str(group_file)], group_file)
        output, _ = wrapper.communicate(timeout=6)
        self.assertEqual(wrapper.returncode, 143, output)
        event = self.events()[-1]
        self.assertEqual(event["status"], "cancelled")
        self.assertEqual(event["processGroupCleanup"]["status"], "killed")
        self.assertTrue(event["processGroupCleanup"]["leaderReaped"])
        self.assert_process_stopped(int(group_file.read_text()))

    def test_leader_exit_releases_pipe_holding_descendant_and_preserves_exit(self):
        group_file, child_file = self.root / "group.pid", self.root / "child.pid"
        child = ("import os,pathlib,signal,sys,time;"
                 "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                 "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(20)")
        parent = """
import os, pathlib, subprocess, sys, time
pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))
subprocess.Popen([sys.executable, '-c', sys.argv[3], sys.argv[2]])
deadline = time.monotonic() + 2
while not pathlib.Path(sys.argv[2]).exists() and time.monotonic() < deadline:
    time.sleep(.005)
if not pathlib.Path(sys.argv[2]).exists():
    raise RuntimeError('descendant did not become ready')
raise SystemExit(17)
"""
        wrapper = self.supervised([sys.executable, "-B", str(SCRIPT), "run", "--output", str(self.root),
                                   "--phase", "pipe-holder", "--timeout", "4", "--", sys.executable,
                                   "-c", parent, str(group_file), str(child_file), child], group_file)
        # communicate waits for EOF, including descriptors inherited by children.
        output, _ = wrapper.communicate(timeout=6)
        self.assertEqual(wrapper.returncode, 17, output)
        event = self.events()[-1]
        self.assertEqual(event["status"], "command-failed")
        self.assertTrue(event["processGroupCleanup"]["afterLeaderExit"])
        self.assertTrue(event["processGroupCleanup"]["leaderReaped"])
        self.assert_process_stopped(int(child_file.read_text()))

    def test_missing_command_reports_unavailable_and_exit_127(self):
        result = diagnostics.run_command(self.root, "missing", 1, [str(self.root / "absent-command")])
        self.assertEqual(result, 127)
        self.assertEqual(self.events()[-1]["status"], "unavailable")
        self.assertEqual(self.events()[0]["commandId"], self.events()[-1]["commandId"])

    def test_evidence_write_error_does_not_replace_command_exit(self):
        destination = self.root / "not-a-directory"
        destination.write_text("existing file")
        with patch("sys.stderr", new_callable=io.StringIO) as stderr:
            result = diagnostics.run_command(destination, "write-error", 2,
                                             [sys.executable, "-c", "raise SystemExit(17)"])
        self.assertEqual(result, 17)
        self.assertIn("Command event unavailable", stderr.getvalue())
        self.assertEqual(destination.read_text(), "existing file")

    def test_budget_refusal_is_recorded_without_starting_a_command(self):
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "refuse", "--output", str(self.root),
                                 "--phase", "attachments"], capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertEqual(len(self.events()), 1)
        self.assertEqual(self.events()[0]["status"], "budget-exhausted")
        self.assertEqual(self.events()[0]["exitCode"], 124)

    def test_nonfinite_timeout_is_rejected_before_command_launch(self):
        for timeout in ["nan", "inf", "-inf"]:
            with self.subTest(timeout=timeout):
                result = subprocess.run([sys.executable, "-B", str(SCRIPT), "run", "--output", str(self.root),
                                         "--phase", "invalid-timeout", "--timeout=" + timeout, "--",
                                         sys.executable, "-c", "raise SystemExit(19)"],
                                        capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse((self.root / "command-events.jsonl").exists())

    def test_summary_deduplicates_assertions_and_preserves_unfinished_launch(self):
        identity = "AppUITests/testLaunch()"
        (self.root / "test-summary.json").write_text(json.dumps({
            "totalTestCount": 2, "passedTests": 1, "failedTests": 1, "skippedTests": 0,
            "testFailures": [{"targetName": "AppUITests", "testIdentifierString": identity,
                              "failureText": text} for text in ["Launch timed out", "Missing view"]]}))
        events = [
            {"phaseId": "launch", "phase": "app.launch", "status": "started"},
            {"phaseId": "teardown", "phase": "teardown", "status": "started"},
            {"phaseId": "teardown", "phase": "teardown", "status": "finished"},
        ]
        (self.root / "tests.log").write_text("NOSTALGIFY_TEST_PHASE malformed\n" + "\n".join(
            "timestamp NOSTALGIFY_TEST_PHASE " + json.dumps({"testId": "-[AppUITests.AppUITests testLaunch]",
                                                            "fixtureId": "fixture", **event}) for event in events))
        with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(self.root / "github.md")}):
            result = diagnostics.summarize(self.root, 65)
        self.assertEqual(result["validationExitCode"], 65)
        self.assertEqual(len(result["failedTests"]), 1)
        self.assertEqual(result["failedTests"][0]["lastPhase"], {"phase": "app.launch", "status": "unfinished"})
        self.assertEqual(len(result["failedTests"][0]["messages"]), 2)
        self.assertIn("1 failed", (self.root / "github.md").read_text())

    def test_partial_result_and_failed_collector_cannot_create_success(self):
        (self.root / "test-summary.json").write_text('{"partial":')
        diagnostics.append_event(self.root, {"phase": "attachment-export", "status": "timed-out", "exitCode": 124})
        with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}):
            result = diagnostics.summarize(self.root, 65)
        self.assertFalse(result["resultAvailable"])
        self.assertEqual(result["validationExitCode"], 65)
        self.assertEqual(result["commandIssues"][0]["phase"], "attachment-export")
        self.assertIn("not a passing test result", (self.root / "validation-summary.md").read_text())

    def test_malformed_failure_records_preserve_valid_neighbors_and_unknown_counts(self):
        valid = {"targetName": "AppUITests", "testIdentifierString": "AppUITests/testLaunch()",
                 "failureText": "Launch failed"}
        for records, malformed in [(None, 1), (17, 1), ({"unexpected": "object"}, 1),
                                   ([None, 1, {**valid, "failureText": []}, valid], 3)]:
            with self.subTest(records=records):
                (self.root / "test-summary.json").write_text(json.dumps({
                    "totalTestCount": False, "passedTests": -1, "failedTests": "1", "skippedTests": 0,
                    "testFailures": records}))
                with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}):
                    result = diagnostics.summarize(self.root, 65)
                self.assertEqual(result["validationExitCode"], 65)
                self.assertEqual(result["malformedRecords"]["testFailures"], malformed)
                self.assertEqual(result["counts"], {"totalTestCount": None, "passedTests": None,
                                                    "failedTests": None, "skippedTests": 0})
                expected = ["AppUITests/testLaunch()"] if isinstance(records, list) else []
                self.assertEqual([failure["test"] for failure in result["failedTests"]], expected)
                markdown = (self.root / "validation-summary.md").read_text()
                self.assertIn("Test count unavailable", markdown)
                self.assertNotIn("No tests executed", markdown)

    def test_partial_command_records_preserve_issues_and_distinguish_command_instances(self):
        records = [None, [], {"status": "timed-out", "exitCode": 124},
                   {"phase": "repeat", "commandId": "first", "status": "started"},
                   {"phase": "repeat", "commandId": "second", "status": "started"},
                   {"phase": "repeat", "commandId": "second", "status": "completed", "exitCode": 0},
                   {"phase": "export", "status": "timed-out", "exitCode": 124},
                   {"phase": "app-log-stream", "status": "cancelled", "exitCode": 143},
                   {"phase": "startup-watcher", "status": "cancelled", "exitCode": 143},
                   {"phase": "initial-summary", "status": "started"},
                   {"phase": "final-summary", "status": "started"},
                   {"phase": "cleanup", "status": "completed", "exitCode": 0,
                    "processGroupCleanup": {"status": "reap-timed-out", "leaderReaped": False}}]
        (self.root / "command-events.jsonl").write_text("\n".join(map(json.dumps, records)) + '\n{"phase":')
        with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}):
            result = diagnostics.summarize(self.root, 65)
        self.assertEqual(result["malformedRecords"]["commandEvents"], 4)
        self.assertEqual([(event["phase"], event["status"]) for event in result["commandIssues"]],
                         [("export", "timed-out"), ("cleanup", "group-cleanup-incomplete"),
                          ("repeat", "unfinished")])
        self.assertEqual(result["commandIssues"][-1]["commandId"], "first")
        self.assertTrue((self.root / "validation-summary.json").is_file())
        self.assertIn("Skipped malformed evidence records", (self.root / "validation-summary.md").read_text())

    def test_failed_summary_replacement_keeps_previous_artifact(self):
        destination = self.root / "validation-summary.md"
        destination.write_text("prior summary")
        with patch.object(pathlib.Path, "replace", side_effect=OSError("replacement interrupted")):
            with self.assertRaises(OSError):
                diagnostics.atomic_write(destination, "new summary")
        self.assertEqual(destination.read_text(), "prior summary")
        self.assertEqual(list(self.root.iterdir()), [destination])

    def test_manifest_fingerprints_allowlisted_harness_even_when_untracked(self):
        names = ["scripts/ios-ci-diagnostics.py", "scripts/ios-ci-harness.sh",
                 "scripts/check-ios-simulator.sh", ".github/workflows/ci.yml"]
        for name in names:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture " + name)
        output = self.root / "artifacts"
        previous = pathlib.Path.cwd()
        try:
            os.chdir(self.root)
            with patch.object(diagnostics, "command_text", return_value=""), patch.dict(
                    os.environ, {"SECRET_NOT_ALLOWED": "sensitive-value"}):
                diagnostics.write_manifest(output)
        finally:
            os.chdir(previous)
        text = (output / "run-manifest.json").read_text()
        manifest = json.loads(text)
        self.assertEqual(manifest["harnessSHA256"], {
            name: hashlib.sha256(("fixture " + name).encode()).hexdigest() for name in names})
        self.assertFalse(manifest["trackedWorkingTreeDirty"])
        self.assertNotIn("sensitive-value", text)

    def test_thrown_action_is_not_hidden_by_successful_teardown(self):
        events = [("speech", "voiceover.currentSpeech", "started"),
                  ("speech", "voiceover.currentSpeech", "threw"),
                  ("cleanup", "teardown", "started"),
                  ("terminate", "app.terminate", "started"),
                  ("terminate", "app.terminate", "finished"),
                  ("cleanup", "teardown", "finished")]
        log = self.root / "tests.log"
        log.write_text("\n".join("NOSTALGIFY_TEST_PHASE " + json.dumps({
            "testId": "-[AppUITests testVoiceOver]", "fixtureId": "fixture",
            "phaseId": identity, "phase": phase, "status": status}) for identity, phase, status in events))
        self.assertEqual(diagnostics.phase_evidence(log)["AppUITests/testVoiceOver()"],
                         {"phase": "voiceover.currentSpeech", "status": "threw"})

    def test_teardown_only_hang_is_identified_and_normal_stream_stop_is_not_an_issue(self):
        log = self.root / "tests.log"
        log.write_text("\n".join("NOSTALGIFY_TEST_PHASE " + json.dumps({
            "testId": "-[AppUITests testRecovery]", "fixtureId": "fixture",
            "phaseId": phase, "phase": phase, "status": "started"})
            for phase in ["teardown", "app.terminate"]))
        self.assertEqual(diagnostics.phase_evidence(log)["AppUITests/testRecovery()"],
                         {"phase": "app.terminate", "status": "unfinished"})
        diagnostics.append_event(self.root, {"phase": "app-log-stream", "status": "cancelled", "exitCode": 143})
        (self.root / "test-summary.json").write_text(json.dumps({"totalTestCount": 0, "failedTests": 0}))
        with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}):
            result = diagnostics.summarize(self.root, 65)
        self.assertEqual(result["commandIssues"], [])
        self.assertIn("No tests executed", (self.root / "validation-summary.md").read_text())

    def test_cleanup_exception_does_not_replace_an_unfinished_action(self):
        log = self.root / "tests.log"
        events = [("launch", "app.launch", "started"),
                  ("cleanup", "teardown", "started"),
                  ("capture", "failure.capture", "started"),
                  ("capture", "failure.capture", "threw"),
                  ("cleanup", "teardown", "threw")]
        log.write_text("\n".join("NOSTALGIFY_TEST_PHASE " + json.dumps({
            "testId": "-[AppUITests testLaunch]", "fixtureId": "fixture", "phaseId": identity,
            "phase": phase, "status": status}) for identity, phase, status in events))
        self.assertEqual(diagnostics.phase_evidence(log)["AppUITests/testLaunch()"],
                         {"phase": "app.launch", "status": "unfinished"})


if __name__ == "__main__":
    unittest.main()
