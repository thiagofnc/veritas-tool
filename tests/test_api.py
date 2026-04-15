import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient

    from app import api as api_module
    from app.api import app, state, state_lock
    from app.git_service import GitService
    from app.project_service import ProjectService
except Exception:  # pragma: no cover - dependency/setup guard
    TestClient = None


@unittest.skipUnless(TestClient is not None, "FastAPI test client is unavailable")
class TestApi(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        with state_lock:
            state.service = ProjectService()
            state.git = GitService()
            state.loaded_folder = None
            state.loaded_repo_root = None
            state.loaded_commit = None
            state.read_only = False

    def test_requires_loaded_project_for_query_endpoints(self) -> None:
        response = self.client.get("/api/project/tops")
        self.assertEqual(response.status_code, 400)
        self.assertIn("No project loaded", response.json()["detail"])

    def test_project_load_hierarchy_and_graph_endpoints(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            (root / "child.v").write_text(
                """
module child(input clk, input a, output y);
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            (root / "top.v").write_text(
                """
module top(input clk, output y);
  wire local_net;
  child u1 (
    .clk(clk),
    .a(local_net),
    .y(y)
  );
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            with state_lock:
                state.service = ProjectService()
                project = state.service.load_project(str(root))
                state.loaded_folder = str(root)

            self.assertEqual(len(project.source_files), 2)
            self.assertEqual(len(project.modules), 2)

            tops_response = self.client.get("/api/project/tops")
            self.assertEqual(tops_response.status_code, 200)
            self.assertEqual(tops_response.json()["top_candidates"], ["top"])

            project_response = self.client.get("/api/project")
            self.assertEqual(project_response.status_code, 200)
            self.assertIn("modules", project_response.json())

            tops_response = self.client.get("/api/project/tops")
            self.assertEqual(tops_response.status_code, 200)
            self.assertEqual(tops_response.json()["top_candidates"], ["top"])

            modules_response = self.client.get("/api/project/modules")
            self.assertEqual(modules_response.status_code, 200)
            self.assertEqual(modules_response.json()["modules"], ["child", "top"])

            module_response = self.client.get("/api/project/modules/top")
            self.assertEqual(module_response.status_code, 200)
            self.assertEqual(module_response.json()["name"], "top")

            hierarchy_response = self.client.get("/api/project/hierarchy/top")
            self.assertEqual(hierarchy_response.status_code, 200)
            hierarchy = hierarchy_response.json()
            self.assertEqual(hierarchy["module"], "top")
            self.assertEqual(hierarchy["instances"][0]["instance"], "u1")

            hierarchy_graph_response = self.client.get("/api/project/graph/top")
            self.assertEqual(hierarchy_graph_response.status_code, 200)
            hierarchy_graph = hierarchy_graph_response.json()
            self.assertEqual(hierarchy_graph["schema_version"], "1.0")
            self.assertEqual(hierarchy_graph["top_module"], "top")

            connectivity_response = self.client.get("/api/project/connectivity/top?mode=compact")
            self.assertEqual(connectivity_response.status_code, 200)
            connectivity_graph = connectivity_response.json()
            self.assertEqual(connectivity_graph["schema_version"], "1.1-connectivity")
            self.assertEqual(connectivity_graph["focus_module"], "top")
            self.assertEqual(connectivity_graph["mode"], "compact")

            aggregated_response = self.client.get("/api/project/connectivity/top?mode=compact&aggregate_edges=true")
            self.assertEqual(aggregated_response.status_code, 200)
            aggregated_graph = aggregated_response.json()
            self.assertTrue(all("net_count" in edge for edge in aggregated_graph["edges"]))

            port_view_response = self.client.get("/api/project/connectivity/top?mode=compact&port_view=true")
            self.assertEqual(port_view_response.status_code, 200)
            port_view_graph = port_view_response.json()
            self.assertTrue(port_view_graph["port_view"])
            self.assertTrue(any(node.get("kind") == "instance_port" for node in port_view_graph["nodes"]))

            schematic_response = self.client.get("/api/project/connectivity/top?schematic=true&schematic_mode=full")
            self.assertEqual(schematic_response.status_code, 200)
            schematic_graph = schematic_response.json()
            self.assertEqual(schematic_graph["view"], "schematic")
            self.assertEqual(schematic_graph["layout"]["engine"], "schematic-v2")

    def test_lists_and_opens_empty_verilog_files(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            empty_file = root / "empty.v"
            top_file = root / "top.v"
            empty_file.write_text("", encoding="utf-8")
            top_file.write_text(
                """
module top(input a, output y);
  assign y = a;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            with state_lock:
                state.service = ProjectService()
                state.service.load_project(str(root))
                state.loaded_folder = str(root)

            files_response = self.client.get("/api/project/files")
            self.assertEqual(files_response.status_code, 200)
            payload = files_response.json()
            files_by_name = {item["name"]: item for item in payload["files"]}
            self.assertIn("empty.v", files_by_name)
            self.assertIn("top.v", files_by_name)
            self.assertEqual(files_by_name["empty.v"]["modules"], [])
            self.assertEqual(files_by_name["top.v"]["modules"], ["top"])

            source_response = self.client.get("/api/project/files/source", params={"path": str(empty_file.resolve())})
            self.assertEqual(source_response.status_code, 200)
            self.assertEqual(source_response.json()["content"], "")

    def test_root_serves_ui_shell(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("RTL Architecture Visualizer", response.text)

    def test_save_invalid_source_keeps_cached_modules_and_graph(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            (root / "child.v").write_text(
                """
module child(input clk, input a, output y);
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            (root / "top.v").write_text(
                """
module top(input clk, output y);
  wire local_net;
  child u1 (
    .clk(clk),
    .a(local_net),
    .y(y)
  );
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            with state_lock:
                state.service = ProjectService()
                state.service.load_project(str(root))
                state.loaded_folder = str(root)

            save_response = self.client.put(
                "/api/project/modules/top/source",
                json={
                    "content": """
module top(input clk, output y);
  wire local_net;
  child u1 (
    .clk(clk),
    .a(local_net),
    .y(y)
  );
// missing endmodule on purpose
""".strip()
                    + "\n"
                },
            )
            self.assertEqual(save_response.status_code, 200)
            payload = save_response.json()
            self.assertTrue(payload["saved"])
            self.assertTrue(payload["reparse"]["kept_cached_project"])
            self.assertIn("warning", payload["reparse"])

            modules_response = self.client.get("/api/project/modules")
            self.assertEqual(modules_response.status_code, 200)
            self.assertEqual(modules_response.json()["modules"], ["child", "top"])

            connectivity_response = self.client.get("/api/project/connectivity/top?mode=compact")
            self.assertEqual(connectivity_response.status_code, 200)
            self.assertEqual(connectivity_response.json()["focus_module"], "top")

    def test_source_endpoint_is_not_blocked_by_slow_connectivity_build(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            source_text = """
module top(input clk, output y);
  assign y = clk;
endmodule
""".strip() + "\n"
            (root / "top.v").write_text(source_text, encoding="utf-8")

            with state_lock:
                state.service = ProjectService()
                state.service.load_project(str(root))
                state.loaded_folder = str(root)

            build_started = Event()
            allow_build_finish = Event()
            original_build = api_module.build_module_connectivity_graph
            connectivity_status: dict[str, int] = {}
            source_status: dict[str, object] = {}

            def slow_build(project, module_name, **kwargs):
                build_started.set()
                self.assertTrue(
                    allow_build_finish.wait(timeout=5),
                    "Timed out waiting to release mocked connectivity build",
                )
                return original_build(project, module_name, **kwargs)

            def request_connectivity() -> None:
                with TestClient(app) as client:
                    resp = client.get("/api/project/connectivity/top?mode=compact")
                    connectivity_status["code"] = resp.status_code

            def request_source() -> None:
                with TestClient(app) as client:
                    resp = client.get("/api/project/modules/top/source")
                    source_status["code"] = resp.status_code
                    source_status["json"] = resp.json()

            with patch.object(api_module, "build_module_connectivity_graph", side_effect=slow_build):
                connectivity_thread = Thread(target=request_connectivity)
                connectivity_thread.start()

                self.assertTrue(build_started.wait(timeout=2), "Connectivity build did not start")

                source_thread = Thread(target=request_source)
                source_thread.start()
                source_thread.join(timeout=1)

                self.assertFalse(
                    source_thread.is_alive(),
                    "Module source request was blocked by connectivity graph generation",
                )
                self.assertEqual(source_status["code"], 200)
                self.assertEqual(source_status["json"]["content"], source_text)

                allow_build_finish.set()
                connectivity_thread.join(timeout=2)

            self.assertEqual(connectivity_status["code"], 200)

    def test_cannot_instantiate_top_module(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "top.v").write_text(
                """
module top(input a, output y);
  assign y = a;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )
            (root / "helper.v").write_text(
                """
module helper(input a, output y);
  assign y = a;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            with state_lock:
                state.service = ProjectService()
                state.service.load_project(str(root))
                state.loaded_folder = str(root)

            response = self.client.post(
                "/api/project/instantiate",
                json={
                    "child_module": "top",
                    "parent_module": "helper",
                    "instance_name": "top_inst",
                },
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("cannot be instantiated", response.json()["detail"])

    def test_load_commit_snapshot_is_read_only(self) -> None:
        import os
        import subprocess
        import time

        def git(args: list[str], cwd: str, env: dict[str, str] | None = None) -> str:
            merged_env = os.environ.copy()
            if env:
                merged_env.update(env)
            proc = subprocess.run(
                ["git", *args],
                cwd=cwd,
                check=True,
                capture_output=True,
                text=True,
                env=merged_env,
            )
            return proc.stdout.strip()

        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            author_env = {
                "GIT_AUTHOR_NAME": "Test User",
                "GIT_AUTHOR_EMAIL": "test@example.com",
                "GIT_COMMITTER_NAME": "Test User",
                "GIT_COMMITTER_EMAIL": "test@example.com",
            }

            git(["init", "-b", "main"], cwd=temp_dir)

            source_path = root / "top.v"
            source_path.write_text(
                """
module top(input a, output y);
  assign y = a;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )
            git(["add", "-A"], cwd=temp_dir)
            git(["commit", "-m", "v1"], cwd=temp_dir, env=author_env)
            first_commit = git(["rev-parse", "HEAD"], cwd=temp_dir)

            source_path.write_text(
                """
module top(input a, output y);
  assign y = ~a;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )
            git(["add", "-A"], cwd=temp_dir)
            git(["commit", "-m", "v2"], cwd=temp_dir, env=author_env)

            response = self.client.post(
                "/api/git/load-commit",
                json={
                    "folder": temp_dir,
                    "commit": first_commit,
                },
            )
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertTrue(payload["started"])

            progress = None
            for _ in range(80):
                progress_response = self.client.get("/api/project/load/progress")
                self.assertEqual(progress_response.status_code, 200)
                progress = progress_response.json()
                if progress["done"]:
                    break
                time.sleep(0.02)
            self.assertIsNotNone(progress)
            self.assertTrue(progress["done"])
            self.assertIsNone(progress["error"])

            context_response = self.client.get("/api/project/context")
            self.assertEqual(context_response.status_code, 200)
            context = context_response.json()
            self.assertTrue(context["read_only"])
            self.assertEqual(context["loaded_commit"], first_commit)

            source_response = self.client.get("/api/project/modules/top/source")
            self.assertEqual(source_response.status_code, 200)
            self.assertIn("assign y = a;", source_response.json()["content"])
            self.assertNotIn("assign y = ~a;", source_response.json()["content"])

            save_response = self.client.put(
                "/api/project/modules/top/source",
                json={
                    "content": """
module top(input a, output y);
  assign y = 1'b0;
endmodule
""".strip()
                    + "\n"
                },
            )
            self.assertEqual(save_response.status_code, 400)
            self.assertIn("read-only", save_response.json()["detail"].lower())

    def test_loading_subfolder_inside_repo_does_not_expose_git_context(self) -> None:
        import os
        import subprocess
        import time

        def git(args: list[str], cwd: str, env: dict[str, str] | None = None) -> str:
            merged_env = os.environ.copy()
            if env:
                merged_env.update(env)
            proc = subprocess.run(
                ["git", *args],
                cwd=cwd,
                check=True,
                capture_output=True,
                text=True,
                env=merged_env,
            )
            return proc.stdout.strip()

        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            project_dir = root / "nested_project"
            project_dir.mkdir()

            author_env = {
                "GIT_AUTHOR_NAME": "Test User",
                "GIT_AUTHOR_EMAIL": "test@example.com",
                "GIT_COMMITTER_NAME": "Test User",
                "GIT_COMMITTER_EMAIL": "test@example.com",
            }

            git(["init", "-b", "main"], cwd=temp_dir)
            (project_dir / "top.v").write_text(
                """
module top(input a, output y);
  assign y = a;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )
            git(["add", "-A"], cwd=temp_dir)
            git(["commit", "-m", "initial"], cwd=temp_dir, env=author_env)

            response = self.client.post(
                "/api/project/load",
                json={
                    "folder": str(project_dir),
                },
            )
            self.assertEqual(response.status_code, 200)

            progress = None
            for _ in range(80):
                progress_response = self.client.get("/api/project/load/progress")
                self.assertEqual(progress_response.status_code, 200)
                progress = progress_response.json()
                if progress["done"]:
                    break
                time.sleep(0.02)

            self.assertIsNotNone(progress)
            self.assertTrue(progress["done"])
            self.assertIsNone(progress["error"])

            context_response = self.client.get("/api/project/context")
            self.assertEqual(context_response.status_code, 200)
            context = context_response.json()
            self.assertIsNone(context["repo_root"])
            self.assertFalse(context["read_only"])


if __name__ == "__main__":
    unittest.main()



