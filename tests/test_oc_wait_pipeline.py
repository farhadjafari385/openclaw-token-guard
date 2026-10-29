import http.server
import json
import os
import re
import subprocess
import sys
import threading
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OC_WAIT_PIPELINE = os.path.join(REPO, "bin", "oc-wait-pipeline")


class FakeGitLabHandler(http.server.BaseHTTPRequestHandler):
    # class-level script of pipeline states to return on successive polls
    pipeline_states = ["running", "running", "failed"]
    call_count = {"pipelines": 0}
    jobs_response = []
    traces = {}
    unauthorized = False
    sha_lists_before_found = 0
    sha_list_calls = {"n": 0}

    def log_message(self, format, *args):
        pass

    def _send_json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.unauthorized:
            self._send_json(401, {"message": "401 Unauthorized"})
            return

        if re.match(r"^/api/v4/projects/([^/]+)/pipelines\?", self.path) and "sha=" in self.path:
            self.sha_list_calls["n"] += 1
            if self.sha_list_calls["n"] <= self.sha_lists_before_found:
                self._send_json(200, [])
            else:
                self._send_json(200, [{"id": 77, "status": "running", "sha": "abcdef1234567890"}])
            return

        m = re.match(r"^/api/v4/projects/([^/]+)/pipelines/(\d+)/jobs", self.path)
        if m:
            self._send_json(200, self.jobs_response)
            return

        m = re.match(r"^/api/v4/projects/([^/]+)/pipelines/(\d+)$", self.path)
        if m:
            idx = min(self.call_count["pipelines"], len(self.pipeline_states) - 1)
            status = self.pipeline_states[idx]
            self.call_count["pipelines"] += 1
            self._send_json(
                200,
                {
                    "id": int(m.group(2)),
                    "status": status,
                    "ref": "main",
                    "sha": "abcdef1234567890",
                    "duration": 42,
                    "web_url": "https://gitlab.example.com/pipeline/1",
                },
            )
            return

        m = re.match(r"^/api/v4/projects/([^/]+)/jobs/(\d+)/trace$", self.path)
        if m:
            job_id = m.group(2)
            body = self.traces.get(job_id, "no trace").encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self._send_json(404, {"message": "not found"})


def make_server():
    server = http.server.HTTPServer(("127.0.0.1", 0), FakeGitLabHandler)
    t = threading.Thread(target=server.serve_forever)
    t.daemon = True
    t.start()
    return server, t


def run_waiter(host, env_extra=None, args=None):
    env = dict(os.environ)
    env["GITLAB_TOKEN"] = "fake-token-value"
    if env_extra:
        env.update(env_extra)
    cmd = [sys.executable, OC_WAIT_PIPELINE, "--project", "1", "--host", host, "--every", "1", "--timeout", "10"]
    if args:
        cmd += args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)


class TestOcWaitPipeline(unittest.TestCase):
    def setUp(self):
        FakeGitLabHandler.pipeline_states = ["running", "running", "failed"]
        FakeGitLabHandler.call_count = {"pipelines": 0}
        FakeGitLabHandler.jobs_response = []
        FakeGitLabHandler.traces = {}
        FakeGitLabHandler.unauthorized = False
        FakeGitLabHandler.sha_lists_before_found = 0
        FakeGitLabHandler.sha_list_calls = {"n": 0}
        self.server, self.thread = make_server()
        self.host = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=5)

    def test_running_to_failed_with_job_traces(self):
        FakeGitLabHandler.jobs_response = [
            {"id": 10, "name": "build", "stage": "build", "status": "failed", "web_url": "https://x/job/10"},
            {"id": 11, "name": "test", "stage": "test", "status": "failed", "web_url": "https://x/job/11"},
            {"id": 12, "name": "lint", "stage": "test", "status": "success", "web_url": "https://x/job/12"},
        ]
        FakeGitLabHandler.traces = {
            "10": "\x1b[31mline1\x1b[0m\n" + "\n".join(f"log line {i}" for i in range(40)),
            "11": "another trace\n",
        }
        p = run_waiter(self.host, args=["--pipeline", "1"])
        self.assertEqual(p.returncode, 1)
        self.assertIn("failed", p.stdout)
        self.assertIn("build", p.stdout)
        self.assertIn("log line 39", p.stdout)  # within the last-30-lines tail
        self.assertNotIn("\x1b[", p.stdout)  # ANSI stripped

    def test_success_path(self):
        FakeGitLabHandler.pipeline_states = ["success"]
        p = run_waiter(self.host, args=["--pipeline", "1"])
        self.assertEqual(p.returncode, 0)
        self.assertIn("success", p.stdout)

    def test_unauthorized(self):
        FakeGitLabHandler.unauthorized = True
        p = run_waiter(self.host, args=["--pipeline", "1"])
        self.assertEqual(p.returncode, 2)
        self.assertNotIn("fake-token-value", p.stdout)
        self.assertNotIn("fake-token-value", p.stderr)

    def test_timeout(self):
        FakeGitLabHandler.pipeline_states = ["running"] * 100
        cmd = [
            sys.executable, OC_WAIT_PIPELINE,
            "--project", "1", "--host", self.host,
            "--pipeline", "1",
            "--every", "1", "--timeout", "2",
        ]
        env = dict(os.environ)
        env["GITLAB_TOKEN"] = "fake-token-value"
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)
        self.assertEqual(p.returncode, 124)

    def test_json_output(self):
        FakeGitLabHandler.pipeline_states = ["success"]
        p = run_waiter(self.host, args=["--pipeline", "1", "--json"])
        self.assertEqual(p.returncode, 0)
        data = json.loads(p.stdout.strip().splitlines()[-1])
        self.assertEqual(data["status"], "success")

    def test_token_never_printed_on_success(self):
        FakeGitLabHandler.pipeline_states = ["success"]
        p = run_waiter(self.host, args=["--pipeline", "1"])
        self.assertNotIn("fake-token-value", p.stdout)
        self.assertNotIn("fake-token-value", p.stderr)


    def test_sha_waits_for_pipeline_to_appear(self):
        FakeGitLabHandler.sha_lists_before_found = 2
        FakeGitLabHandler.pipeline_states = ["running", "success"]
        p = run_waiter(self.host, args=["--sha", "abcdef1234567890", "--ref", "main"])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("pipeline 77 status=success", p.stdout)
        self.assertGreaterEqual(FakeGitLabHandler.sha_list_calls["n"], 3)

    def test_sha_never_appears_times_out(self):
        FakeGitLabHandler.sha_lists_before_found = 10**6
        cmd = [sys.executable, OC_WAIT_PIPELINE, "--project", "1", "--host", self.host,
               "--sha", "deadbeef", "--every", "1", "--timeout", "2"]
        env = dict(os.environ, GITLAB_TOKEN="fake-token-value")
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)
        self.assertEqual(p.returncode, 124)
        self.assertIn("a pipeline for commit deadbeef", p.stdout)

    def test_ref_with_pipeline_is_rejected(self):
        p = run_waiter(self.host, args=["--pipeline", "1", "--ref", "main"])
        self.assertEqual(p.returncode, 2)


if __name__ == "__main__":
    unittest.main()
