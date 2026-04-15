import unittest
from pathlib import Path

from app.project_service import ProjectService


class TestSchematicLayout(unittest.TestCase):
    def setUp(self) -> None:
        self.sample_root = Path(__file__).resolve().parent.parent / "sample_projects" / "03_sensor_hub"
        self.service = ProjectService()
        self.service.load_project(str(self.sample_root))

    def test_builds_schematic_layout_for_sensor_hub(self) -> None:
        graph = self.service.get_module_connectivity_graph(
            "system_top",
            port_view=True,
            schematic=True,
            schematic_mode="full",
        )

        self.assertEqual(graph["schema_version"], "1.2-connectivity")
        self.assertEqual(graph["view"], "schematic")
        self.assertEqual(graph["schematic_mode"], "full")
        self.assertEqual(graph["layout"]["engine"], "schematic-v2")
        self.assertTrue(graph["layout"]["regions"])
        self.assertTrue(graph["layout"]["nodes"])
        self.assertTrue(graph["layout"]["ports"])
        self.assertTrue(graph["layout"]["routes"])

        region_roles = {region["role"] for region in graph["layout"]["regions"]}
        self.assertIn("input_interface", region_roles)
        self.assertIn("output_interface", region_roles)
        self.assertTrue({"decode_control", "alu_datapath", "memory_interface"} & region_roles)

    def test_schematic_reduces_clutter_against_baseline(self) -> None:
        graph = self.service.get_module_connectivity_graph(
            "system_top",
            port_view=True,
            schematic=True,
            schematic_mode="full",
        )
        metrics = graph["layout"]["metrics"]
        baseline = metrics["baseline"]
        schematic = metrics["schematic"]

        self.assertLessEqual(schematic["crossings"], baseline["crossings"])
        self.assertLessEqual(schematic["overlaps"], baseline["overlaps"])
        self.assertGreaterEqual(metrics["improvement"]["crossings_reduced_by"], 0)
        self.assertGreaterEqual(metrics["improvement"]["overlaps_reduced_by"], 0)

    def test_layout_modes_filter_route_detail(self) -> None:
        full_graph = self.service.get_module_connectivity_graph(
            "system_top",
            port_view=True,
            schematic=True,
            schematic_mode="full",
        )
        simplified_graph = self.service.get_module_connectivity_graph(
            "system_top",
            port_view=True,
            schematic=True,
            schematic_mode="simplified",
        )
        bus_graph = self.service.get_module_connectivity_graph(
            "system_top",
            port_view=True,
            schematic=True,
            schematic_mode="bus",
        )

        self.assertLess(len(simplified_graph["layout"]["routes"]), len(full_graph["layout"]["routes"]))
        self.assertTrue(bus_graph["layout"]["routes"])
        self.assertTrue(all(route["style_role"] == "bus" for route in bus_graph["layout"]["routes"]))


if __name__ == "__main__":
    unittest.main()
