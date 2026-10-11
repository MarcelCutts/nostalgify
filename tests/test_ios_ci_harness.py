"""Portable integration coverage for the outer iOS validation shell."""

import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
LIBRARY = ROOT / "scripts/ios-ci-harness.sh"
SHELL_SETUP = r"""
set -euo pipefail
source "$1"
TEST_PYTHON=$2
shift 2
NOSTALGIFY_COMMAND_DEADLINE=$((SECONDS + 20))
NOSTALGIFY_ACTIVE_COMMAND_ID=''
trap 'cancel_validation 143 TERM' TERM
trap 'cancel_validation 130 INT' INT
"""


class IOSCIHarnessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.environment = {**os.environ, "NOSTALGIFY_IOS_RESULTS": str(self.directory)}

    def events(self, phase, directory=None):
        path = (directory or self.directory) / "command-events.jsonl"
        self.assertTrue(path.exists(), "The command must leave structured evidence")
        return [event for line in path.read_text().splitlines()
                if (event := json.loads(line))["phase"] == phase]

    def shell(self, body, *arguments):
        return subprocess.Popen(
            ["/bin/bash", "-c", SHELL_SETUP + body, "ios-harness-test",
             str(LIBRARY), sys.executable, *map(str, arguments)],
            cwd=ROOT, env=self.environment, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True)

    def run_shell(self, body, *arguments):
        process = self.shell(body, *arguments)
        try:
            stdout, stderr = process.communicate(timeout=10)
            return process.returncode, stdout, stderr
        finally:
            self.stop_shell(process)

    def stop_shell(self, process):
        # This group contains only this test's outer Bash and its wrapper.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate(timeout=5)

    def process_is_running(self, pid):
        # A killed pipeline descendant may briefly await reaping. Zombies have
        # stopped executing and must not be mistaken for a surviving command.
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "stat="],
            capture_output=True, text=True, timeout=5)
        self.assertIn(result.returncode, (0, 1), result.stderr)
        self.assertFalse(result.stderr.strip(), result.stderr)
        state = result.stdout.strip()
        return bool(state) and not state.startswith("Z")

    def assert_outer_cancellation(self, signum, *, logged):
        phase = "logged-cancel" if logged else "command-cancel"
        pid_file = self.directory / "owned-command.pid"
        dummy = self.directory / "finite-command.py"
        dummy.write_text("""
import os
import pathlib
import signal
import sys
import time

# Exercise the supervisor's escalation, with a finite lifetime even on failure.
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
ready = pathlib.Path(sys.argv[1])
pending = ready.with_suffix('.pending')
pending.write_text(str(os.getpid()))
pending.replace(ready)
print('owned command ready', flush=True)
time.sleep(20)
""")
        invocation = ('bounded_logged_command "$1" 15 "$NOSTALGIFY_IOS_RESULTS/command.log" '
                      if logged else 'bounded_command "$1" 15 ')
        body = invocation + '"$TEST_PYTHON" "$2" "$3"\n'
        process = self.shell(body, phase, dummy, pid_file)
        pid = None
        try:
            deadline = time.monotonic() + 5
            while not pid_file.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(pid_file.exists(), "The owned command did not become ready")
            pid = int(pid_file.read_text())
            self.assertTrue(self.process_is_running(pid))
            started = time.monotonic()
            # Signal only the entry shell: directly signaling its Python wrapper
            # would miss Bash's deferred foreground-command trap regression.
            os.kill(process.pid, signum)
            stdout, stderr = process.communicate(timeout=5)
            self.assertLess(time.monotonic() - started, 5)
            self.assertEqual(process.returncode, 128 + signum, stdout + stderr)
            terminal = [event for event in self.events(phase) if event["status"] != "started"]
            self.assertEqual(len(terminal), 1, terminal)
            self.assertEqual(terminal[0]["status"], "cancelled")
            self.assertEqual(terminal[0]["exitCode"], 128 + signum)
            deadline = time.monotonic() + 2
            while self.process_is_running(pid) and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertFalse(self.process_is_running(pid), "Cancellation left its command running")
            if logged:
                self.assertIn("owned command ready", (self.directory / "command.log").read_text())
        finally:
            # The command owns a separate session; clean it independently if an
            # assertion exposes a regression in cancellation or process reaping.
            if pid is not None:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.stop_shell(process)

    def test_outer_term_cancels_bounded_command(self):
        self.assert_outer_cancellation(signal.SIGTERM, logged=False)

    def test_outer_int_cancels_bounded_command(self):
        self.assert_outer_cancellation(signal.SIGINT, logged=False)

    def test_outer_term_cancels_logged_command(self):
        self.assert_outer_cancellation(signal.SIGTERM, logged=True)

    def test_outer_int_cancels_logged_command(self):
        self.assert_outer_cancellation(signal.SIGINT, logged=True)

    def test_logged_command_preserves_upstream_failure_and_output(self):
        status, stdout, stderr = self.run_shell(r"""
bounded_logged_command build 5 "$NOSTALGIFY_IOS_RESULTS/build.log" \
  "$TEST_PYTHON" -c 'import sys; print("build detail", flush=True); print("compiler failure", file=sys.stderr); sys.exit(17)'
""")
        self.assertEqual(status, 17, stdout + stderr)
        self.assertIn("build detail", stdout)
        self.assertIn("compiler failure", stdout)
        self.assertEqual((self.directory / "build.log").read_text(), stdout)
        terminal = self.events("build")[-1]
        self.assertEqual((terminal["status"], terminal["exitCode"]), ("command-failed", 17))

    def test_bounded_command_preserves_heredoc_standard_input(self):
        status, stdout, stderr = self.run_shell(r"""
bounded_command warning-collector 5 "$TEST_PYTHON" - "$NOSTALGIFY_IOS_RESULTS/collected" <<'PY'
import pathlib
import sys
pathlib.Path(sys.argv[1]).write_text('collector executed')
print('collector output')
PY
""")
        self.assertEqual(status, 0, stdout + stderr)
        self.assertEqual(stdout, "collector output\n")
        self.assertEqual((self.directory / "collected").read_text(), "collector executed")
        terminal = self.events("warning-collector")[-1]
        self.assertEqual((terminal["status"], terminal["exitCode"]), ("completed", 0))

    def test_optional_capture_timeout_preserves_event_and_required_verdict(self):
        status, stdout, stderr = self.run_shell(r"""
best_effort_command preflight-screenshot 1 "$TEST_PYTHON" -c 'import time; time.sleep(20)'
bounded_command tests 5 "$TEST_PYTHON" -c 'import sys; print("required tests ran"); sys.exit(17)'
""")
        self.assertEqual(status, 17, stdout + stderr)
        self.assertIn("required tests ran", stdout)
        self.assertIn("preflight-screenshot diagnostic collection failed (exit 124)", stderr)
        terminal = self.events("preflight-screenshot")[-1]
        self.assertEqual((terminal["status"], terminal["exitCode"]), ("timed-out", 124))
        self.assertTrue(terminal["processGroupCleanup"]["leaderReaped"])
        self.assertEqual(self.events("tests")[-1]["exitCode"], 17)

    def run_stubbed_validation(self, *, screenshot_status, test_status=0,
                               selfcheck_passed=True, inventory_status=0):
        repository = self.directory / "validation-repository"
        scripts = repository / "scripts"
        scripts.mkdir(parents=True)
        for name in ("check-ios-simulator.sh", "ios-ci-harness.sh", "ios-ci-diagnostics.py"):
            shutil.copy2(ROOT / "scripts" / name, scripts / name)
        # Startup sampling has its own suite. Keep every native/diagnostic
        # fixture finite even if an entry-script regression bypasses cleanup.
        (scripts / "capture-ios-startup-stall.py").write_text("# No startup probes in this fixture.\n")
        lock = repository / "apps/ipad/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
        lock.parent.mkdir(parents=True)
        lock.write_text('{}\n')
        app_data = self.directory / "app-data"
        documents = app_data / "Documents"
        documents.mkdir(parents=True)
        (documents / "native-selfcheck.json").write_text(json.dumps({
            "passed": selfcheck_passed, "libraryCount": 2,
            "provider": "local", "state": "stopped",
            "checks": ["import", "distinct-identities", "native-queue",
                       "persistence", "webview-bridge"]}))
        binaries = self.directory / "validation-bin"
        binaries.mkdir()
        # Only these portable utilities can reach the host. Every native tool
        # is a local fixture, so the actual entry script cannot launch Xcode.
        for name in ("dirname", "mkdir", "mktemp", "tee", "cp", "cat", "date"):
            executable = shutil.which(name)
            self.assertIsNotNone(executable, name)
            (binaries / name).symlink_to(executable)
        (binaries / "bash").symlink_to("/bin/bash")
        (binaries / "python3").symlink_to(sys.executable)
        stub_source = "#!" + sys.executable + "\n" + r"""
import json
import os
import pathlib
import plistlib
import sys

name, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
root = pathlib.Path(os.environ['HARNESS_STUB_DIRECTORY'])
if name == 'uname':
    print('Darwin')
elif name == 'git':
    if args == ['rev-parse', 'HEAD']:
        print('0' * 40)
elif name in ('node', 'sw_vers', 'uuidgen'):
    print('portable-test-stub')
elif name == 'xcodebuild':
    if args in (['-version'], ['-showsdks']):
        print('portable toolchain inventory')
        raise SystemExit(int(os.environ['HARNESS_INVENTORY_STATUS']))
    elif args == ['-help']:
        print('-collect-test-diagnostics')
    elif args[0] == '-resolvePackageDependencies':
        pass
    elif args[0] == 'build':
        configuration = args[args.index('-configuration') + 1]
        products = pathlib.Path(args[args.index('-derivedDataPath') + 1]) / 'Build/Products'
        app = products / (configuration + ('-iphonesimulator' if configuration == 'Debug' else '-iphoneos')) / 'App.app'
        app.mkdir(parents=True)
        (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'dev.nostalgify.ipad', 'CFBundleExecutable': 'App'}))
        (app / 'App').write_bytes(b'dev.nostalgify.ipad.uitests.' if configuration == 'Debug' else b'release')
    elif args[0] == 'test':
        (root / 'required-tests-ran').touch()
        print('fixture XCTest verdict')
        raise SystemExit(int(os.environ['HARNESS_TEST_STATUS']))
    else:
        raise SystemExit('Unexpected Xcode invocation: ' + repr(args))
elif name == 'xcrun':
    if args == ['--version']:
        print('portable xcrun')
    elif args[:3] == ['simctl', 'list', '--json']:
        runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0'
        print(json.dumps({'runtimes': [{'identifier': runtime, 'version': '27.0', 'isAvailable': True}], 'devices': {runtime: [{'name': 'iPad fixture', 'isAvailable': True, 'deviceTypeIdentifier': 'fixture-ipad'}]}}))
    elif args[:2] == ['simctl', 'create']:
        print('fixture-simulator')
    elif args[:2] == ['simctl', 'get_app_container']:
        print(root / 'app-data')
    elif args[:2] == ['simctl', 'io']:
        raise SystemExit(int(os.environ['HARNESS_SCREENSHOT_STATUS']))
    elif args[:2] == ['simctl', 'launch']:
        # A failed test may request a best-effort comparison, never another test.
        if '--ui-testing' in args:
            raise SystemExit(2)
        print('dev.nostalgify.ipad: 123')
    elif args[:2] in (['simctl', 'boot'], ['simctl', 'bootstatus'],
                      ['simctl', 'install'], ['simctl', 'terminate'],
                      ['simctl', 'shutdown'], ['simctl', 'delete'],
                      ['simctl', 'spawn']):
        pass
    else:
        raise SystemExit('Unexpected simulator invocation: ' + repr(args))
else:
    raise SystemExit('Unexpected tool in portable fixture: ' + name)
"""
        for name in ("uname", "git", "sw_vers", "xcrun", "node", "xcodebuild", "uuidgen"):
            stub = binaries / name
            stub.write_text(stub_source)
            stub.chmod(0o755)
        environment = {**self.environment, "PATH": str(binaries),
                       "HARNESS_STUB_DIRECTORY": str(self.directory),
                       "HARNESS_SCREENSHOT_STATUS": str(screenshot_status),
                       "HARNESS_TEST_STATUS": str(test_status),
                       "HARNESS_INVENTORY_STATUS": str(inventory_status),
                       "NOSTALGIFY_IOS_RUNTIME": "27.0"}
        stdout_path, stderr_path = repository / "entry.stdout", repository / "entry.stderr"
        # Files avoid inherited PIPEs blocking a test after the entry exits.
        with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr:
            process = subprocess.Popen(
                ["/bin/bash", str(scripts / "check-ios-simulator.sh")],
                cwd=repository, env=environment, stdout=stdout, stderr=stderr,
                start_new_session=True)
            try:
                process.wait(timeout=20)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.stop_shell(process)
        result = subprocess.CompletedProcess(process.args, process.returncode,
                                             stdout_path.read_text(), stderr_path.read_text())
        directories = list((repository / "out/ios-ci").glob("run.*"))
        self.assertEqual(len(directories), 1, result.stdout + result.stderr)
        directory = directories[0]
        summary = json.loads((directory / "validation-summary.json").read_text())
        return result, directory, summary

    def test_entry_diagnostic_failures_do_not_prevent_required_tests(self):
        result, directory, summary = self.run_stubbed_validation(
            screenshot_status=17, inventory_status=17)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(summary["validationExitCode"], 0)
        self.assertTrue((self.directory / "required-tests-ran").exists())
        self.assertEqual(self.events("tests", directory)[-1]["exitCode"], 0)
        for phase in ("xcode-version", "sdk-inventory", "preflight-screenshot"):
            self.assertEqual(self.events(phase, directory)[-1]["exitCode"], 17)
            self.assertIn(phase + " diagnostic collection failed (exit 17)", result.stderr)
            self.assertTrue(any(issue["phase"] == phase for issue in summary["commandIssues"]))

    def test_entry_capture_failure_does_not_replace_native_failure(self):
        result, directory, summary = self.run_stubbed_validation(
            screenshot_status=124, test_status=17)
        self.assertEqual(result.returncode, 17, result.stdout + result.stderr)
        self.assertEqual(summary["validationExitCode"], 17)
        self.assertTrue((self.directory / "required-tests-ran").exists())
        self.assertEqual(self.events("tests", directory)[-1]["exitCode"], 17)
        self.assertEqual(self.events("preflight-screenshot", directory)[-1]["exitCode"], 124)

    def test_entry_failed_selfcheck_still_prevents_tests_and_optional_capture(self):
        result, directory, summary = self.run_stubbed_validation(
            screenshot_status=17, selfcheck_passed=False)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(summary["validationExitCode"], 1)
        self.assertIn("Native local-file self-check failed", result.stderr)
        self.assertFalse((self.directory / "required-tests-ran").exists())
        self.assertEqual(self.events("preflight-screenshot", directory), [])

    def test_actual_script_entry_term_preserves_cancellation_summary(self):
        repository = self.directory / "fake-repository"
        scripts = repository / "scripts"
        scripts.mkdir(parents=True)
        for name in ("check-ios-simulator.sh", "ios-ci-harness.sh", "ios-ci-diagnostics.py"):
            shutil.copy2(ROOT / "scripts" / name, scripts / name)
        binaries = self.directory / "fake-bin"
        binaries.mkdir()
        # An allowlisted PATH makes accidental fallthrough fail safely. There is
        # no route from this fixture to a real Xcode, simctl, node, or git command.
        for name in ("dirname", "mkdir", "mktemp", "tee"):
            executable = shutil.which(name)
            self.assertIsNotNone(executable, name)
            (binaries / name).symlink_to(executable)
        (binaries / "bash").symlink_to("/bin/bash")
        (binaries / "python3").symlink_to(sys.executable)
        stub_source = "#!" + sys.executable + "\n" + r"""
import os
import pathlib
import signal
import sys
import time

name = pathlib.Path(sys.argv[0]).name
root = pathlib.Path(os.environ['HARNESS_STUB_DIRECTORY'])
if name == 'uname':
    print('Darwin')
elif name == 'git':
    if sys.argv[1:] == ['rev-parse', 'HEAD']:
        print('0' * 40)
elif name in ('sw_vers', 'xcrun', 'node'):
    print('portable test stub')
elif name == 'xcodebuild' and sys.argv[1:] == ['-version']:
    counter = root / 'xcode-version-count'
    count = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(count))
    if count == 1:
        print('Xcode test stub')
    elif count == 2:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        pending = root / 'entry-command.pending'
        pending.write_text(str(os.getpid()))
        pending.replace(root / 'entry-command.pid')
        print('entry command ready', flush=True)
        time.sleep(20)
    else:
        raise SystemExit('Unexpected additional Xcode invocation')
else:
    raise SystemExit('Unexpected native-tool invocation in portable fixture')
"""
        for name in ("uname", "git", "sw_vers", "xcrun", "node", "xcodebuild"):
            stub = binaries / name
            stub.write_text(stub_source)
            stub.chmod(0o755)
        environment = {**self.environment, "PATH": str(binaries),
                       "HARNESS_STUB_DIRECTORY": str(self.directory),
                       "NOSTALGIFY_STRICT_CONCURRENCY": "complete",
                       "GITHUB_STEP_SUMMARY": str(self.directory / "step-summary.md")}
        process = subprocess.Popen(
            ["/bin/bash", str(scripts / "check-ios-simulator.sh")],
            cwd=repository, env=environment, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True)
        pid_file = self.directory / "entry-command.pid"
        pid = None
        try:
            deadline = time.monotonic() + 8
            while not pid_file.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(pid_file.exists(), "The stubbed entry command did not become ready")
            pid = int(pid_file.read_text())
            self.assertTrue(self.process_is_running(pid))
            started = time.monotonic()
            os.kill(process.pid, signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=5)
            self.assertLess(time.monotonic() - started, 5)
            self.assertEqual(process.returncode, 143, stdout + stderr)
            results = list((repository / "out/ios-ci").glob("run.*"))
            self.assertEqual(len(results), 1, results)
            terminal = self.events("xcode-version", results[0])[-1]
            self.assertEqual((terminal["status"], terminal["exitCode"]), ("cancelled", 143))
            summary = json.loads((results[0] / "validation-summary.json").read_text())
            self.assertEqual(summary["validationExitCode"], 143)
            self.assertFalse(self.process_is_running(pid), "Entry cancellation left its command running")
            self.assertEqual((self.directory / "xcode-version-count").read_text(), "2")
        finally:
            if pid is not None:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.stop_shell(process)

    def test_exhausted_budget_records_refused_phase_without_running_command(self):
        status, stdout, stderr = self.run_shell(r"""
NOSTALGIFY_COMMAND_DEADLINE=$SECONDS
bounded_command install 5 "$TEST_PYTHON" -c \
  'import pathlib, sys; pathlib.Path(sys.argv[1]).touch()' "$NOSTALGIFY_IOS_RESULTS/unexpected"
""")
        self.assertEqual(status, 124, stdout + stderr)
        self.assertFalse((self.directory / "unexpected").exists())
        events = self.events("install")
        self.assertEqual(len(events), 1, events)
        self.assertEqual((events[0]["status"], events[0]["exitCode"]), ("budget-exhausted", 124))

    def test_resource_cleanup_remains_available_after_collector_budget_exhaustion(self):
        status, stdout, stderr = self.run_shell(r"""
begin_collection_budget
test "$NOSTALGIFY_CLEANUP_DEADLINE" -gt "$NOSTALGIFY_COMMAND_DEADLINE"
# Advance only the collector deadline; no long real-time sleep is necessary.
NOSTALGIFY_COMMAND_DEADLINE=$SECONDS
collector_status=0
bounded_command optional-collector 5 "$TEST_PYTHON" -c \
  'import pathlib, sys; pathlib.Path(sys.argv[1]).touch()' "$NOSTALGIFY_IOS_RESULTS/unexpected" || collector_status=$?
test "$collector_status" -eq 124
begin_resource_cleanup_budget
bounded_command simulator-shutdown 5 "$TEST_PYTHON" -c \
  'import pathlib, sys; pathlib.Path(sys.argv[1]).touch()' "$NOSTALGIFY_IOS_RESULTS/shutdown"
bounded_command simulator-delete 5 "$TEST_PYTHON" -c \
  'import pathlib, sys; pathlib.Path(sys.argv[1]).touch()' "$NOSTALGIFY_IOS_RESULTS/delete"
""")
        self.assertEqual(status, 0, stdout + stderr)
        self.assertFalse((self.directory / "unexpected").exists())
        collector = self.events("optional-collector")[-1]
        self.assertEqual((collector["status"], collector["exitCode"]), ("budget-exhausted", 124))
        for phase, marker in [("simulator-shutdown", "shutdown"), ("simulator-delete", "delete")]:
            with self.subTest(phase=phase):
                self.assertTrue((self.directory / marker).exists())
                terminal = self.events(phase)[-1]
                self.assertEqual((terminal["status"], terminal["exitCode"]), ("completed", 0))


if __name__ == "__main__":
    unittest.main()
