import os
import stat
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL = os.path.join(REPO, "bin", "oc-secret-save")


class TestOcSecretSave(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.join(self.tmp.name, "secrets")

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, args, value=None):
        env = dict(os.environ, OC_SECRETS_DIR=self.dir)
        return subprocess.run([sys.executable, TOOL] + args, input=value, capture_output=True, text=True, env=env, timeout=15)

    def read(self, name):
        with open(os.path.join(self.dir, name)) as f:
            return f.read()

    def test_saves_a_new_value_with_mode_600_and_never_prints_it(self):
        value = "sample-credential-value-for-the-test"
        r = self.run_tool(["telegram-mybot.token"], value + "\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(value, r.stdout + r.stderr)
        self.assertIn("saved:", r.stdout)
        self.assertEqual(self.read("telegram-mybot.token"), value + "\n")
        mode = stat.S_IMODE(os.stat(os.path.join(self.dir, "telegram-mybot.token")).st_mode)
        self.assertEqual(mode, 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.dir).st_mode), 0o700)

    def test_a_value_with_shell_characters_is_kept_exactly(self):
        value = "zX&w>b_~Q+9$5b!.'\"`"
        r = self.run_tool(["site.pass"], value)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("site.pass"), value + "\n")

    def test_never_overwrites_a_file_it_did_not_save(self):
        os.makedirs(self.dir, mode=0o700)
        with open(os.path.join(self.dir, "gitlab-main.token"), "w") as f:
            f.write("owner-value\n")
        r = self.run_tool(["gitlab-main.token"], "agent-value")
        self.assertEqual(r.returncode, 3)
        self.assertIn("new name", r.stderr)
        self.assertEqual(self.read("gitlab-main.token"), "owner-value\n")
        # The same value again is fine and changes nothing.
        r = self.run_tool(["gitlab-main.token"], "owner-value\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("unchanged", r.stdout)

    def test_replaces_its_own_file_and_keeps_the_old_value(self):
        self.assertEqual(self.run_tool(["x.token"], "old").returncode, 0)
        r = self.run_tool(["x.token"], "new")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("replaced", r.stdout)
        self.assertEqual(self.read("x.token"), "new\n")
        backups = os.listdir(os.path.join(self.dir, ".backups"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(self.read(os.path.join(".backups", backups[0])), "old\n")

    def test_refuses_bad_names_empty_values_and_links(self):
        for name in ["../escape", "a/b", ".hidden", "", "x.tmp", ".saved-by-oc-secret-save"]:
            r = self.run_tool([name], "v")
            self.assertNotEqual(r.returncode, 0, name)
        self.assertEqual(self.run_tool(["empty.token"], "\n\n").returncode, 2)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "empty.token")))
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        os.symlink("/etc/passwd", os.path.join(self.dir, "link.token"))
        self.assertEqual(self.run_tool(["link.token"], "v").returncode, 2)
        self.assertNotEqual(self.run_tool([], "v").returncode, 0)


if __name__ == "__main__":
    unittest.main()
