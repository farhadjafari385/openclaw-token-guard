import os
import subprocess
import sys
import tempfile
import time
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OC_WAIT = os.path.join(REPO, "bin", "oc-wait")


def run(args, timeout=10):
    return subprocess.run(
        [sys.executable, OC_WAIT] + args,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


class TestOcWait(unittest.TestCase):
    def test_command_success(self):
        p = run(["--every", "1", "--timeout", "3", "--", "true"])
        self.assertEqual(p.returncode, 0)
        self.assertIn("succeeded", p.stdout)

    def test_command_timeout(self):
        p = run(["--every", "1", "--timeout", "2", "--", "false"])
        self.assertEqual(p.returncode, 124)
        self.assertIn("timed out", p.stdout)

    def test_pid_mode(self):
        import threading

        proc = subprocess.Popen(["sleep", "1"])
        # Reap the child as soon as it exits. Until a parent calls wait() on
        # an exited child, it stays a zombie and os.kill(pid, 0) still
        # succeeds, which would make oc-wait wait for the full timeout.
        reaper = threading.Thread(target=proc.wait)
        reaper.start()
        p = run(["--pid", str(proc.pid), "--every", "1", "--timeout", "5"])
        reaper.join()
        self.assertEqual(p.returncode, 0)
        self.assertIn("exited", p.stdout)

    def test_pid_already_dead(self):
        proc = subprocess.Popen(["true"])
        proc.wait()
        p = run(["--pid", str(proc.pid), "--every", "1", "--timeout", "5"])
        self.assertEqual(p.returncode, 0)

    def test_file_mode_exists(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "marker")

            def creator():
                time.sleep(1)
                with open(path, "w") as f:
                    f.write("hi")

            import threading

            t = threading.Thread(target=creator)
            t.start()
            p = run(["--file", path, "--every", "1", "--timeout", "5"])
            t.join()
            self.assertEqual(p.returncode, 0)
            self.assertIn("appeared", p.stdout)

    def test_file_mode_with_match(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "marker")
            with open(path, "w") as f:
                f.write("status: pending\n")

            def updater():
                time.sleep(1)
                with open(path, "w") as f:
                    f.write("status: done\n")

            import threading

            t = threading.Thread(target=updater)
            t.start()
            p = run(["--file", path, "--match", r"status:\s*done", "--every", "1", "--timeout", "5"])
            t.join()
            self.assertEqual(p.returncode, 0)
            self.assertIn("matched", p.stdout)

    def test_usage_error_no_target(self):
        p = run([])
        self.assertEqual(p.returncode, 2)

    def test_duration_parsing_variants(self):
        # bare seconds timeout of 1s with a command that always fails -> quick timeout
        start = time.monotonic()
        p = run(["--every", "1s", "--timeout", "1", "--", "false"])
        elapsed = time.monotonic() - start
        self.assertEqual(p.returncode, 124)
        self.assertLess(elapsed, 5)


if __name__ == "__main__":
    unittest.main()
