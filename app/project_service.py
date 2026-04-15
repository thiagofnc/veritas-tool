"""Service layer for loading and querying parsed Verilog projects."""

from pathlib import Path
from typing import Any

try:
    from app.graph_builder import build_hierarchy_graph, build_module_connectivity_graph
    from app.hierarchy import build_hierarchy_tree, infer_top_modules
    from app.models import ModuleDef, Project
    from app.pyverilog_parser import PyVerilogParser
    from app.scanner import scan_verilog_files
    from app.schematic_layout import build_schematic_connectivity_graph
except ImportError:  # Supports running as: python app/main.py
    from graph_builder import build_hierarchy_graph, build_module_connectivity_graph
    from hierarchy import build_hierarchy_tree, infer_top_modules
    from models import ModuleDef, Project
    from pyverilog_parser import PyVerilogParser  # type: ignore
    from scanner import scan_verilog_files
    from schematic_layout import build_schematic_connectivity_graph


class ProjectService:
    """Thin orchestration layer used by CLI today and UI/API later."""

    def __init__(self) -> None:
        self.project: Project | None = None

    def load_project(self, folder: str, progress_callback=None) -> Project:
        """Scan + parse a project folder and cache the resulting Project."""
        parser = PyVerilogParser()
        file_paths = scan_verilog_files(folder)
        self.project = parser.parse_files(file_paths, progress_callback=progress_callback)
        return self.project

    def reparse_file(self, file_path: str) -> dict[str, Any]:
        """Re-parse a single source file and merge its modules into the cached project."""
        project = self._require_project()

        target = str(Path(file_path).resolve())
        old_modules_for_file = [m for m in project.modules if m.source_file == target]
        old_names = {m.name for m in old_modules_for_file}

        parser = PyVerilogParser()
        partial = parser.parse_files([target])
        new_modules = list(partial.modules)
        new_names = {m.name for m in new_modules}

        if new_names != old_names:
            return {
                "requires_full_reparse": True,
                "old_modules": sorted(old_names),
                "new_modules": sorted(new_names),
            }

        new_by_name = {m.name: m for m in new_modules}
        for idx, mod in enumerate(project.modules):
            if mod.source_file == target and mod.name in new_by_name:
                project.modules[idx] = new_by_name[mod.name]

        return {
            "requires_full_reparse": False,
            "updated_modules": sorted(new_names),
        }

    def get_project(self) -> Project:
        return self._require_project()

    def get_top_candidates(self, include_testbenches: bool = False) -> list[str]:
        project = self._require_project()
        return infer_top_modules(project.modules, include_testbenches=include_testbenches)

    def get_module_names(self) -> list[str]:
        project = self._require_project()
        names = {module.name for module in project.modules}
        return sorted(names)

    def get_module(self, module_name: str) -> ModuleDef:
        project = self._require_project()
        for module in project.modules:
            if module.name == module_name:
                return module
        raise ValueError(f"Module not found in loaded project: {module_name}")

    def get_source_files(self) -> list[str]:
        project = self._require_project()
        return sorted({source.path for source in project.source_files})

    def get_hierarchy_tree(self, top_module: str) -> dict[str, Any]:
        project = self._require_project()
        self.get_module(top_module)
        return build_hierarchy_tree(project.modules, top_module)

    def get_module_graph(self, module_name: str) -> dict[str, Any]:
        project = self._require_project()
        self.get_module(module_name)
        return build_hierarchy_graph(project, module_name)

    def get_module_connectivity_graph(
        self,
        module_name: str,
        mode: str = "compact",
        aggregate_edges: bool = False,
        port_view: bool = False,
        schematic: bool = False,
        schematic_mode: str = "full",
    ) -> dict[str, Any]:
        project = self._require_project()
        self.get_module(module_name)
        if schematic:
            return build_schematic_connectivity_graph(project, module_name, schematic_mode=schematic_mode)
        return build_module_connectivity_graph(
            project,
            module_name,
            mode=mode,
            aggregate_edges=aggregate_edges,
            port_view=port_view,
        )

    def create_module(self, module_name: str) -> dict[str, Any]:
        """Create a new Verilog module file with a minimal skeleton."""
        project = self._require_project()

        import re
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", module_name):
            raise ValueError(f"Invalid Verilog module name: {module_name!r}")

        existing_names = {m.name for m in project.modules}
        if module_name in existing_names:
            raise ValueError(f"Module '{module_name}' already exists in the project.")

        tops = self.get_top_candidates()
        target_dir: Path | None = None
        if tops:
            for mod in project.modules:
                if mod.name == tops[0] and mod.source_file:
                    target_dir = Path(mod.source_file).parent
                    break

        if target_dir is None:
            target_dir = Path(project.root_path)

        file_path = target_dir / f"{module_name}.v"
        if file_path.exists():
            raise ValueError(f"File already exists: {file_path}")

        skeleton = (
            f"module {module_name} (\n"
            f"\n"
            f");\n"
            f"\n"
            f"\n"
            f"endmodule\n"
        )
        file_path.write_text(skeleton, encoding="utf-8")

        parser = PyVerilogParser()
        partial = parser.parse_files([str(file_path)])
        new_modules = list(partial.modules)

        project.modules.extend(new_modules)
        try:
            from app.models import SourceFile
        except ImportError:
            from models import SourceFile
        project.source_files.append(SourceFile(path=str(file_path)))

        return {
            "module": module_name,
            "path": str(file_path),
            "created": True,
        }

    def get_unused_modules(self) -> list[str]:
        project = self._require_project()
        all_names = {m.name for m in project.modules}
        instantiated: set[str] = set()
        for mod in project.modules:
            for inst in mod.instances:
                if inst.module_name in all_names:
                    instantiated.add(inst.module_name)
        return sorted(all_names - instantiated)

    def _require_project(self) -> Project:
        if self.project is None:
            raise RuntimeError("No project loaded. Call load_project(folder) first.")
        return self.project
