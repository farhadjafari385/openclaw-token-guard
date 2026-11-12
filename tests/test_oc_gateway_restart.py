"""bin/oc-gateway-restart: an agent's restart waits for running tasks and for a recent start to settle.

2026-11-11: a task restarted the gateway while three other tasks ran (all three were cut), and restarts during a
slow start left agents locked. Runs the real script with fake systemctl/ps/journalctl/sleep/systemd-run on PATH.
"""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "bin" / "oc-gateway-restart"
LOG = 'echo "$(basename "$0") $*" >> "$HOME/calls.log"\n'


class GatewayRestartTest(unittest.TestCase):
    def run_script(self, running=0, age=3600, args=("--run",), max_wait="0"):
        home = Path(tempfile.mkdtemp(prefix="gwr-"))
        state = home / ".openclaw" / "token-guard-state"
        state.mkdir(parents=True)
        jobs = {f"agent:writer:subagent:{i}": {"status": "running"} for i in range(running)}
        (state / "jobs.json").write_text(json.dumps({"jobs": jobs}))
        fake = home / "fakebin"
        fake.mkdir()
        bodies = {
            "systemctl": LOG + '[ "$2" = "show" ] && echo 4242\nexit 0\n',
            "ps": LOG + ('[ "$1" = "-o" ] && echo %s\nexit 0\n' % age),
            "journalctl": LOG + 'echo "http server listening"\n',
            "sleep": LOG,
            "systemd-run": LOG,
        }
        for name, body in bodies.items():
            (fake / name).write_text("#!/bin/bash\n" + body)
            (fake / name).chmod(0o755)
        env = {"HOME": str(home), "PATH": f"{fake}:{os.environ['PATH']}", "OC_RESTART_MAX_WAIT_MIN": max_wait}
        out = subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=60)
        calls = (home / "calls.log").read_text() if (home / "calls.log").exists() else ""
        return out, calls, (state / "maintenance").exists()

    def test_restarts_when_nothing_runs_and_the_start_is_old(self):
        out, calls, flag = self.run_script(running=0, age=3600)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("systemctl --user restart openclaw-gateway.service", calls)
        self.assertFalse(flag, "the flag is cleared once the gateway is back")

    def test_never_cuts_running_tasks(self):
        out, calls, flag = self.run_script(running=2, age=3600)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("running tasks: 2", out.stdout)
        self.assertNotIn("restart openclaw-gateway", calls)
        self.assertFalse(flag)

    def test_lets_a_recent_start_settle(self):
        out, calls, flag = self.run_script(running=0, age=300)
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("restart openclaw-gateway", calls)
        self.assertFalse(flag)

    def test_the_agent_only_schedules_it_outside_the_gateway(self):
        out, calls, _ = self.run_script(args=())
        self.assertEqual(out.returncode, 0)
        self.assertIn("systemd-run --user --quiet --collect --unit=oc-gateway-restart-", calls)
        self.assertIn("--run", calls)
        self.assertNotIn("systemctl --user restart", calls)
        self.assertIn("waits for the running ones to finish", out.stdout)


if __name__ == "__main__":
    unittest.main()
