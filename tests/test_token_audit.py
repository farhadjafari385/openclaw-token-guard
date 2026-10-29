import datetime
import json
import os
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "tools"))

import importlib.util

spec = importlib.util.spec_from_file_location("token_audit", os.path.join(REPO, "tools", "token-audit.py"))
token_audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(token_audit)


def write_jsonl(path, records):
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


class TestTokenAudit(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = self.tmpdir.name
        self.now = datetime.datetime(2026, 10, 28, 12, 0, 0, tzinfo=datetime.timezone.utc)

    def tearDown(self):
        self.tmpdir.cleanup()

    def _project_dir(self, name):
        d = os.path.join(self.root, name)
        os.makedirs(d, exist_ok=True)
        return d

    def test_totals_and_weighting_and_dedup(self):
        d = self._project_dir("-home-user--openclaw-workspace-coordinator")
        ts = self.now.isoformat().replace("+00:00", "Z")
        records = [
            {
                "type": "assistant",
                "sessionId": "s1",
                "timestamp": ts,
                "message": {
                    "id": "msg_1",
                    "model": "claude-sonnet-5",
                    "usage": {
                        "input_tokens": 100,
                        "output_tokens": 50,
                        "cache_read_input_tokens": 1000,
                        "cache_creation": {"ephemeral_5m_input_tokens": 200, "ephemeral_1h_input_tokens": 0},
                    },
                    "content": [],
                },
            },
            # duplicate message id -> must not double count
            {
                "type": "assistant",
                "sessionId": "s1",
                "timestamp": ts,
                "message": {
                    "id": "msg_1",
                    "model": "claude-sonnet-5",
                    "usage": {
                        "input_tokens": 100,
                        "output_tokens": 50,
                        "cache_read_input_tokens": 1000,
                        "cache_creation": {"ephemeral_5m_input_tokens": 200, "ephemeral_1h_input_tokens": 0},
                    },
                    "content": [],
                },
            },
        ]
        write_jsonl(os.path.join(d, "session1.jsonl"), records)

        result = token_audit.analyse(self.root, days=7, now=self.now)
        self.assertEqual(result["totals"]["input"], 100)
        self.assertEqual(result["totals"]["output"], 50)
        self.assertEqual(result["totals"]["cache_read"], 1000)
        self.assertEqual(result["totals"]["cache_write"], 200)

        expected_units = 100 * 1.0 + 1000 * 0.1 + 200 * 1.25 + 0 * 2.0 + 50 * 5.0
        self.assertAlmostEqual(result["weighted_total"], round(expected_units, 2))

        self.assertIn("coordinator", result["by_agent"])  # prefix stripped

    def test_days_window_excludes_old_entries(self):
        d = self._project_dir("agentX")
        old_ts = (self.now - datetime.timedelta(days=30)).isoformat().replace("+00:00", "Z")
        recent_ts = self.now.isoformat().replace("+00:00", "Z")
        records = [
            {
                "type": "assistant",
                "sessionId": "s-old",
                "timestamp": old_ts,
                "message": {"id": "old1", "model": "m", "usage": {"input_tokens": 999}, "content": []},
            },
            {
                "type": "assistant",
                "sessionId": "s-new",
                "timestamp": recent_ts,
                "message": {"id": "new1", "model": "m", "usage": {"input_tokens": 7}, "content": []},
            },
        ]
        write_jsonl(os.path.join(d, "s.jsonl"), records)
        result = token_audit.analyse(self.root, days=7, now=self.now)
        self.assertEqual(result["totals"]["input"], 7)

    def test_polling_classification(self):
        d = self._project_dir("agentY")
        ts = self.now.isoformat().replace("+00:00", "Z")
        records = [
            {
                "type": "assistant",
                "sessionId": "s1",
                "promptId": "turn1",
                "timestamp": ts,
                "message": {
                    "id": "m1",
                    "model": "m",
                    "usage": {"input_tokens": 1},
                    "content": [
                        {"type": "tool_use", "name": "mcp__openclaw__process", "input": {"action": "poll"}},
                        {"type": "tool_use", "name": "mcp__openclaw__exec", "input": {"command": "sleep 10"}},
                        {"type": "tool_use", "name": "Read", "input": {"file_path": "/x"}},
                    ],
                },
            },
        ]
        write_jsonl(os.path.join(d, "s.jsonl"), records)
        result = token_audit.analyse(self.root, days=7, now=self.now)
        self.assertEqual(result["polling"]["total_calls"], 3)
        self.assertEqual(result["polling"]["polling_calls"], 2)

    def test_repeated_command_in_one_turn_counts_as_polling(self):
        d = self._project_dir("agentZ")
        ts = self.now.isoformat().replace("+00:00", "Z")
        content = [
            {"type": "tool_use", "name": "mcp__openclaw__exec", "input": {"command": "git status"}}
            for _ in range(3)
        ]
        records = [
            {
                "type": "assistant",
                "sessionId": "s1",
                "promptId": "turnA",
                "timestamp": ts,
                "message": {"id": "m1", "model": "m", "usage": {"input_tokens": 1}, "content": content},
            }
        ]
        write_jsonl(os.path.join(d, "s.jsonl"), records)
        result = token_audit.analyse(self.root, days=7, now=self.now)
        # 3rd repeated call in the turn should be flagged polling
        self.assertGreaterEqual(result["polling"]["polling_calls"], 1)

    def test_max_context_buckets_and_top_sessions(self):
        d = self._project_dir("agentW")
        ts = self.now.isoformat().replace("+00:00", "Z")
        records = [
            {
                "type": "assistant",
                "sessionId": "big-session",
                "timestamp": ts,
                "message": {"id": "m1", "model": "m", "usage": {"input_tokens": 150000}, "content": []},
            }
        ]
        write_jsonl(os.path.join(d, "s.jsonl"), records)
        result = token_audit.analyse(self.root, days=7, now=self.now)
        self.assertEqual(result["max_context_buckets"]["100-200k"], 1)
        self.assertEqual(result["top_sessions"][0]["session"], "big-session")

    def test_alert_weighted_exit_code(self):
        d = self._project_dir("agentV")
        ts = self.now.isoformat().replace("+00:00", "Z")
        records = [
            {
                "type": "assistant",
                "sessionId": "s1",
                "timestamp": ts,
                "message": {"id": "m1", "model": "m", "usage": {"input_tokens": 1000, "output_tokens": 1000}, "content": []},
            }
        ]
        write_jsonl(os.path.join(d, "s.jsonl"), records)
        rc = token_audit.main(["--root", self.root, "--days", "7", "--alert-weighted", "1", "--json"])
        self.assertEqual(rc, 3)
        rc2 = token_audit.main(["--root", self.root, "--days", "7", "--alert-weighted", "999999999", "--json"])
        self.assertEqual(rc2, 0)


if __name__ == "__main__":
    unittest.main()
