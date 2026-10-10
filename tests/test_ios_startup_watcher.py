"""Portable regressions for failures observed in iPad simulator diagnostics."""

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts/capture-ios-startup-stall.py"
SPEC = importlib.util.spec_from_file_location("startup_watcher", SCRIPT)
watcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watcher)
SIMULATOR = "11111111-1111-1111-1111-111111111111"
FIXTURE = "22222222-2222-2222-2222-222222222222"
LAUNCH = "33333333-3333-3333-3333-333333333333"
WALL_TIME = 1_700_000_000


class StartupWatcherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        watcher.stopping = False

    def write_probe(self, directory, *, age=3, **changes):
        directory.mkdir(parents=True, exist_ok=True)
        data = {"version": 1, "phase": "requested", "appProcessID": 17731,
                "isLoading": True, "fixtureID": FIXTURE, "launchID": LAUNCH}
        data.update(changes)
        requested = directory / f"{FIXTURE}-{LAUNCH}-requested.json"
        requested.write_text(json.dumps(data))
        os.utime(requested, (WALL_TIME - age, WALL_TIME - age))
        return data

    def test_timeout_preserves_bounded_partial_output_and_reaps_child(self):
        # Exercise a real timeout after both streams have emitted diagnostics.
        # The previous handler discarded these bytes and left empty artifacts.
        child = """
import os, sys, time
os.write(1, b'x' * 70_000 + b'\\xffsampling\\n')
print('report processing', file=sys.stderr, flush=True)
print(os.getpid(), flush=True)
time.sleep(10)
"""
        output, status = watcher.command([sys.executable, "-u", "-c", child], timeout=1)
        self.assertEqual(status, "timed-out")
        self.assertEqual(len(output), watcher.TIMEOUT_OUTPUT_LIMIT)
        self.assertIn("\ufffdsampling\nreport processing\n", output)
        pid = int(output.splitlines()[-1])
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_quiet_timeout_preserves_status_without_inventing_output(self):
        output, status = watcher.command(
            [sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.1)
        self.assertEqual((output, status), ("", "timed-out"))

    def test_command_completion_and_failure_keep_output_and_status(self):
        for code, status in [(0, "completed"), (17, "command-failed")]:
            with self.subTest(code=code):
                output, actual = watcher.command([
                    sys.executable, "-c", f"import sys; print('report phase'); sys.exit({code})"])
                self.assertEqual((output, actual), ("report phase\n", status))

    def test_sample_records_partial_report_and_separate_command_budget(self):
        executable = f"/Library/Developer/CoreSimulator/Devices/{SIMULATOR}/data/Containers/Bundle/Application/AA/App.app/App"
        calls = []

        def run(arguments, timeout=5):
            calls.append((arguments, timeout))
            if arguments[0] == "/bin/ps":
                return executable, "completed"
            if arguments[0] == "xcrun":
                return "", "timed-out"
            self.assertEqual(arguments[:4], ["/usr/bin/sample", "17731", "1", "-file"])
            pathlib.Path(arguments[4]).write_text("partial stack report\n")
            return "report processing\n", "timed-out"

        with patch.object(watcher, "command", side_effect=run), \
                patch.object(watcher.time, "monotonic", side_effect=[10, 30]):
            result = watcher.sample_process(17731, "app", SIMULATOR, self.root)
            watcher.current_probe_directory(SIMULATOR)
        self.assertEqual(result["status"], "timed-out")
        self.assertEqual(result["elapsedSeconds"], 20)
        self.assertEqual(result["reportBytes"], len(b"partial stack report\n"))
        self.assertEqual([timeout for _, timeout in calls], [2, 20, 5])
        self.assertEqual((self.root / "startup-sample-app-command.log").read_text(), "report processing\n")

    def test_discovers_replaced_data_container_after_xctest_installation(self):
        containers = self.root / f"CoreSimulator/Devices/{SIMULATOR}/data/Containers/Data/Application"
        old = containers / "44444444-4444-4444-4444-444444444444"
        new = containers / "55555555-5555-5555-5555-555555555555"
        old.mkdir(parents=True)
        self.write_probe(new / "Documents/UITestStartupDiagnostics")
        seconds, lookups = [0], []
        clock = types.SimpleNamespace(monotonic=lambda: seconds[0], time=lambda: WALL_TIME,
                                      sleep=lambda value: seconds.__setitem__(0, seconds[0] + value))

        def lookup(arguments, timeout=5):
            self.assertEqual(arguments, ["xcrun", "simctl", "get_app_container",
                                         SIMULATOR, "dev.nostalgify.ipad", "data"])
            lookups.append(seconds[0])
            return str(old if len(lookups) == 1 else new), "completed"

        def capture(data, age, simulator, output):
            self.assertEqual(data["launchID"], LAUNCH)
            watcher.stopping = True
            return {"diagnosticOnly": True, "status": "stall-observed"}

        executable = f"/Library/Developer/CoreSimulator/Devices/{SIMULATOR}/data/Containers/Bundle/Application/AA/App.app/App"
        arguments = [str(SCRIPT), SIMULATOR, str(old / "Documents/UITestStartupDiagnostics"), str(self.root)]
        with patch.object(watcher, "command", side_effect=lookup), \
                patch.object(watcher, "time", clock), patch.object(watcher.signal, "signal"), \
                patch.object(watcher.sys, "argv", arguments), \
                patch.object(watcher, "executable", return_value=executable), \
                patch.object(watcher, "capture", side_effect=capture) as sampled:
            watcher.main()
        result = json.loads((self.root / "startup-sample.json").read_text())
        self.assertEqual(lookups, [0, 15])
        sampled.assert_called_once()
        self.assertEqual(result["discovery"]["containerChanges"], 1)
        self.assertEqual(result["discovery"]["requestedProbesObserved"], 1)
        self.assertEqual(result["status"], "stall-observed")

    def test_rejects_wrong_simulator_container_and_failed_lookup(self):
        wrong = "/Library/Developer/CoreSimulator/Devices/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/data/Containers/Data/Application/55555555-5555-5555-5555-555555555555"
        for output, status in [(wrong, "completed"), ("/tmp/55555555-5555-5555-5555-555555555555", "completed"), ("", "timed-out")]:
            with self.subTest(output=output, status=status), patch.object(watcher, "command", return_value=(output, status)):
                self.assertIsNone(watcher.current_probe_directory(SIMULATOR)[0])

    def test_loading_probe_filters_preserve_blank_completion_but_skip_ready(self):
        data = self.write_probe(self.root)
        completed = self.root / f"{FIXTURE}-{LAUNCH}-completed.json"
        with patch.object(watcher.time, "time", return_value=WALL_TIME):
            self.assertEqual(len(list(watcher.pending_probes(self.root))), 1)
            data.update(phase="completed", hasSettings=False, hasCapacitor=False, playerReady=False)
            completed.write_text(json.dumps(data))
            self.assertEqual(list(watcher.pending_probes(self.root))[0][0]["trigger"], "loading-document-not-ready")
            data.update(appProcessID=99999)
            completed.write_text(json.dumps(data))
            self.assertEqual(list(watcher.pending_probes(self.root)), [])
            data.update(appProcessID=17731, isLoading=False, hasSettings=True, hasCapacitor=True, playerReady=True)
            completed.write_text(json.dumps(data))
            self.assertEqual(list(watcher.pending_probes(self.root)), [])
            completed.unlink()
            for changes in [{"isLoading": False}, {"appProcessID": True}, {"age": 1}, {"age": 46}]:
                with self.subTest(changes=changes):
                    self.write_probe(self.root, **changes)
                    self.assertEqual(list(watcher.pending_probes(self.root)), [])

    def test_webcontent_mapping_requires_unique_launch_from_selected_app(self):
        event = "2026-10-09 22:49:48.401 Df App[33535:1736f] [com.apple.WebKit:Process] 0x11711c0c0 - [PID=33673] WebProcessProxy::didFinishLaunching:"
        self.assertEqual(watcher.webcontent_pid(event, 33535), 33673)
        self.assertIsNone(watcher.webcontent_pid(event, 17731))
        self.assertIsNone(watcher.webcontent_pid(event.replace("WebProcessProxy", "GPUProcessProxy"), 33535))
        self.assertIsNone(watcher.webcontent_pid(event + "\n" + event.replace("PID=33673", "PID=33674"), 33535))

    def test_executable_identity_accepts_observed_extensionkit_layout_only(self):
        runtime = "/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot"
        self.assertTrue(watcher.webcontent_identity(runtime + "/System/Library/ExtensionKit/Extensions/WebContentExtension.appex/com.apple.WebKit.WebContent"))
        self.assertFalse(watcher.webcontent_identity("/tmp/com.apple.WebKit.WebContent"))
        self.assertFalse(watcher.app_identity("/tmp/App.app/App", SIMULATOR))


if __name__ == "__main__":
    unittest.main()
