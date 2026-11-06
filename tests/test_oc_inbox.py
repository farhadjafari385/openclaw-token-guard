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

    def test_pm_sets_queue_rank_and_priority(self):
        item_id = run(["add", "--project", "demo", "--title", "Ship the paywall", "--done-when", "live"], self.inbox_file).stdout.strip()
        p = run(["set", item_id, "--rank", "1", "--priority", "urgent"], self.inbox_file)
        self.assertEqual(p.returncode, 0, p.stderr)
        it = json.loads(run(["list", "--json"], self.inbox_file).stdout)[0]
        self.assertEqual((it["rank"], it["priority"]), (1, "urgent"))
        run(["set", item_id, "--rank", "0"], self.inbox_file)  # 0 clears the rank
        self.assertIsNone(json.loads(run(["list", "--json"], self.inbox_file).stdout)[0]["rank"])
        self.assertEqual(run(["set", item_id, "--rank", "-2"], self.inbox_file).returncode, 2)
        self.assertNotEqual(run(["set", item_id, "--priority", "huge"], self.inbox_file).returncode, 0)

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
        self.assertEqual(items[0]["status"], "backlog")  # no owner yet: Backlog, not To do

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

    def add(self, title, **kw):
        args = ["add", "--project", kw.get("project", "demo"), "--title", title, "--done-when", "x"]
        for key in ("owner", "size", "area", "priority"):
            if key in kw:
                args += [f"--{key}", kw[key]]
        p = run(args, self.inbox_file)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout.strip()

    def plan(self):
        p = run(["plan", "--json"], self.inbox_file)
        self.assertEqual(p.returncode, 0, p.stderr)
        return [[i["id"] for i in b["items"]] for b in json.loads(p.stdout)]

    def test_plan_gives_medium_and_large_items_their_own_session(self):
        a = self.add("Deploy pricing page", owner="devops", size="large", area="deploy")
        b = self.add("Refactor auth module", owner="writer", area="auth")
        c = self.add("Fix login redirect", owner="writer", area="auth")
        self.assertEqual(sorted(self.plan()), sorted([[a], [b], [c]]))

    def test_plan_groups_small_items_by_project_owner_and_area(self):
        a = self.add("Button grey on mobile", owner="writer", size="small", area="Web UI")
        b = self.add("Footer typo", owner="writer", size="small", area="web ui")
        c = self.add("Typo in CI job name", owner="devops", size="small", area="CI")
        d = self.add("Header typo", owner="writer", size="small", area="web ui", project="other")
        self.assertEqual(sorted(self.plan()), sorted([[a, b], [c], [d]]))

    def test_plan_caps_small_batches_at_four(self):
        ids = [self.add(f"Copy fix number {n}", owner="writer", size="small", area="copy") for n in range(6)]
        self.assertEqual(self.plan(), [ids[:4], ids[4:]])

    def test_plan_needs_owner_and_set_updates_size(self):
        a = self.add("Something odd", size="small")
        p = run(["plan"], self.inbox_file)
        self.assertIn("NEEDS INFO: owner", p.stdout)
        run(["set", a, "--size", "large", "--owner", "qa"], self.inbox_file)
        batch = json.loads(run(["plan", "--json"], self.inbox_file).stdout)[0]
        self.assertEqual((batch["owner"], batch["items"][0]["size"], batch["needs_info"]), ("qa", "large", False))

    def test_set_status_follows_the_flow(self):
        item_id = run(["add", "--project", "demo", "--title", "Something", "--done-when", "x"], self.inbox_file).stdout.strip()
        bad = run(["set", item_id, "--status", "done"], self.inbox_file)
        self.assertEqual(bad.returncode, 2)
        self.assertIn("cannot move", bad.stderr)
        self.assertEqual(run(["set", item_id, "--status", "todo"], self.inbox_file).returncode, 2)  # needs an owner first
        for step in (["--status", "todo", "--owner", "devops"], ["--status", "in_progress"], ["--status", "review"], ["--status", "done"]):
            self.assertEqual(run(["set", item_id, *step], self.inbox_file).returncode, 0, step)
        shown = json.loads(run(["show", item_id], self.inbox_file).stdout)
        self.assertEqual(shown["status"], "done")
        self.assertEqual([h["to"] for h in shown["history"]], ["todo", "in_progress", "review", "done"])

    def test_archive_needs_both_approvals(self):
        item_id = run(["add", "--project", "demo", "--title", "T", "--owner", "qa", "--done-when", "x"], self.inbox_file).stdout.strip()
        self.assertEqual(json.loads(run(["show", item_id], self.inbox_file).stdout)["status"], "todo")
        self.assertEqual(run(["set", item_id, "--status", "archived"], self.inbox_file).returncode, 2)
        self.assertIn("is todo", run(["approve", item_id, "--by", "owner"], self.inbox_file).stdout)
        run(["set", item_id, "--status", "done", "--by", "system"], self.inbox_file)
        self.assertIn("waiting for the orchestrator", run(["approve", item_id, "--by", "owner"], self.inbox_file).stdout)
        self.assertIn("archived", run(["approve", item_id, "--by", "orchestrator"], self.inbox_file).stdout)
        self.assertEqual(json.loads(run(["show", item_id], self.inbox_file).stdout)["status"], "archived")
        self.assertEqual(json.loads(run(["list", "--json"], self.inbox_file).stdout), [])  # archived is hidden by default
        self.assertEqual(len(json.loads(run(["list", "--all", "--json"], self.inbox_file).stdout)), 1)

    def test_reopening_clears_approvals(self):
        item_id = run(["add", "--project", "demo", "--title", "T", "--owner", "qa", "--done-when", "x"], self.inbox_file).stdout.strip()
        run(["set", item_id, "--status", "done", "--by", "system"], self.inbox_file)
        run(["approve", item_id, "--by", "orchestrator"], self.inbox_file)
        run(["set", item_id, "--status", "in_progress"], self.inbox_file)
        run(["set", item_id, "--status", "review"], self.inbox_file)
        run(["set", item_id, "--status", "done"], self.inbox_file)
        self.assertIn("waiting for the orchestrator", run(["approve", item_id, "--by", "owner"], self.inbox_file).stdout)

    def test_blocked_and_dropped_need_a_reason(self):
        item_id = run(["add", "--project", "demo", "--title", "T"], self.inbox_file).stdout.strip()
        self.assertEqual(run(["set", item_id, "--status", "blocked"], self.inbox_file).returncode, 2)
        self.assertEqual(run(["set", item_id, "--status", "blocked", "--note", "needs the owner's DNS access"], self.inbox_file).returncode, 0)

    def test_legacy_statuses_map_to_columns(self):
        with open(self.inbox_file, "w") as f:
            f.write(json.dumps({"kind": "add", "id": "aaaa0001", "project": "p", "title": "t"}) + "\n")
            f.write(json.dumps({"kind": "set", "id": "aaaa0001", "status": "dispatched"}) + "\n")
        self.assertEqual(json.loads(run(["show", "aaaa0001"], self.inbox_file).stdout)["status"], "in_progress")

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
