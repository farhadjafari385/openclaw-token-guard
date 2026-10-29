"""Unit tests for install/_plan.py, install/_apply_rules_block.py and tools/patch-legacy-wait-rules.py."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_module(name, rel_path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(REPO, rel_path))
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, os.path.join(REPO, "install"))
    spec.loader.exec_module(module)
    return module


plan_mod = load_module("plan_mod", "install/_plan.py")
rules_block = load_module("rules_block", "install/_apply_rules_block.py")
legacy = load_module("legacy", "tools/patch-legacy-wait-rules.py")


class Args:
    def __init__(self, **kw):
        self.coordinator = "coordinator"
        self.context_tokens = 200000
        self.compaction_timeout = 900
        self.daily_reset_hour = None
        self.group_idle_minutes = None
        self.rules_dir = os.path.join(REPO, "rules")
        self.__dict__.update(kw)


class TestPlan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = {}
        for agent in ("coordinator", "devops"):
            d = os.path.join(self.tmp.name, agent)
            os.makedirs(d)
            with open(os.path.join(d, "AGENTS.md"), "w", encoding="utf-8") as fh:
                fh.write("# rules\n" + "x" * (19000 if agent == "coordinator" else 500))
            self.ws[agent] = d

    def tearDown(self):
        self.tmp.cleanup()

    def config(self, **extra):
        cfg = {"agents": {"entries": {a: {"workspace": w} for a, w in self.ws.items()}}}
        cfg.update(extra)
        return cfg

    def ops(self, cfg, **kw):
        return {o["path"]: o for o in plan_mod.plan(cfg, Args(**kw))}

    def test_models_added_with_names_and_cap(self):
        models = self.ops(self.config())["models.providers.anthropic.models"]
        self.assertEqual(models["mode"], "set")
        self.assertEqual([m["id"] for m in models["value"]], ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-5-5"])
        self.assertTrue(all(m["contextTokens"] == 200000 and m["name"] for m in models["value"]))

    def test_existing_models_are_kept_and_replaced_in_full(self):
        cfg = self.config(models={"providers": {"anthropic": {"models": [{"id": "claude-x", "name": "X"}]}}})
        op = self.ops(cfg)["models.providers.anthropic.models"]
        self.assertEqual(op["mode"], "replace")
        self.assertEqual(op["value"][0], {"id": "claude-x", "name": "X"})
        self.assertEqual(len(op["value"]), 4)

    def test_no_model_op_when_already_capped(self):
        cfg = self.config()
        cfg["models"] = {"providers": {"anthropic": {"models": plan_mod.merged_models(cfg, 200000)}}}
        self.assertNotIn("models.providers.anthropic.models", self.ops(cfg))

    def test_compaction_timeout_raised_from_default(self):
        op = self.ops(self.config())["agents.defaults.compaction.timeoutSeconds"]
        self.assertEqual(op["value"], 900)
        cfg = self.config()
        cfg["agents"]["defaults"] = {"compaction": {"mode": "safeguard", "timeoutSeconds": 120}}
        self.assertEqual(self.ops(cfg)["agents.defaults.compaction.timeoutSeconds"]["value"], 900)

    def test_longer_compaction_timeout_is_kept(self):
        cfg = self.config()
        cfg["agents"]["defaults"] = {"compaction": {"timeoutSeconds": 1800}}
        self.assertNotIn("agents.defaults.compaction.timeoutSeconds", self.ops(cfg))

    def test_bootstrap_limit_raised_when_rules_would_be_cut(self):
        op = self.ops(self.config())["agents.defaults.bootstrapMaxChars"]
        self.assertGreater(op["value"], 19000 + 2000)
        self.assertEqual(op["value"] % 1000, 0)

    def test_bootstrap_limit_untouched_when_small(self):
        with open(os.path.join(self.ws["coordinator"], "AGENTS.md"), "w", encoding="utf-8") as fh:
            fh.write("short")
        self.assertNotIn("agents.defaults.bootstrapMaxChars", self.ops(self.config()))

    def test_coordinator_gets_task_inbox_via_also_allow(self):
        cfg = self.config()
        cfg["agents"]["entries"]["coordinator"]["tools"] = {"profile": "full", "alsoAllow": ["lobster"]}
        op = self.ops(cfg)["agents.entries.coordinator.tools.alsoAllow"]
        self.assertEqual(op["value"], ["lobster", "task_inbox"])

    def test_restrictive_allow_list_is_extended(self):
        cfg = self.config()
        cfg["agents"]["entries"]["coordinator"]["tools"] = {"allow": ["message"]}
        self.assertEqual(self.ops(cfg)["agents.entries.coordinator.tools.allow"]["value"], ["message", "task_inbox"])

    def test_daily_reset_keeps_existing_idle_minutes(self):
        cfg = self.config(session={"reset": {"mode": "idle", "idleMinutes": 60}})
        op = self.ops(cfg, daily_reset_hour=22)["session.resetByType.group"]
        self.assertEqual(op["value"], {"mode": "daily", "atHour": 22, "idleMinutes": 60})
        self.assertNotIn("session.resetByType.group", self.ops(cfg))

    def test_legacy_agents_list_is_supported(self):
        cfg = {"agents": {"list": [{"id": "coordinator", "workspace": self.ws["coordinator"]}]}}
        self.assertEqual(plan_mod.workspaces(cfg), [("coordinator", self.ws["coordinator"])])
        self.assertIn("agents.list[0].tools.alsoAllow", self.ops(cfg))

    def test_cli_prints_json_lines(self):
        path = os.path.join(self.tmp.name, "openclaw.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.config(), fh)
        out = subprocess.run([sys.executable, os.path.join(REPO, "install", "_plan.py"), path],
                             capture_output=True, text=True, check=True).stdout
        self.assertTrue(all("path" in json.loads(line) for line in out.splitlines()))


class TestApplyRulesBlock(unittest.TestCase):
    BLOCK = "<!-- token-guard:begin -->\nrule — ünïcode\n<!-- token-guard:end -->\n"

    def test_appends_when_no_existing_markers(self):
        new_text, changed = rules_block.merge_block("# Existing\n", self.BLOCK)
        self.assertTrue(changed)
        self.assertTrue(new_text.startswith("# Existing\n"))
        self.assertIn("rule — ünïcode", new_text)

    def test_replaces_existing_block_in_place(self):
        target = "a\n<!-- token-guard:begin -->\nold\n<!-- token-guard:end -->\nb\n"
        new_text, changed = rules_block.merge_block(target, self.BLOCK)
        self.assertTrue(changed)
        self.assertNotIn("old", new_text)
        self.assertTrue(new_text.endswith("\nb\n"))

    def test_second_apply_is_a_no_op(self):
        once, _ = rules_block.merge_block("x\n", self.BLOCK)
        twice, changed = rules_block.merge_block(once, self.BLOCK)
        self.assertFalse(changed)
        self.assertEqual(once, twice)

    def test_missing_markers_in_block_raises(self):
        with self.assertRaises(ValueError):
            rules_block.merge_block("x", "no markers")


class TestLegacyPatch(unittest.TestCase):
    def test_wrapped_legacy_rules_are_replaced(self):
        text = ("intro\n3. Never foreground-poll a job for more than 5 minutes: check it, report its\n"
                "   job ID and current status, then move on or end the turn; a later check\n"
                "   picks up where you left off.\n4. next rule\n")
        out, n = legacy.patch(text)
        self.assertEqual(n, 1)
        self.assertIn("token-guard waiter", out)
        self.assertTrue(out.startswith("intro\n3. Never poll"))
        self.assertTrue(out.endswith("4. next rule\n"))

    def test_unrelated_text_is_untouched(self):
        text = "nothing to see\n"
        self.assertEqual(legacy.patch(text), (text, 0))


if __name__ == "__main__":
    unittest.main()
