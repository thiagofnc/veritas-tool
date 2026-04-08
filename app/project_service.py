"""Service layer for loading and querying parsed Verilog projects."""

from typing import Any

try:
    from app.graph_builder import build_hierarchy_graph, build_module_connectivity_graph
    from app.schematic_layout import build_schematic_connectivity_graph
    from app.hierarchy import build_hierarchy_tree, infer_top_modules
    from app.models import ModuleDef, Project
    from app.scanner import scan_verilog_files
    from app.simple_parser import SimpleRegexParser
except ImportError:  # Supports running as: python app/main.py
    from graph_builder import build_hierarchy_graph, build_module_connectivity_graph
    from schematic_layout import build_schematic_connectivity_graph
    from hierarchy import build_hierarchy_tree, infer_top_modules
    from models import ModuleDef, Project
    from scanner import scan_verilog_files
    from simple_parser import SimpleRegexParser


PARSER_CHOICES = ("pyverilog", "simple")


def create_parser_backend(parser_backend: str):
    """Build the parser backend requested by the caller."""
    if parser_backend == "simple":
        return SimpleRegexParser()

    if parser_backend != "pyverilog":
        raise ValueError(f"Unsupported parser backend: {parser_backend}")

    try:
        from app.pyverilog_parser import PyVerilogParser
    except ImportError:
        from pyverilog_parser import PyVerilogParser  # type: ignore

    return PyVerilogParser()


class ProjectService:
    """Thin orchestration layer used by CLI today and UI/API later."""

    def __init__(self, parser_backend: str = "pyverilog") -> None:
        if parser_backend not in PARSER_CHOICES:
            raise ValueError(f"Unsupported parser backend: {parser_backend}")

        self.parser_backend = parser_backend
        self.project: Project | None = None

    def load_project(self, folder: str) -> Project:
        """Scan + parse a project folder and cache the resulting Project."""
        parser = create_parser_backend(self.parser_backend)
        file_paths = scan_verilog_files(folder)
        self.project = parser.parse_files(file_paths)
        return self.project

    def reparse_file(self, file_path: str) -> dict[str, Any]:
        """Re-parse a single source file and merge its modules into the cached project.

        Returns a small report describing the change. If the *set* of module
        names defined in the file changed (modules added or removed), this
        method returns ``{"requires_full_reparse": True}`` and does NOT mutate
        the cached project — the caller should fall back to ``load_project``
        to keep cross-file references consistent.
        """
        project = self._require_project()

        from pathlib import Path as _Path
        target = str(_Path(file_path).resolve())

        old_modules_for_file = [m for m in project.modules if m.source_file == target]
        old_names = {m.name for m in old_modules_for_file}

        parser = create_parser_backend(self.parser_backend)
        partial = parser.parse_files([target])
        new_modules = list(partial.modules)
        new_names = {m.name for m in new_modules}

        if new_names != old_names:
            return {
                "requires_full_reparse": True,
                "old_modules": sorted(old_names),
                "new_modules": sorted(new_names),
            }

        # Same module names — safe to swap in place. Replace each old ModuleDef
        # with its freshly parsed counterpart, preserving overall list order.
        new_by_name = {m.name: m for m in new_modules}
        for idx, mod in enumerate(project.modules):
            if mod.source_file == target and mod.name in new_by_name:
                project.modules[idx] = new_by_name[mod.name]

        return {
            "requires_full_reparse": False,
            "updated_modules": sorted(new_names),
        }

    def get_project(self) -> Project:
        """Return the loaded project, raising if load_project has not run yet."""
        return self._require_project()

    def get_top_candidates(self, include_testbenches: bool = False) -> list[str]:
        """Return inferred top modules from the currently loaded project."""
        project = self._require_project()
        return infer_top_modules(project.modules, include_testbenches=include_testbenches)

    def get_module_names(self) -> list[str]:
        """Return sorted module names from the loaded project."""
        project = self._require_project()
        names = {module.name for module in project.modules}
        return sorted(names)

    def get_module(self, module_name: str) -> ModuleDef:
        """Return one module definition by name."""
        project = self._require_project()
        for module in project.modules:
            if module.name == module_name:
                return module
        raise ValueError(f"Module not found in loaded project: {module_name}")

    def get_hierarchy_tree(self, top_module: str) -> dict[str, Any]:
        """Build a hierarchy tree starting from a selected top module."""
        project = self._require_project()
        self.get_module(top_module)
        return build_hierarchy_tree(project.modules, top_module)

    def get_module_graph(self, module_name: str) -> dict[str, Any]:
        """Build hierarchy graph JSON for a selected module."""
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
        """Build connectivity graph JSON for one module scope."""
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

    def _require_project(self) -> Project:
        if self.project is None:
            raise RuntimeError("No project loaded. Call load_project(folder) first.")
        return self.project


