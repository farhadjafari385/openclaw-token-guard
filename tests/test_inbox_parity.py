"""The guard's JS inbox fold (plugin/inbox.js loadInboxItems) must equal oc-inbox's fold_state.

2026-11-18 (finding F02): the JS fold dropped details, source, batch and history, so briefs lost the owner's words,
replies lost their source message, and every history check in the guard saw nothing. This test folds the same event
log in both languages and compares every item field by field.

Set OC_INBOX_PARITY_FILE to a real inbox.jsonl to also compare a production log (read only; nothing is written).
"""
import importlib.machinery
import importlib.util
import json
import os
import random
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OC_INBOX = os.path.join(REPO, "bin", "oc-inbox")

_loader = importlib.machinery.SourceFileLoader("oc_inbox", OC_INBOX)
_spec = importlib.util.spec_from_loader("oc_inbox", _loader)
oc_inbox = importlib.util.module_from_spec(_spec)
_loader.exec_module(oc_inbox)

JS_FOLD = """
import { loadInboxItems } from %s;
const items = loadInboxItems(process.argv[1]);
process.stdout.write(JSON.stringify(Object.fromEntries(items)));
""" % json.dumps("file://" + os.path.join(REPO, "plugin", "inbox.js"))


def js_fold(path):
    out = subprocess.run(["node", "--input-type=module", "-e", JS_FOLD, path],
                         capture_output=True, text=True, timeout=60, check=True)
    return json.loads(out.stdout)


def py_fold(path):
    return json.loads(json.dumps(oc_inbox.fold_state(oc_inbox.read_events(path))))


def write_log(path, events):
    with open(path, "w") as f:
        for ev in events:
            f.write(json.dumps(ev, sort_keys=True) + "\n")


def ts(n):
    return "2026-11-18T%02d:%02d:%02d+00:00" % (n // 3600 % 24, n // 60 % 60, n % 60)


class TestInboxParity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "inbox.jsonl")

    def tearDown(self):
        self.tmp.cleanup()

    def assertSameFold(self, path):
        py, js = py_fold(path), js_fold(path)
        self.assertEqual(sorted(py), sorted(js), "different item ids")
        for item_id in py:
            # On a mismatch name only the differing fields, never their values (a real log holds private content).
            diff = sorted(k for k in set(py[item_id]) | set(js[item_id]) if py[item_id].get(k) != js[item_id].get(k))
            self.assertFalse(diff, "item %s differs in %s" % (item_id, diff))
        return py, js

    def test_fields_the_guard_reads(self):
        write_log(self.path, [
            {"kind": "add", "id": "aaaa0001", "project": "demo", "title": "Fix pay", "ts": ts(1), "by": "orchestrator",
             "details": "Owner said: «make pay work for bot users»", "source": "tg:7:1234", "done_when": "a paid job"},
            {"kind": "set", "id": "aaaa0001", "status": "todo", "note": "planned", "by": "pm", "ts": ts(2)},
            {"kind": "set", "id": "aaaa0001", "status": "in_progress", "batch": "b1", "by": "orchestrator", "ts": ts(3)},
            {"kind": "set", "id": "aaaa0001", "note": "only a note", "by": "dev", "ts": ts(4)},
            {"kind": "set", "id": "aaaa0001", "status": "in_progress", "note": "same status again", "by": "dev", "ts": ts(5)},
            {"kind": "set", "id": "aaaa0001", "status": "qa", "note": "Rescoped: split payment part", "by": "pm", "ts": ts(6)},
            {"kind": "set", "id": "aaaa0001", "status": "done", "note": "User path: job 42 delivered", "by": "qa", "ts": ts(7)},
            {"kind": "approve", "id": "aaaa0001", "by": "orchestrator", "ts": ts(8)},
            {"kind": "approve", "id": "aaaa0001", "by": "owner", "ts": ts(9)},
            {"kind": "set", "id": "missing0", "status": "todo", "ts": ts(10)},
        ])
        py, js = self.assertSameFold(self.path)
        it = js["aaaa0001"]
        self.assertIn("Owner said", it["details"])
        self.assertEqual(it["source"], "tg:7:1234")
        self.assertEqual(it["batch"], "b1")
        self.assertEqual(it["status"], "archived")
        self.assertEqual([h["to"] for h in it["history"]], ["todo", "in_progress", "qa", "done", "archived"])
        self.assertTrue(any("User path:" in str(h["note"]) for h in it["history"]))

    def test_history_is_capped_like_oc_inbox(self):
        events = [{"kind": "add", "id": "bbbb0001", "project": "demo", "title": "Loop", "ts": ts(0)}]
        for n in range(1, 60):
            events.append({"kind": "set", "id": "bbbb0001", "status": "todo" if n % 2 else "in_progress",
                           "note": "move %d" % n, "by": "x", "ts": ts(n)})
        write_log(self.path, events)
        py, js = self.assertSameFold(self.path)
        self.assertEqual(len(js["bbbb0001"]["history"]), oc_inbox.HISTORY_KEEP)

    def test_random_logs(self):
        rng = random.Random(20261118)
        statuses = oc_inbox.COLUMNS + list(oc_inbox.LEGACY)
        for _round in range(25):
            ids = ["%08x" % rng.getrandbits(32) for _ in range(rng.randint(1, 6))]
            events = []
            for n in range(rng.randint(5, 80)):
                item_id = rng.choice(ids)
                kind = rng.choice(["add", "set", "set", "set", "approve"])
                ev = {"kind": kind, "id": item_id, "ts": ts(n), "by": rng.choice(["owner", "orchestrator", "dev", "system"])}
                if kind == "add":
                    ev.update(project="demo", title="t%d" % n, details=rng.choice([None, "d", "Owner said: «x»"]),
                              source=rng.choice([None, "tg:5:%d" % n]), status=rng.choice([None, "todo", "open"]),
                              type=rng.choice(["bug", "task"]), priority=rng.choice(["normal", "high"]),  # the CLI always writes these
                              owner=rng.choice([None, "dev"]), size=rng.choice([None, "", "small"]), area=rng.choice([None, "api"]))
                elif kind == "set":
                    if rng.random() < 0.7:
                        ev["status"] = rng.choice(statuses)
                    if rng.random() < 0.5:
                        ev["note"] = rng.choice([None, "", "n%d" % n, "Operator: unblocked"])
                    if rng.random() < 0.2:
                        ev["batch"] = rng.choice([None, "b%d" % n])
                    if rng.random() < 0.2:
                        ev["rank"] = rng.choice([0, 1, 3])
                    if rng.random() < 0.2:
                        ev["owner"] = rng.choice(["dev", "qa", ""])
                events.append(ev)
            write_log(self.path, events)
            self.assertSameFold(self.path)

    @unittest.skipUnless(os.environ.get("OC_INBOX_PARITY_FILE"), "set OC_INBOX_PARITY_FILE to compare a real log")
    def test_real_log(self):
        self.assertSameFold(os.environ["OC_INBOX_PARITY_FILE"])


if __name__ == "__main__":
    unittest.main()
