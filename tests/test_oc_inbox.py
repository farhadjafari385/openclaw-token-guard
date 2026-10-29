import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OC_INBOX = os.path.join(REPO, "bin", "oc-inbox")


def run(args, env_file):
    env = dict(os.environ)
    env["OC_INBOX_FILE"] = env_file
    return subprocess.run(
        [sys.executable, OC_INBOX] + args,
        capture_output=True,
        text=True,
        env=env,
        timeout=15,
    )


class TestOcInbox(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.inbox_file = os.path.join(self.tmpdir.name, "inbox.jsonl")

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_add_and_list(self):
        p = run(["add", "--project", "demo", "--title", "Do the thing", "--priority", "high",
                 "--done-when", "it is done"], self.inbox_file)
        self.assertEqual(p.returncode, 0)
        item_id = p.stdout.strip()
        self.assertTrue(item_id)

        p2 = run(["list", "--json"], self.inbox_file)
        self.assertEqual(p2.returncode, 0)
        items = json.loads(p2.stdout)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], item_id)
        self.assertEqual(items[0]["status"], "open")

    def test_plan_flags_missing_info(self):
        run(["add", "--project", "demo", "--title", "No done-when here"], self.inbox_file)
        p = run(["plan", "--json"], self.inbox_file)
        self.assertEqual(p.returncode, 0)
        batches = json.loads(p.stdout)
        found = False
        for batch in batches:
            for item in batch["items"]:
                if item["title"] == "No done-when here":
                    self.assertTrue(item["needs_info"])
                    found = True
        self.assertTrue(found)

    def test_set_status(self):
        p = run(["add", "--project", "demo", "--title", "Something", "--done-when", "x"], self.inbox_file)
        item_id = p.stdout.strip()
        p2 = run(["set", item_id, "--status", "done"], self.inbox_file)
        self.assertEqual(p2.returncode, 0)
        p3 = run(["show", item_id], self.inbox_file)
        shown = json.loads(p3.stdout)
        self.assertEqual(shown["status"], "done")

    def test_duplicate_warning(self):
        run(["add", "--project", "demo", "--title", "Fix the login bug", "--done-when", "x"], self.inbox_file)
        p = run(["add", "--project", "demo", "--title", "fix login bug", "--done-when", "x"], self.inbox_file)
        self.assertEqual(p.returncode, 0)
        self.assertIn("duplicate", p.stderr.lower())

    def test_no_duplicate_warning_for_different_project(self):
        run(["add", "--project", "demo", "--title", "Fix the login bug"], self.inbox_file)
        p = run(["add", "--project", "other", "--title", "Fix the login bug"], self.inbox_file)
        self.assertEqual(p.returncode, 0)
        self.assertNotIn("duplicate", p.stderr.lower())

    def test_concurrent_adds_all_persisted(self):
        def add_one(i):
            return run(["add", "--project", "demo", "--title", f"item {i}"], self.inbox_file)

        with ThreadPoolExecutor(max_workers=8) as ex:
            results = list(ex.map(add_one, range(20)))

        for r in results:
            self.assertEqual(r.returncode, 0)

        p = run(["list", "--json"], self.inbox_file)
        items = json.loads(p.stdout)
        self.assertEqual(len(items), 20)
        ids = {i["id"] for i in items}
        self.assertEqual(len(ids), 20)  # no corrupted/merged lines


if __name__ == "__main__":
    unittest.main()
