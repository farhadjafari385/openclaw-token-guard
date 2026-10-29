"""Unit tests for tools/oversized-sessions.py."""
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("oversized", os.path.join(REPO, "tools", "oversized-sessions.py"))
oversized = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oversized)

SESSIONS = [
    {"key": "agent:devops:main", "agentId": "devops", "totalTokens": 868000, "contextTokens": 200000},
    {"key": "agent:qa:main", "agentId": "qa", "totalTokens": 170000, "contextTokens": 200000},
    {"key": "agent:writer:main", "agentId": "writer", "totalTokens": 90000, "contextTokens": 200000},
    {"key": "agent:coordinator:subagent:abc", "totalTokens": 272000, "contextTokens": 1000000},
    {"key": "agent:coordinator:cron:x", "agentId": "coordinator", "totalTokens": 0},
]


class TestSelect(unittest.TestCase):
    def test_threshold_and_order(self):
        rows = oversized.select(SESSIONS, 0.8)
        self.assertEqual([r["key"] for r in rows],
                         ["agent:devops:main", "agent:coordinator:subagent:abc", "agent:qa:main"])

    def test_past_window_only(self):
        rows = oversized.select(SESSIONS, 1.0)
        self.assertEqual([r["key"] for r in rows], ["agent:devops:main", "agent:coordinator:subagent:abc"])

    def test_stale_1m_window_is_capped(self):
        # A session that recorded a 1M window before the cap is judged against the cap.
        row = oversized.select(SESSIONS, 1.0)[1]
        self.assertEqual(row["window"], 200000)
        self.assertEqual(row["agent"], "coordinator")

    def test_agent_from_key(self):
        self.assertEqual(oversized.agent_of("agent:qa:telegram:group:-100:topic:1"), "qa")
        self.assertIsNone(oversized.agent_of("global"))
        self.assertTrue(oversized.is_subagent("agent:a:subagent:x"))


class TestMain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.listing = os.path.join(self.tmp.name, "sessions.json")
        with open(self.listing, "w") as fh:
            fh.write("banner line\n" + json.dumps({"sessions": SESSIONS}))

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = oversized.main(["--oc-home", self.tmp.name, "--from-json", self.listing, *args])
        return code, out.getvalue()

    def test_report_exit_code(self):
        code, out = self.run_main("--threshold", "1.0")
        self.assertEqual(code, 1)
        self.assertIn("868k/200k  agent:devops:main", out)
        self.assertNotIn("agent:qa:main", out)

    def test_clean_exit_zero(self):
        code, _ = self.run_main("--threshold", "5")
        self.assertEqual(code, 0)

    def test_backup_copies_agent_db(self):
        src_dir = os.path.join(self.tmp.name, "agents", "devops", "agent")
        os.makedirs(src_dir)
        with sqlite3.connect(os.path.join(src_dir, "openclaw-agent.sqlite")) as c:
            c.execute("create table t (x)")
            c.execute("insert into t values (42)")
        dest = os.path.join(self.tmp.name, "backup")
        oversized.backup_agents(self.tmp.name, {"devops"}, dest)
        with sqlite3.connect(os.path.join(dest, "devops.sqlite")) as c:
            self.assertEqual(c.execute("select x from t").fetchone()[0], 42)

    def test_backup_missing_db_raises(self):
        with self.assertRaises(FileNotFoundError):
            oversized.backup_agents(self.tmp.name, {"nope"}, os.path.join(self.tmp.name, "b"))


if __name__ == "__main__":
    unittest.main()
