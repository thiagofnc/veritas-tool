const PROJECT_OPTIONS = [
  {
    label: "Processor",
    folder: "C:\\Users\\costatf\\OneDrive - Rose-Hulman Institute of Technology\\Desktop\\pipelined-processor-l2-2526a-05",
  },
  {
    label: "Linear Chain",
    folder: "C:\\Users\\costatf\\OneDrive - Rose-Hulman Institute of Technology\\Desktop\\Verilog Tool Project\\verilog-tool\\sample_projects\\01_linear_chain",
  },
  {
    label: "Serial Subsystem",
    folder: "C:\\Users\\costatf\\OneDrive - Rose-Hulman Institute of Technology\\Desktop\\Verilog Tool Project\\verilog-tool\\sample_projects\\02_serial_subsystem",
  },
  {
    label: "Module chain",
    folder: "C:\\Users\\costatf\\OneDrive - Rose-Hulman Institute of Technology\\Desktop\\Verilog Tool Project\\verilog-tool\\sample_projects\\04_three_module_chain",
  },
  {
    label: "Stress test",
    folder: "C:\\Users\\costatf\\OneDrive - Rose-Hulman Institute of Technology\\Desktop\\Verilog Tool Project\\verilog-tool\\tests\\stress_test",
  },
  {
    label: "NVDLA",
    folder: "C:\\Users\\costatf\\OneDrive - Rose-Hulman Institute of Technology\\Desktop\\Verilog Tests\\hw",
  },
];

const state = {
  folder: PROJECT_OPTIONS[0].folder,
  parser: "pyverilog",
  tops: [],
  modules: [],
  selectedTop: null,
  selectedModule: null,
  hierarchy: null,
  breadcrumb: [],
  graph: null,
  summary: null,
  selectedNode: null,
  selectedEdge: null,
  cy: null,
  graphMode: "compact",
  aggregateEdges: true,
  showUnknownEdges: false,
  portView: true,
  schematicMode: "simplified",
  lastTapNodeId: null,
  lastTapTs: 0,
  signalTrace: null,
};

const folderInput = document.getElementById("folderInput");
const parserSelect = document.getElementById("parserSelect");
const loadBtn = document.getElementById("loadBtn");
const refreshBtn = document.getElementById("refreshBtn");
const fitBtn = document.getElementById("fitBtn");
const showUnknownToggle = document.getElementById("showUnknownToggle");
const portViewToggle = document.getElementById("portViewToggle");
const statusBadge = document.getElementById("statusBadge");
const topList = document.getElementById("topList");
const hierarchyTree = document.getElementById("hierarchyTree");
const breadcrumbBar = document.getElementById("breadcrumbBar");
const graphTag = document.getElementById("graphTag");
const graphStats = document.getElementById("graphStats");
const statsToggle = document.getElementById("statsToggle");
const graphCanvas = document.getElementById("graphCanvas");
const graphEmpty = document.getElementById("graphEmpty");
const cyGraph = document.getElementById("cyGraph");
const schematicLayer = document.getElementById("schematicLayer");
const hoverTooltip = document.getElementById("hoverTooltip");
const inspector = document.getElementById("inspector");

const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";

if (typeof cytoscape === "function" && typeof cytoscapeElk === "function") {
  cytoscape.use(cytoscapeElk);
}

const LAYOUT_GRID = 20;
const INSTANCE_COLUMN_START = 420;
const INSTANCE_COLUMN_STEP = 620;
const INSTANCE_ROW_GAP = 180;
const INSTANCE_ROW_GAP_DENSE = 140;
const IO_COLUMN_MARGIN = 560;
const INSTANCE_MIN_COLUMN_GAP = 420;
const IO_ROW_GAP = 60;
const PORT_ROW_GAP = 20;
const PORT_SIDE_INSET = 12;
const ROUTE_LANE_GAP = 28;
const ROUTE_FANOUT_GAP = 10;
const ROUTE_PARALLEL_GAP = 6;
const PORT_STUB_LENGTH = 34;
const NETLABEL_WIRE_GAP = 28;
const NETLABEL_ROW_GAP = 20;

function setStatus(text, kind) {
  if (!statusBadge) {
    return;
  }
  statusBadge.textContent = text;
  statusBadge.className = `status ${kind}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function populateProjectOptions() {
  if (!folderInput) {
    return;
  }

  folderInput.innerHTML = "";
  for (const project of PROJECT_OPTIONS) {
    const option = document.createElement("option");
    option.value = project.folder;
    option.textContent = project.label;
    folderInput.appendChild(option);
  }

  folderInput.value = state.folder;
}

function snapToGrid(value, grid = LAYOUT_GRID) {
  return Math.round(value / grid) * grid;
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

function isControlSignalName(name) {
  const normalized = ` ${String(name || "").toLowerCase()} `;
  return ["clk", "clock", "rst", "reset", "enable", "en", "start", "valid", "ready", "busy", "done"]
    .some((token) => normalized.includes(` ${token} `) || normalized.includes(token));
}

function summarizeEdgeNetName(edge) {
  if (edge.nets && edge.nets.length) {
    return edge.nets[0];
  }
  return edge.net || edge.signal_name || "";
}

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Request to ${API_BASE || window.location.origin || "current origin"}${path} failed: ${detail}. Start the FastAPI server and open the app from http://127.0.0.1:8000/.`
    );
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.detail || `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function countByKind(items) {
  const counts = {};
  for (const item of items) {
    const key = item.kind || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function countEdgeSignalClasses(edges) {
  const counts = { bus: 0, wire: 0, mixed: 0, unknown: 0 };
  for (const edge of edges) {
    const key = edge.sig_class || "unknown";
    if (counts[key] === undefined) {
      counts.unknown += 1;
      continue;
    }
    counts[key] += 1;
  }
  return counts;
}

function enforcePortViewMode() {
  // Schematic is always on, graph mode is always compact, aggregate is always true.
  state.graphMode = "compact";
  state.aggregateEdges = true;
}

function getEffectiveGraphMode() {
  return state.portView ? "compact" : state.graphMode;
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll("`", "&#96;");
}

function getEffectiveAggregateEdges() {
  return state.portView ? true : state.aggregateEdges;
}

function getRenderableGraph(graph) {
  if (!graph) {
    return null;
  }

  const edges = (graph.edges || []).filter((edge) => {
    if (state.showUnknownEdges) {
      return true;
    }
    return edge.flow !== "unknown";
  });

  return {
    ...graph,
    nodes: graph.nodes || [],
    edges,
  };
}

function renderTopList() {
  topList.innerHTML = "";

  if (!state.tops.length) {
    const li = document.createElement("li");
    li.textContent = "(none)";
    li.style.color = "#8ea2b1";
    topList.appendChild(li);
    return;
  }

  for (const topName of state.tops) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = topName;
    button.className = topName === state.selectedTop ? "active" : "";
    button.addEventListener("click", async () => {
      try {
        setStatus("Loading top...", "busy");
        await selectTop(topName);
        setStatus("Top loaded", "ok");
      } catch (error) {
        setStatus("Top load failed", "error");
        inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
      }
    });
    li.appendChild(button);
    topList.appendChild(li);
  }
}

function renderBreadcrumb() {
  breadcrumbBar.innerHTML = "";

  if (!state.breadcrumb.length) {
    const placeholder = document.createElement("span");
    placeholder.className = "crumb module";
    placeholder.textContent = "No navigation path";
    breadcrumbBar.appendChild(placeholder);
    return;
  }

  state.breadcrumb.forEach((segment, index) => {
    const crumb = document.createElement("span");
    crumb.className = `crumb ${index % 2 === 0 ? "module" : "instance"}`;
    crumb.textContent = segment;
    breadcrumbBar.appendChild(crumb);
  });
}

function renderHierarchyTree() {
  hierarchyTree.innerHTML = "";

  if (!state.hierarchy) {
    hierarchyTree.innerHTML = '<p class="tree-empty">Load a top module to build hierarchy.</p>';
    return;
  }

  const rootList = document.createElement("ul");
  rootList.className = "tree-root";

  function buildModuleNode(node, crumbs) {
    const item = document.createElement("li");
    item.className = "tree-item";

    const moduleName = node.module || "(unknown)";
    const flags = [];
    if (node.unresolved) flags.push("unresolved");
    if (node.cycle) flags.push("cycle");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-module-btn";
    if (moduleName === state.selectedModule) {
      button.classList.add("active");
    }

    button.textContent = flags.length ? `${moduleName} [${flags.join(",")}]` : moduleName;

    if (!node.unresolved) {
      button.addEventListener("click", async () => {
        try {
          setStatus("Loading graph...", "busy");
          await loadGraph(moduleName, crumbs);
          setStatus("Graph loaded", "ok");
        } catch (error) {
          setStatus("Graph load failed", "error");
          inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
        }
      });
    } else {
      button.disabled = true;
      button.style.opacity = "0.6";
    }

    item.appendChild(button);

    const instances = node.instances || [];
    if (instances.length) {
      const childList = document.createElement("ul");
      childList.className = "tree-group";

      for (const child of instances) {
        const childItem = document.createElement("li");
        childItem.className = "tree-item";

        const line = document.createElement("div");
        line.className = "tree-instance-line";
        line.innerHTML = `
          <span class="tree-instance-chip"></span>
          <span>${escapeHtml(child.instance || "?")} -> ${escapeHtml(child.module || "?")}</span>
        `;
        childItem.appendChild(line);

        if (child.children) {
          const nextCrumbs = [...crumbs, child.instance || "?", child.module || "?"];
          childItem.appendChild(buildModuleNode(child.children, nextCrumbs));
        }

        childList.appendChild(childItem);
      }

      item.appendChild(childList);
    }

    return item;
  }

  rootList.appendChild(buildModuleNode(state.hierarchy, [state.hierarchy.module]));
  hierarchyTree.appendChild(rootList);
}

function renderGraphStats(nodeCounts, edgeCounts, edgeSignalCounts) {
  const nodeKinds = [
    { key: "instance", label: "instance nodes" },
    { key: "instance_port", label: "instance pin nodes" },
    { key: "process_port", label: "process pin nodes" },
    { key: "always", label: "process nodes" },
    { key: "module_io", label: "module I/O nodes" },
    { key: "net", label: "net nodes" },
  ];

  const edgeKinds = [{ key: "connection", label: "connection edges" }];

  const totalNodes = Object.values(nodeCounts).reduce((acc, value) => acc + value, 0);
  const totalEdges = Object.values(edgeCounts).reduce((acc, value) => acc + value, 0);

  const pills = [
    `<span class="stat-pill total-nodes"><strong>Total nodes</strong>${totalNodes}</span>`,
    `<span class="stat-pill total-edges"><strong>Total edges</strong>${totalEdges}</span>`,
  ];

  for (const kind of nodeKinds) {
    pills.push(
      `<span class="stat-pill ${kind.key}"><strong>${kind.label}</strong>${nodeCounts[kind.key] || 0}</span>`
    );
  }

  for (const kind of edgeKinds) {
    pills.push(
      `<span class="stat-pill connection"><strong>${kind.label}</strong>${edgeCounts[kind.key] || 0}</span>`
    );
  }

  pills.push(`<span class="stat-pill bus"><strong>bus edges</strong>${edgeSignalCounts.bus || 0}</span>`);
  pills.push(`<span class="stat-pill wire"><strong>wire edges</strong>${edgeSignalCounts.wire || 0}</span>`);
  if (edgeSignalCounts.mixed) {
    pills.push(`<span class="stat-pill mixed"><strong>mixed edges</strong>${edgeSignalCounts.mixed}</span>`);
  }

  graphStats.classList.remove("empty");
  graphStats.innerHTML = pills.join("");
}

function clearGraphStats() {
  graphStats.classList.add("empty");
  graphStats.innerHTML = "<p>Load a module graph to see a node/edge breakdown.</p>";
}

function ensureCytoscape() {
  if (state.cy) {
    return true;
  }

  if (typeof cytoscape !== "function") {
    setStatus("Cytoscape unavailable", "error");
    graphEmpty.classList.remove("hidden");
    graphEmpty.innerHTML = "<h3>Graph Library Missing</h3><p>Could not load Cytoscape.js.</p>";
    return false;
  }

  state.cy = cytoscape({
    container: cyGraph,
    elements: [],
    style: [
      // ── Base node ───────────────────────────────────────────
      {
        selector: "node",
        style: {
          "background-color": "#3f3f46",
          width: 16,
          height: 16,
          label: "",
          "border-width": 1,
          "border-color": "#111113",
          "font-family": "'IBM Plex Mono', Consolas, Monaco, monospace",
        },
      },
      // ── Instance blocks ─────────────────────────────────────
      {
        selector: 'node[kind = "instance"]',
        style: {
          "background-color": "#141419",
          shape: "rectangle",
          width: "mapData(port_count, 0, 40, 130, 230)",
          height: 56,
          "border-width": 1.5,
          "border-color": "#3b82f6",
          label: "data(label)",
          "font-size": 10,
          "font-weight": "600",
          color: "#e4e4e7",
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": 160,
        },
      },
      {
        selector: 'node[kind = "instance"][port_view = 1]',
        style: {
          shape: "rectangle",
          width: "data(layout_width)",
          height: "data(layout_height)",
          "background-color": "#111116",
          "border-width": 1.5,
          "border-color": "#3b82f6",
          label: "data(label)",
          "font-size": 11,
          "font-weight": "600",
          color: "#e4e4e7",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": 13,
          "text-wrap": "wrap",
          "text-max-width": 220,
          "overlay-padding": 6,
        },
      },
      // ── Ports (instance & process) ──────────────────────────
      {
        selector: 'node[kind = "instance_port"], node[kind = "process_port"]',
        style: {
          shape: "rectangle",
          width: 6,
          height: 6,
          "background-color": "#52525b",
          "border-width": 1,
          "border-color": "#27272a",
          label: "data(display_label)",
          "font-size": 8,
          "font-family": "'IBM Plex Mono', Consolas, monospace",
          color: "#71717a",
          "text-valign": "center",
          "text-wrap": "ellipsis",
          "text-max-width": 72,
          "overlay-padding": 3,
        },
      },
      {
        selector: 'node[kind = "instance_port"][direction = "output"], node[kind = "process_port"][direction = "output"]',
        style: {
          "background-color": "#d97706",
          "border-color": "#451a03",
          "text-halign": "left",
          "text-margin-x": -17,
          color: "#fbbf24",
        },
      },
      {
        selector: 'node[kind = "instance_port"][direction = "input"], node[kind = "process_port"][direction = "input"]',
        style: {
          "background-color": "#2563eb",
          "border-color": "#1e1b4b",
          "text-halign": "right",
          "text-margin-x": 17,
          color: "#60a5fa",
        },
      },
      {
        selector: 'node[kind = "instance_port"][direction = "unknown"], node[kind = "process_port"][direction = "unknown"]',
        style: {
          "background-color": "#52525b",
          "border-color": "#27272a",
          "text-halign": "right",
          "text-margin-x": 17,
          color: "#a1a1aa",
        },
      },
      // ── Module I/O ──────────────────────────────────────────
      {
        selector: 'node[kind = "module_io"]',
        style: {
          "background-color": "#0c1425",
          shape: "tag",
          width: "mapData(bit_width, 1, 64, 100, 156)",
          height: 28,
          label: "data(port_name)",
          color: "#60a5fa",
          "font-size": 10,
          "font-weight": "600",
          "font-family": "'IBM Plex Mono', Consolas, monospace",
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "ellipsis",
          "text-max-width": 92,
          "border-width": 1.5,
          "border-color": "#2563eb",
        },
      },
      {
        selector: 'node[kind = "module_io"][direction = "input"]',
        style: {
          "background-color": "#0c1425",
          "border-color": "#2563eb",
          color: "#60a5fa",
        },
      },
      {
        selector: 'node[kind = "module_io"][direction = "output"]',
        style: {
          "background-color": "#0a1a10",
          "border-color": "#16a34a",
          color: "#4ade80",
        },
      },
      {
        selector: 'node[kind = "module_io_tip_label"]',
        style: {
          shape: "roundrectangle",
          width: "data(label_width)",
          height: 18,
          "background-color": "#0a1a10",
          "border-width": 1,
          "border-color": "#166534",
          label: "data(label)",
          "font-size": 9,
          "font-family": "'IBM Plex Mono', Consolas, monospace",
          "font-weight": "600",
          color: "#4ade80",
          "text-valign": "center",
          "text-halign": "center",
          events: "no",
        },
      },
      // ── Net nodes ───────────────────────────────────────────
      {
        selector: 'node[kind = "net"]',
        style: {
          "background-color": "#a855f7",
          shape: "ellipse",
          width: 12,
          height: 12,
        },
      },
      // ── Gate nodes ──────────────────────────────────────────
      {
        selector: 'node[kind = "gate"]',
        style: {
          "background-color": "#0a1a12",
          shape: "diamond",
          width: 80,
          height: 44,
          "border-width": 1.5,
          "border-color": "#22c55e",
          label: "data(label)",
          "font-size": 9,
          "font-weight": "600",
          "font-family": "'IBM Plex Mono', Consolas, monospace",
          color: "#4ade80",
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": 70,
        },
      },
      // ── Assign nodes ────────────────────────────────────────
      {
        selector: 'node[kind = "assign"]',
        style: {
          "background-color": "#140e24",
          shape: "roundrectangle",
          width: 180,
          height: 32,
          "border-width": 1.5,
          "border-color": "#8b5cf6",
          label: "data(label)",
          "font-size": 9,
          "font-weight": "600",
          "font-family": "'IBM Plex Mono', Consolas, monospace",
          color: "#a78bfa",
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "ellipsis",
          "text-max-width": 170,
        },
      },
      // ── Always blocks ───────────────────────────────────────
      {
        selector: 'node[kind = "always"]',
        style: {
          "background-color": "#111116",
          "background-opacity": 0.95,
          shape: "roundrectangle",
          width: "data(layout_width)",
          height: "data(layout_height)",
          "border-width": 1.5,
          "border-color": "#52525b",
          label: "data(label)",
          "font-size": 11,
          "font-weight": "600",
          color: "#e4e4e7",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": 12,
          "text-wrap": "wrap",
          "text-max-width": 220,
          "overlay-padding": 6,
        },
      },
      {
        selector: 'node[kind = "always"][icon_url]',
        style: {
          "background-image": "data(icon_url)",
          "background-fit": "none",
          "background-clip": "none",
          "background-width": 44,
          "background-height": 44,
          "background-position-x": "50%",
          "background-position-y": "55%",
          "background-image-opacity": 0.6,
        },
      },
      {
        selector: 'node[kind = "always"][process_style = "comb"]',
        style: {
          "background-color": "#0a1610",
          "border-color": "#22c55e",
          "border-style": "solid",
          color: "#e4e4e7",
        },
      },
      {
        selector: 'node[kind = "always"][process_style = "seq"]',
        style: {
          "background-color": "#10101c",
          "border-color": "#6366f1",
          "border-style": "double",
          color: "#e4e4e7",
        },
      },
      {
        selector: 'node[kind = "always"][process_style = "latch"]',
        style: {
          "background-color": "#161410",
          "border-color": "#ca8a04",
          "border-style": "dashed",
          color: "#e4e4e7",
        },
      },
      {
        selector: 'node[kind = "process_port"][direction = "inout"]',
        style: {
          shape: "diamond",
          "background-color": "#4ade80",
          "border-color": "#14532d",
          color: "#86efac",
          "text-halign": "right",
          "text-margin-x": 17,
        },
      },
      // ── Route anchors ───────────────────────────────────────
      {
        selector: 'node[kind = "route_anchor"]',
        style: {
          width: 1,
          height: 1,
          opacity: 0,
          events: "no",
          label: "",
        },
      },
      {
        selector: 'node[kind = "route_anchor"][route_role = "lane_entry"], node[kind = "route_anchor"][route_role = "lane_exit"]',
        style: {
          width: 5,
          height: 5,
          opacity: 0.9,
          "background-color": "#e4e4e7",
          "border-width": 1,
          "border-color": "#111113",
        },
      },
      // ── Port stub anchors ───────────────────────────────────
      {
        selector: 'node[kind = "port_stub_anchor"]',
        style: {
          shape: "rectangle",
          width: 4,
          height: 4,
          opacity: 0.85,
          "background-color": "#3f3f46",
          "border-width": 0,
          events: "no",
          label: "data(port_name)",
          "font-size": 8.5,
          "font-family": "'IBM Plex Mono', Consolas, monospace",
          color: "#71717a",
          "text-valign": "center",
          "text-wrap": "none",
        },
      },
      {
        selector: 'node[kind = "port_stub_anchor"][direction = "output"]',
        style: {
          "background-color": "#92400e",
          "text-halign": "right",
          "text-margin-x": 6,
          color: "#fbbf24",
        },
      },
      {
        selector: 'node[kind = "port_stub_anchor"][direction = "input"]',
        style: {
          "background-color": "#1e3a5f",
          "text-halign": "left",
          "text-margin-x": -6,
          color: "#60a5fa",
        },
      },
      // ── Bus emphasis ────────────────────────────────────────
      {
        selector: "node[is_bus = 1]",
        style: {
          "border-width": 2,
          "border-color": "#60a5fa",
        },
      },
      // ── Selection ───────────────────────────────────────────
      {
        selector: "node:selected",
        style: {
          "border-width": 2.5,
          "border-color": "#22d3ee",
        },
      },
      // ── Edges ───────────────────────────────────────────────
      {
        selector: "edge",
        style: {
          width: 1.5,
          "line-color": "#22c55e",
          "target-arrow-color": "#22c55e",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.65,
          "curve-style": "bezier",
          "control-point-step-size": 40,
        },
      },
      {
        selector: 'edge[port_view = 1]',
        style: {
          "curve-style": "bezier",
          "control-point-step-size": 40,
          "arrow-scale": 0.5,
          "line-opacity": 0.7,
          "line-cap": "butt",
          "source-endpoint": "outside-to-line",
          "target-endpoint": "outside-to-line",
        },
      },
      {
        selector: 'edge[route_segment = 1]',
        style: {
          "curve-style": "straight",
          "target-arrow-shape": "none",
          "source-arrow-shape": "none",
        },
      },
      // ── Net labels ──────────────────────────────────────────
      {
        selector: 'node[kind = "netlabel_node"]',
        style: {
          shape: "roundrectangle",
          width: "data(label_width)",
          height: 16,
          "background-color": "#0a1a10",
          "border-width": 1,
          "border-color": "#166534",
          label: "data(net_label_text)",
          "font-size": 8,
          "font-family": "'IBM Plex Mono', Consolas, monospace",
          color: "#4ade80",
          "text-valign": "center",
          "text-halign": "center",
          "overlay-padding": 3,
        },
      },
      {
        selector: 'edge[netlabel_stub = 1]',
        style: {
          "curve-style": "straight",
          width: 1.2,
          "line-color": "#166534",
          "target-arrow-shape": "none",
          "source-arrow-shape": "none",
          "line-opacity": 0.8,
        },
      },
      {
        selector: 'edge[port_stub = 1]',
        style: {
          "curve-style": "straight",
          "target-arrow-shape": "tee",
          "target-arrow-color": "#3f3f46",
          "arrow-scale": 0.65,
          "source-arrow-shape": "none",
          "line-cap": "butt",
          "line-opacity": 0.75,
          width: 1.2,
        },
      },
      {
        selector: 'edge[route_segment = 1][segment_role = "target"]',
        style: {
          "target-arrow-shape": "triangle",
        },
      },
      // ── Signal class edges ──────────────────────────────────
      {
        selector: 'edge[sig_class = "wire"]',
        style: {
          width: 1.5,
          "line-color": "#22c55e",
          "target-arrow-color": "#22c55e",
        },
      },
      {
        selector: 'edge[sig_class = "bus"]',
        style: {
          width: 2.8,
          "line-color": "#3b82f6",
          "target-arrow-color": "#3b82f6",
          "arrow-scale": 0.8,
        },
      },
      {
        selector: 'edge[sig_class = "mixed"]',
        style: {
          width: 2.4,
          "line-color": "#60a5fa",
          "target-arrow-color": "#60a5fa",
          "arrow-scale": 0.75,
        },
      },
      {
        selector: 'edge[flow = "unknown"]',
        style: {
          "line-style": "dashed",
          "line-color": "#52525b",
          "target-arrow-color": "#52525b",
          "target-arrow-shape": "none",
        },
      },
      // ── Selection & highlight states ────────────────────────
      {
        selector: "edge:selected",
        style: {
          width: 2.8,
          "line-color": "#22d3ee",
          "target-arrow-color": "#22d3ee",
        },
      },
      {
        selector: 'node.netlabel-highlighted[kind = "netlabel_node"]',
        style: {
          "background-color": "#1a1500",
          "border-color": "#f59e0b",
          "border-width": 2,
          color: "#fde68a",
        },
      },
      {
        selector: 'edge.netlabel-highlighted[netlabel_stub = 1]',
        style: {
          "line-color": "#f59e0b",
          width: 1.8,
        },
      },
      {
        selector: 'node.netlabel-endpoint',
        style: {
          "border-color": "#f59e0b",
          "border-width": 2.5,
        },
      },
      // ── Trace highlight (hover) ─────────────────────────────
      {
        selector: "edge.trace-highlight",
        style: {
          "line-color": "#22d3ee",
          "target-arrow-color": "#22d3ee",
          width: 2.8,
          "z-index": 100,
          "line-opacity": 1,
        },
      },
      {
        selector: "edge.relation-highlight",
        style: {
          "line-color": "#22d3ee",
          "target-arrow-color": "#22d3ee",
          width: 2.8,
          "line-opacity": 1,
          "z-index": 110,
        },
      },
      {
        selector: "node.relation-highlight",
        style: {
          "border-color": "#22d3ee",
          "border-width": 2.5,
          "z-index": 110,
        },
      },
      {
        selector: "node.relation-source",
        style: {
          "border-color": "#4ade80",
        },
      },
      {
        selector: "node.relation-sink",
        style: {
          "border-color": "#60a5fa",
        },
      },
      {
        selector: "node.trace-highlight",
        style: {
          "border-color": "#22d3ee",
          "border-width": 2,
          "z-index": 100,
        },
      },
      // ── Signal trace (double-click port) ────────────────────
      {
        selector: "node.signal-trace-upstream",
        style: {
          "border-color": "#4ade80",
          "border-width": 2.5,
          "z-index": 120,
        },
      },
      {
        selector: "node.signal-trace-downstream",
        style: {
          "border-color": "#60a5fa",
          "border-width": 2.5,
          "z-index": 120,
        },
      },
      {
        selector: "node.signal-trace-origin",
        style: {
          "border-color": "#22d3ee",
          "border-width": 3,
          "z-index": 130,
        },
      },
      {
        selector: "edge.signal-trace-upstream",
        style: {
          "line-color": "#4ade80",
          "target-arrow-color": "#4ade80",
          width: 3,
          "line-opacity": 1,
          "z-index": 120,
        },
      },
      {
        selector: "edge.signal-trace-downstream",
        style: {
          "line-color": "#60a5fa",
          "target-arrow-color": "#60a5fa",
          width: 3,
          "line-opacity": 1,
          "z-index": 120,
        },
      },
      {
        selector: "node.signal-trace-dimmed",
        style: {
          opacity: 0.2,
        },
      },
      {
        selector: "edge.signal-trace-dimmed",
        style: {
          opacity: 0.08,
        },
      },
      // ── Search match highlight ──────────────────────────────
      {
        selector: "node.search-match",
        style: {
          "border-color": "#f59e0b",
          "border-width": 2.5,
          "z-index": 150,
        },
      },
      {
        selector: "node.search-active",
        style: {
          "border-color": "#22d3ee",
          "border-width": 3,
          "z-index": 160,
        },
      },
      {
        selector: "node.search-dimmed",
        style: {
          opacity: 0.15,
        },
      },
      {
        selector: "edge.search-dimmed",
        style: {
          opacity: 0.06,
        },
      },
      // ── Bus width label on trunk segments ───────────────────
      {
        selector: 'edge[route_segment = 1][segment_role = "trunk"][bus_width_label]',
        style: {
          label: "data(bus_width_label)",
          "font-size": 8,
          "font-family": "'IBM Plex Mono', Consolas, monospace",
          color: "#60a5fa",
          "text-background-color": "#111113",
          "text-background-opacity": 0.92,
          "text-background-padding": "2px",
          "text-rotation": "autorotate",
          "text-margin-y": -8,
        },
      },
    ],
  });

  function clearRelationHighlights() {
    state.cy.elements(".relation-highlight, .relation-source, .relation-sink").removeClass("relation-highlight relation-source relation-sink");
  }

  // ── Signal Trace ──────────────────────────────────────────────────────
  // Traces a signal forward (downstream) and backward (upstream) through
  // the entire module, crossing instance boundaries via shared net names.
  // Returns { upstream: [...steps], downstream: [...steps] } where each
  // step is { portId, netName, parentInstance, portName, direction }.

  function clearSignalTrace() {
    state.cy.elements(
      ".signal-trace-upstream, .signal-trace-downstream, .signal-trace-origin, .signal-trace-dimmed"
    ).removeClass(
      "signal-trace-upstream signal-trace-downstream signal-trace-origin signal-trace-dimmed"
    );
    state.signalTrace = null;
  }

  function buildTraceGraph() {
    // Build adjacency structures from the original graph edges so we can
    // trace through netlabel connections (which have no Cytoscape edges).
    const graph = state.graph;
    if (!graph) return null;

    // portToParent: port node id → parent instance id
    const portToParent = new Map();
    // parentLabel: instance id → display label
    const parentLabel = new Map();
    // portName: port id → port_name
    const portName = new Map();
    // portDirection: port id → "input" | "output"
    const portDirection = new Map();

    for (const node of graph.nodes || []) {
      if (node.kind === "instance_port" || node.kind === "process_port") {
        const pid = node.parent_node_id || node.instance_node_id || node.process_node_id;
        if (pid) portToParent.set(node.id, pid);
        portName.set(node.id, node.port_name || node.label || "");
        portDirection.set(node.id, (node.direction || "").toLowerCase());
      }
      if (node.kind === "instance" || node.kind === "always" || node.kind === "gate" || node.kind === "assign") {
        parentLabel.set(node.id, node.instance_name || node.label || node.id);
      }
      if (node.kind === "module_io") {
        portName.set(node.id, node.port_name || node.label || "");
        portDirection.set(node.id, (node.direction || "").toLowerCase());
        parentLabel.set(node.id, node.port_name || node.label || "");
      }
    }

    // forward: source port → [{ target, net }]
    // backward: target port → [{ source, net }]
    const forward = new Map();
    const backward = new Map();

    for (const edge of graph.edges || []) {
      const netName = edge.net || edge.signal_name || "";
      if (!forward.has(edge.source)) forward.set(edge.source, []);
      forward.get(edge.source).push({ port: edge.target, net: netName });
      if (!backward.has(edge.target)) backward.set(edge.target, []);
      backward.get(edge.target).push({ port: edge.source, net: netName });
    }

    // Given a port, find sibling ports on the same instance (to cross the
    // instance boundary).  E.g. if we arrive at an instance's input port,
    // the signal flows through the instance to its output ports.
    const siblingsByParent = new Map();
    for (const node of graph.nodes || []) {
      if (node.kind !== "instance_port" && node.kind !== "process_port") continue;
      const pid = node.parent_node_id || node.instance_node_id || node.process_node_id;
      if (!pid) continue;
      if (!siblingsByParent.has(pid)) siblingsByParent.set(pid, []);
      siblingsByParent.get(pid).push(node.id);
    }

    return { forward, backward, portToParent, parentLabel, portName, portDirection, siblingsByParent };
  }

  function traceSignal(startPortId) {
    const tg = buildTraceGraph();
    if (!tg) return null;

    const { forward, backward, portToParent, parentLabel, portName, portDirection, siblingsByParent } = tg;

    function makeStep(portId, netName) {
      const pid = portToParent.get(portId);
      return {
        portId,
        netName: netName || "",
        parentInstance: pid || portId,
        parentLabel: parentLabel.get(pid) || parentLabel.get(portId) || portId,
        portName: portName.get(portId) || portId,
        direction: portDirection.get(portId) || "unknown",
        kind: state.graph.nodes.find((n) => n.id === portId)?.kind || "unknown",
        parentKind: pid ? (state.graph.nodes.find((n) => n.id === pid)?.kind || "unknown") : "module_io",
      };
    }

    // BFS in one direction.  When we arrive at a port, we also cross
    // through its parent instance to sibling ports on the opposite side.
    function bfs(adjacency, crossDirection) {
      const visited = new Set();
      const steps = [];
      const queue = []; // { portId, netName, depth }

      // Seed: direct neighbours of the start port
      const initial = adjacency.get(startPortId) || [];
      for (const { port, net } of initial) {
        if (!visited.has(port)) {
          visited.add(port);
          queue.push({ portId: port, netName: net, depth: 0 });
        }
      }

      while (queue.length) {
        const { portId, netName, depth } = queue.shift();
        const step = makeStep(portId, netName);
        step.depth = depth;
        steps.push(step);

        // Cross through the instance: find sibling ports on the opposite side.
        const pid = portToParent.get(portId);
        if (pid) {
          const siblings = siblingsByParent.get(pid) || [];
          for (const sibId of siblings) {
            if (sibId === portId || visited.has(sibId)) continue;
            const sibDir = portDirection.get(sibId) || "";
            // When tracing forward (downstream): enter input → exit output
            // When tracing backward (upstream): enter output → exit input
            if (sibDir === crossDirection) {
              visited.add(sibId);
              const crossStep = makeStep(sibId, netName);
              crossStep.depth = depth;
              crossStep.crossedInstance = true;
              steps.push(crossStep);

              // Continue from this sibling's connections
              const next = adjacency.get(sibId) || [];
              for (const { port: np, net: nn } of next) {
                if (!visited.has(np)) {
                  visited.add(np);
                  queue.push({ portId: np, netName: nn, depth: depth + 1 });
                }
              }
            }
          }
        }

        // Also follow the adjacency from this port directly (for module_io etc.)
        const directNext = adjacency.get(portId) || [];
        for (const { port: np, net: nn } of directNext) {
          if (!visited.has(np)) {
            visited.add(np);
            queue.push({ portId: np, netName: nn, depth: depth + 1 });
          }
        }
      }

      return steps;
    }

    const downstream = bfs(forward, "output");
    const upstream = bfs(backward, "input");

    return {
      origin: makeStep(startPortId, ""),
      upstream,
      downstream,
    };
  }

  function applySignalTrace(startPortId) {
    clearSignalTrace();
    clearRelationHighlights();
    state.cy.elements(".netlabel-highlighted, .netlabel-endpoint").removeClass("netlabel-highlighted netlabel-endpoint");

    const trace = traceSignal(startPortId);
    if (!trace) return;

    state.signalTrace = trace;

    // Collect all port IDs involved in the trace.
    const tracePortIds = new Set();
    tracePortIds.add(startPortId);
    const upIds = new Set();
    const downIds = new Set();

    for (const step of trace.upstream) {
      tracePortIds.add(step.portId);
      upIds.add(step.portId);
      upIds.add(step.parentInstance);
    }
    for (const step of trace.downstream) {
      tracePortIds.add(step.portId);
      downIds.add(step.portId);
      downIds.add(step.parentInstance);
    }

    // Dim everything first, then highlight the trace path.
    state.cy.elements().addClass("signal-trace-dimmed");

    // Un-dim and highlight trace elements.
    const originNode = state.cy.getElementById(startPortId);
    if (originNode && !originNode.empty()) {
      originNode.removeClass("signal-trace-dimmed").addClass("signal-trace-origin");
      // Also un-dim parent instance
      const pid = originNode.data("parent_node_id") || originNode.data("instance_node_id") || originNode.data("process_node_id");
      if (pid) state.cy.getElementById(pid).removeClass("signal-trace-dimmed").addClass("signal-trace-origin");
    }

    const highlightPort = (portId, direction) => {
      const cls = direction === "upstream" ? "signal-trace-upstream" : "signal-trace-downstream";
      const node = state.cy.getElementById(portId);
      if (node && !node.empty()) {
        node.removeClass("signal-trace-dimmed").addClass(cls);
        // Un-dim parent instance
        const pid = node.data("parent_node_id") || node.data("instance_node_id") || node.data("process_node_id");
        if (pid) {
          state.cy.getElementById(pid).removeClass("signal-trace-dimmed").addClass(cls);
        }
      }
    };

    for (const step of trace.upstream) highlightPort(step.portId, "upstream");
    for (const step of trace.downstream) highlightPort(step.portId, "downstream");

    // Highlight edges and netlabel stubs along the trace path.
    state.cy.edges().forEach((edge) => {
      const src = edge.data("source");
      const tgt = edge.data("target");

      // Routed edges: highlight if both endpoints are in the trace
      if (tracePortIds.has(src) && tracePortIds.has(tgt)) {
        const dir = upIds.has(src) || upIds.has(tgt) ? "upstream" : "downstream";
        edge.removeClass("signal-trace-dimmed").addClass(`signal-trace-${dir}`);
        return;
      }

      // Netlabel stubs: highlight if the connected port is in the trace
      if (edge.data("netlabel_stub")) {
        const connectedPort = edge.data("connected_port") ||
          (tracePortIds.has(src) ? src : tracePortIds.has(tgt) ? tgt : null);
        if (connectedPort && tracePortIds.has(connectedPort)) {
          const dir = upIds.has(connectedPort) ? "upstream" : "downstream";
          edge.removeClass("signal-trace-dimmed").addClass(`signal-trace-${dir}`);
          // Also highlight the netlabel node
          const otherEnd = src === connectedPort ? tgt : src;
          const nlNode = state.cy.getElementById(otherEnd);
          if (nlNode && !nlNode.empty() && nlNode.data("kind") === "netlabel_node") {
            nlNode.removeClass("signal-trace-dimmed").addClass(`signal-trace-${dir}`);
          }
          return;
        }
      }

      // Route segment edges: highlight if source or target port is in trace
      if (edge.data("route_segment")) {
        const edgeSrc = edge.data("source");
        const edgeTgt = edge.data("target");
        // The original source/target are in the edge's data from the graph edge
        // Check if any endpoint of this route segment is a traced port
        if (tracePortIds.has(edgeSrc) || tracePortIds.has(edgeTgt)) {
          const dir = upIds.has(edgeSrc) || upIds.has(edgeTgt) ? "upstream" : "downstream";
          edge.removeClass("signal-trace-dimmed").addClass(`signal-trace-${dir}`);
          // Also un-dim route anchor nodes
          [edgeSrc, edgeTgt].forEach((id) => {
            const n = state.cy.getElementById(id);
            if (n && !n.empty() && n.data("kind") === "route_anchor") {
              n.removeClass("signal-trace-dimmed").addClass(`signal-trace-${dir}`);
            }
          });
        }
      }
    });

    renderSignalTracePanel(trace);
  }

  function highlightNodeRelations(node) {
    clearRelationHighlights();
    node.addClass("relation-highlight");

    const endpoints = node.union(
      state.cy.nodes().filter((candidate) => {
        const parentId = candidate.data("parent_node_id") || candidate.data("instance_node_id") || candidate.data("process_node_id");
        return parentId === node.id();
      })
    );
    endpoints.addClass("relation-highlight");

    const incoming = endpoints.incomers("edge");
    const outgoing = endpoints.outgoers("edge");
    const relatedEdges = incoming.union(outgoing);
    relatedEdges.addClass("relation-highlight");
    relatedEdges.sources().addClass("relation-source");
    relatedEdges.targets().addClass("relation-sink");

    const parentId = node.data("parent_node_id") || node.data("instance_node_id") || node.data("process_node_id");
    if (parentId) {
      state.cy.getElementById(parentId).addClass("relation-highlight");
    }
  }

  function highlightSignalRelations(edge) {
    clearRelationHighlights();
    const netName = summarizeEdgeNetName(edge.data()) || edge.data("signal_name") || edge.id();
    state.cy.edges().forEach((candidate) => {
      const candidateNet = summarizeEdgeNetName(candidate.data()) || candidate.data("signal_name") || candidate.id();
      if (candidateNet !== netName) {
        return;
      }
      candidate.addClass("relation-highlight");
      candidate.sources().addClass("relation-source relation-highlight");
      candidate.targets().addClass("relation-sink relation-highlight");
    });
  }

  state.cy.on("tap", "node", async (event) => {
    const data = event.target.data();
    state.selectedNode = data;
    state.selectedEdge = null;
    state.cy.elements(".netlabel-highlighted, .netlabel-endpoint").removeClass("netlabel-highlighted netlabel-endpoint");
    highlightNodeRelations(event.target);
    renderInspector();

    const now = Date.now();
    const isDoubleTap = state.lastTapNodeId === data.id && now - state.lastTapTs < 360;
    state.lastTapNodeId = data.id;
    state.lastTapTs = now;

    if (isDoubleTap && data.kind === "instance" && data.module_name) {
      if (!state.modules.includes(data.module_name)) {
        setStatus("Cannot drill down", "error");
        return;
      }

      try {
        setStatus("Drilling down...", "busy");
        const nextBreadcrumb = [...state.breadcrumb, data.instance_name || data.label || "inst", data.module_name];
        await loadGraph(data.module_name, nextBreadcrumb);
        setStatus("Drilled down", "ok");
      } catch (error) {
        setStatus("Drill-down failed", "error");
        inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
      }
    }

    if (isDoubleTap && data.kind === "always") {
      showAlwaysDetail(data);
    }

    // Double-click on a port or module_io: trigger signal trace
    if (isDoubleTap && ["instance_port", "process_port", "module_io"].includes(data.kind)) {
      applySignalTrace(data.id);
    }
  });

  // Double-click on a netlabel: trace from its connected port
  state.cy.on("tap", 'node[kind = "netlabel_node"]', (() => {
    let lastNlId = null;
    let lastNlTs = 0;
    return (event) => {
      const data = event.target.data();
      const now = Date.now();
      const isDouble = lastNlId === data.id && now - lastNlTs < 360;
      lastNlId = data.id;
      lastNlTs = now;
      if (isDouble && data.connected_port) {
        applySignalTrace(data.connected_port);
      }
    };
  })());

  state.cy.on("tap", "edge", (event) => {
    state.selectedEdge = event.target.data();
    state.selectedNode = null;

    // Clear previous netlabel highlights
    state.cy.elements(".netlabel-highlighted, .netlabel-endpoint").removeClass("netlabel-highlighted netlabel-endpoint");
    highlightSignalRelations(event.target);

    renderInspector();
  });

  // Click-to-highlight for grouped netlabels: one source label can fan out to multiple targets.
  state.cy.on("tap", 'node[kind = "netlabel_node"]', (event) => {
    state.cy.elements(".netlabel-highlighted, .netlabel-endpoint").removeClass("netlabel-highlighted netlabel-endpoint");

    const traceGroup = event.target.data("netlabel_trace_group") || event.target.data("netlabel_group");
    if (!traceGroup) {
      return;
    }

    state.cy.nodes('[kind = "netlabel_node"]').forEach((node) => {
      if ((node.data("netlabel_trace_group") || node.data("netlabel_group")) === traceGroup) {
        node.addClass("netlabel-highlighted");
        node.connectedEdges('[netlabel_stub = 1]').addClass("netlabel-highlighted");
        const portId = node.data("connected_port");
        if (portId) {
          state.cy.getElementById(portId).addClass("netlabel-endpoint");
        }
      }
    });

    state.cy.edges('[netlabel_stub = 1]').forEach((edge) => {
      if ((edge.data("netlabel_trace_group") || "") === traceGroup) {
        edge.addClass("netlabel-highlighted");
      }
    });
  });

  state.cy.on("tap", (event) => {
    if (event.target === state.cy) {
      state.selectedNode = null;
      state.selectedEdge = null;
      state.cy.elements(".netlabel-highlighted, .netlabel-endpoint").removeClass("netlabel-highlighted netlabel-endpoint");
      clearRelationHighlights();
      clearSignalTrace();
      renderSignalTracePanel(null);
      renderInspector();
    }
  });

  state.cy.on("mouseover", "node", (event) => {
    const data = event.target.data();
    const widthHint = data.bit_width && data.bit_width > 1 ? ` | bus [${data.bit_width}]` : data.is_bus ? " | bus" : " | wire";
    const drillHint = data.kind === "instance" ? '<div class="kind">Double-click to drill into module</div>' : "";
    const extraHint = data.kind === "gate" ? `<div class="kind">Gate type: ${escapeHtml(data.gate_type)}</div>`
      : data.kind === "assign" ? `<div class="kind">${escapeHtml(data.target_signal || "")} = ${escapeHtml(data.expression || "")}</div>`
      : data.kind === "always" ? `<div class="kind">${escapeHtml(data.sensitivity_title || data.title || (data.sensitivity ? `ALWAYS @(${data.sensitivity})` : "ALWAYS"))}</div><div class="kind">reads: ${escapeHtml((data.read_signals || []).slice(0, 4).join(", ") || "-")}</div><div class="kind">writes: ${escapeHtml((data.written_signals || []).slice(0, 4).join(", ") || "-")}</div>`
      : data.kind === "process_port" ? `<div class="kind">process pin | ${escapeHtml(data.direction || "unknown")}</div>`
      : "";
    hoverTooltip.innerHTML = `
      <div>${escapeHtml(data.label || data.id)}</div>
      <div class="kind">${escapeHtml(data.kind || "node")} | ${escapeHtml(data.id)}${escapeHtml(widthHint)}</div>
      ${drillHint}${extraHint}
    `;
    hoverTooltip.style.display = "block";
    const p = event.renderedPosition;
    positionTooltip(p.x, p.y);
  });

  state.cy.on("mouseover", "edge", (event) => {
    const data = event.target.data();
    const netSummary = data.nets?.length
      ? `${data.nets.slice(0, 4).join(", ")}${data.nets.length > 4 ? " ..." : ""}`
      : data.net || "(unnamed net)";
    const countText = data.net_count ? `nets: ${data.net_count}` : "";
    const classText = data.sig_class || "wire";
    const widthText = data.bit_width && data.bit_width > 1 ? `width: ${data.bit_width}` : "width: 1";
    const routingText = data.routing_mode
      ? `display: ${data.routing_mode}${data.routing_reason ? ` | ${data.routing_reason}` : ""}`
      : "";

    hoverTooltip.innerHTML = `
      <div>${escapeHtml(netSummary)}</div>
      <div class="kind">${escapeHtml(data.source)} -> ${escapeHtml(data.target)}</div>
      <div class="kind">${escapeHtml(classText)} | ${escapeHtml(widthText)}${countText ? ` | ${escapeHtml(countText)}` : ""}</div>
      <div class="kind">${escapeHtml(data.flow || "directed")}</div>
      ${routingText ? `<div class="kind">${escapeHtml(routingText)}</div>` : ""}
    `;
    hoverTooltip.style.display = "block";
    const p = event.renderedPosition;
    positionTooltip(p.x, p.y);
  });

  state.cy.on("mousemove", "node, edge", (event) => {
    const p = event.renderedPosition;
    positionTooltip(p.x, p.y);
  });

  state.cy.on("mouseout", "node, edge", hideTooltip);
  state.cy.on("zoom pan", hideTooltip);

  // Signal trace highlighting: hovering a route segment highlights all segments of that route
  state.cy.on("mouseover", "edge[route_id]", (event) => {
    const routeId = event.target.data("route_id");
    if (!routeId) return;
    state.cy.edges(`[route_id = "${routeId}"]`).addClass("trace-highlight");
    state.cy.nodes(`[route_id = "${routeId}"]`).addClass("trace-highlight");
    // Also highlight source and target ports
    const srcId = event.target.data("source");
    const tgtId = event.target.data("target");
    if (srcId) state.cy.getElementById(srcId).addClass("trace-highlight");
    if (tgtId) state.cy.getElementById(tgtId).addClass("trace-highlight");
  });

  state.cy.on("mouseout", "edge[route_id]", (event) => {
    state.cy.elements(".trace-highlight").removeClass("trace-highlight");
  });

  return true;
}

function positionTooltip(renderedX, renderedY) {
  const canvasRect = graphCanvas.getBoundingClientRect();
  const tooltipRect = hoverTooltip.getBoundingClientRect();

  let left = renderedX + 16;
  let top = renderedY + 16;

  const maxLeft = canvasRect.width - tooltipRect.width - 8;
  const maxTop = canvasRect.height - tooltipRect.height - 8;

  if (left > maxLeft) {
    left = Math.max(8, renderedX - tooltipRect.width - 16);
  }

  if (top > maxTop) {
    top = Math.max(8, renderedY - tooltipRect.height - 16);
  }

  hoverTooltip.style.left = `${left}px`;
  hoverTooltip.style.top = `${top}px`;
}

function hideTooltip() {
  hoverTooltip.style.display = "none";
}

function buildCyElements(graph) {
  if (state.portView) {
    return buildPortViewCyElements(graph);
  }

  const nodes = (graph.nodes || []).map((node) => {
    const iconUrl = getAlwaysIconUrl(node);
    return {
      data: {
        ...node,
        is_bus: node.is_bus ? 1 : 0,
        ...(iconUrl ? { icon_url: iconUrl } : {}),
      },
    };
  });

  const edges = (graph.edges || []).map((edge, index) => ({
    data: {
      ...edge,
      is_bus: edge.is_bus ? 1 : 0,
      sig_class: edge.sig_class || "wire",
      port_view: state.portView ? 1 : 0,
      id: `${edge.source}->${edge.target}:${edge.kind || "connection"}:${index}`,
    },
  }));

  return [...nodes, ...edges];
}

function computeEdgeRoutingTypes(graph) {
  const instanceIds = new Set();
  const portToInstance = new Map();
  const portMeta = new Map();

  for (const node of graph.nodes || []) {
    if (node.kind === "instance") {
      instanceIds.add(node.id);
    }
    if ((node.kind === "instance_port" || node.kind === "process_port") && (node.parent_node_id || node.instance_node_id || node.process_node_id)) {
      portToInstance.set(node.id, node.parent_node_id || node.instance_node_id || node.process_node_id);
    }
    if (node.kind === "instance_port" || node.kind === "process_port" || node.kind === "module_io") {
      portMeta.set(node.id, node);
    }
  }

  const indegree = new Map([...instanceIds].map((id) => [id, 0]));
  const outgoing = new Map([...instanceIds].map((id) => [id, new Set()]));

  for (const edge of graph.edges || []) {
    const src = portToInstance.get(edge.source) || (instanceIds.has(edge.source) ? edge.source : null);
    const dst = portToInstance.get(edge.target) || (instanceIds.has(edge.target) ? edge.target : null);
    if (!src || !dst || src === dst || !outgoing.has(src) || outgoing.get(src).has(dst)) {
      continue;
    }
    outgoing.get(src).add(dst);
    indegree.set(dst, (indegree.get(dst) || 0) + 1);
  }

  const level = new Map([...instanceIds].map((id) => [id, 0]));
  const queue = [...instanceIds].filter((id) => !(indegree.get(id) || 0));
  while (queue.length) {
    const curr = queue.shift();
    const currLevel = level.get(curr) || 0;
    for (const next of (outgoing.get(curr) || [])) {
      level.set(next, Math.max(level.get(next) || 0, currLevel + 1));
      indegree.set(next, (indegree.get(next) || 0) - 1);
      if (!(indegree.get(next) || 0)) {
        queue.push(next);
      }
    }
  }

  const pairCounts = new Map();
  const netStats = new Map();
  for (const edge of graph.edges || []) {
    const srcInst = portToInstance.get(edge.source) || (instanceIds.has(edge.source) ? edge.source : null);
    const dstInst = portToInstance.get(edge.target) || (instanceIds.has(edge.target) ? edge.target : null);
    const pairKey = `${srcInst || edge.source}->${dstInst || edge.target}`;
    pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);

    const netName = summarizeEdgeNetName(edge) || `${edge.source}->${edge.target}`;
    const stat = netStats.get(netName) || {
      fanout: 0,
      endpoints: new Set(),
      controlLike: false,
      busLike: false,
    };
    stat.fanout += 1;
    stat.endpoints.add(edge.source);
    stat.endpoints.add(edge.target);
    stat.controlLike = stat.controlLike || isControlSignalName(netName);
    stat.busLike = stat.busLike || Boolean(edge.is_bus || ((edge.bit_width || 1) > 1) || edge.sig_class === "bus");
    netStats.set(netName, stat);
  }

  return (edge) => {
    const srcInst = portToInstance.get(edge.source) || (instanceIds.has(edge.source) ? edge.source : null);
    const dstInst = portToInstance.get(edge.target) || (instanceIds.has(edge.target) ? edge.target : null);
    const netName = summarizeEdgeNetName(edge) || "(unnamed net)";
    const netStat = netStats.get(netName) || { fanout: 1, endpoints: new Set([edge.source, edge.target]), controlLike: false, busLike: false };

    // Module IO boundary: always netlabel so inputs/outputs look clean with wire->label
    if (!srcInst || !dstInst) {
      return { mode: "netlabel", reason: "Boundary connection uses net name for clean I/O appearance." };
    }

    // Feedback or lateral: always netlabel to avoid crossing wires
    const srcLvl = level.get(srcInst) ?? 0;
    const dstLvl = level.get(dstInst) ?? 0;
    if (srcLvl >= dstLvl) {
      return { mode: "netlabel", reason: "Feedback or lateral connection is clearer by shared net name." };
    }

    // Long distance: always netlabel to prevent wires going under modules
    if (dstLvl - srcLvl > 1) {
      return { mode: "netlabel", reason: "Long cross-stage connection uses net name to avoid overlap." };
    }

    // Multi-fanout: always netlabel (no wires for multi-destination signals)
    if (netStat.fanout > 1) {
      return { mode: "netlabel", reason: "Multi-destination signal uses connection by name only." };
    }

    // Single connection, adjacent: use direct wire (no netlabel)
    return { mode: "routed", reason: "Single direct connection uses wire." };
  };
}

function getAlwaysIconUrl(node) {
  if (node.kind !== "always") return undefined;
  const style = node.process_style || "generic";
  const edge = node.edge_polarity || "";
  if (style === "seq") {
    if (edge === "negedge") return "/icons/negedge.png";
    return "/icons/posedge.png"; // posedge, mixed, or default
  }
  if (style === "comb") return "/icons/comb.png";
  if (style === "latch") return "/icons/latch.png";
  return "/icons/always.png";
}

function buildPortViewCyElements(graph) {
  const elements = [];
  const sideCountsByInstance = new Map();
  const connectionCounts = new Map();
  const longestPortNameByInstance = new Map();

  (graph.edges || []).forEach((edge) => {
    connectionCounts.set(edge.source, (connectionCounts.get(edge.source) || 0) + 1);
    connectionCounts.set(edge.target, (connectionCounts.get(edge.target) || 0) + 1);
  });

  for (const node of graph.nodes || []) {
    if ((node.kind === "instance_port" || node.kind === "process_port") && (node.parent_node_id || node.instance_node_id || node.process_node_id)) {
      const parentId = node.parent_node_id || node.instance_node_id || node.process_node_id;
      const counts = sideCountsByInstance.get(parentId) || { input: 0, output: 0, unknown: 0 };
      const direction = String(node.direction || "unknown").toLowerCase();
      if (direction === "output") {
        counts.output += 1;
      } else if (direction === "input") {
        counts.input += 1;
      } else {
        counts.unknown += 1;
      }
      sideCountsByInstance.set(parentId, counts);
      longestPortNameByInstance.set(
        parentId,
        Math.max(longestPortNameByInstance.get(parentId) || 0, String(node.port_name || "").length)
      );
    }
  }

  for (const node of graph.nodes || []) {
    const sideCounts = (node.kind === "instance" || node.kind === "always") ? sideCountsByInstance.get(node.id) : null;
    const maxSidePortCount = sideCounts
      ? Math.max(sideCounts.input, sideCounts.output, sideCounts.unknown)
      : 0;
    const longestPortName = (node.kind === "instance" || node.kind === "always") ? longestPortNameByInstance.get(node.id) || 0 : 0;
    const layoutWidth = (node.kind === "instance" || node.kind === "always")
      ? Math.max(240, Math.min(460, 200 + longestPortName * 7.5))
      : undefined;
    const layoutHeight = (node.kind === "instance" || node.kind === "always")
      ? Math.max(120, 72 + maxSidePortCount * 24)
      : undefined;

    // Compose a two-line label for instance blocks: "instance_name\n(module_name)"
    const composedLabel = node.kind === "instance"
      ? `${node.instance_name || node.label || node.id}\n(${node.module_name || ""})`
      : undefined;

    const portName = String(node.port_name || node.label || "");
    const importantPort = isControlSignalName(portName) || node.is_bus;
    const showPortLabel = importantPort || (connectionCounts.get(node.id) || 0) <= 1;

    const iconUrl = getAlwaysIconUrl(node);
    elements.push({
      data: {
        ...node,
        is_bus: node.is_bus ? 1 : 0,
        port_view: 1,
        ...((node.kind === "instance_port" || node.kind === "process_port") ? { display_label: showPortLabel ? portName : "" } : {}),
        max_side_port_count: maxSidePortCount,
        connection_count: connectionCounts.get(node.id) || 0,
        ...(layoutWidth ? { layout_width: layoutWidth } : {}),
        ...(layoutHeight ? { layout_height: layoutHeight } : {}),
        ...(composedLabel ? { label: composedLabel } : {}),
        ...(iconUrl ? { icon_url: iconUrl } : {}),
      },
    });

    if (node.kind === "module_io") {
      // Only create tip label if the module_io has no connections
      // (connected module_io nodes get a netlabel instead, avoiding duplicate labels)
      const hasConnections = (connectionCounts.get(node.id) || 0) > 0;
      if (!hasConnections) {
        elements.push({
          data: {
            id: `module-io-label:${node.id}`,
            kind: "module_io_tip_label",
            label: node.port_name || node.label || node.id,
            label_width: Math.max(56, String(node.port_name || node.label || node.id).length * 8 + 16),
            anchor_for: node.id,
            direction: String(node.direction || "unknown").toLowerCase(),
            port_view: 1,
          },
        });
      }
    }
  }

  const portStubNodes = (graph.nodes || []).filter((node) => {
    if (!["instance_port", "process_port", "module_io"].includes(node.kind)) {
      return false;
    }
    return (connectionCounts.get(node.id) || 0) === 0;
  });

  portStubNodes.forEach((node, index) => {
    const stubId = `stub:${node.id}:${index}`;
    elements.push({
      data: {
        id: `${stubId}:anchor`,
        label: "",
        kind: "port_stub_anchor",
        stub_for: node.id,
        direction: String(node.direction || "unknown").toLowerCase(),
        port_name: node.port_name || node.label || "",
        sig_class: node.sig_class || (node.is_bus ? "bus" : "wire"),
        is_bus: node.is_bus ? 1 : 0,
        port_view: 1,
      },
    });
    elements.push({
      data: {
        id: `${stubId}:edge`,
        source: node.id,
        target: `${stubId}:anchor`,
        kind: "connection",
        port_stub: 1,
        port_view: 1,
        sig_class: node.sig_class || (node.is_bus ? "bus" : "wire"),
        is_bus: node.is_bus ? 1 : 0,
        flow: "stub",
        signal_name: node.port_name || node.label || "",
        source_port: node.port_name || node.label || "",
        target_port: node.port_name || node.label || "",
      },
    });
  });

  const classifyEdge = computeEdgeRoutingTypes(graph);

  // --- Two-pass approach: detect ports with mixed modes and force netlabel ---
  // Pass 1: classify all edges and track which target ports get which modes.
  const edgeDecisions = (graph.edges || []).map((edge) => ({
    edge,
    decision: classifyEdge(edge),
  }));

  // Collect routing modes and edge count per target port.
  const targetPortModes = new Map();
  const targetPortEdgeCount = new Map();
  edgeDecisions.forEach(({ edge, decision }) => {
    const modes = targetPortModes.get(edge.target) || new Set();
    modes.add(decision.mode);
    targetPortModes.set(edge.target, modes);
    targetPortEdgeCount.set(edge.target, (targetPortEdgeCount.get(edge.target) || 0) + 1);
  });

  // Force netlabel at a target port if:
  // - It receives both netlabel and routed connections (mixed modes), OR
  // - It receives connections from multiple different edges (multiple signals)
  // This prevents a visible wire AND a net-label arriving at the same port.
  const forceNetlabelTargets = new Set();
  targetPortModes.forEach((modes, targetId) => {
    if (modes.size > 1 || (targetPortEdgeCount.get(targetId) || 0) > 1) {
      forceNetlabelTargets.add(targetId);
    }
  });

  const sourceNetlabels = new Map();
  const targetNetlabels = new Map();

  edgeDecisions.forEach(({ edge, decision }, index) => {
    let routingType = decision.mode;

    // Override: if this target port already has a netlabel connection, force
    // this edge to netlabel too so we don't get mixed wire+label at one port.
    if (routingType === "routed" && forceNetlabelTargets.has(edge.target)) {
      routingType = "netlabel";
    }

    if (routingType === "netlabel") {
      const firstName = (edge.nets && edge.nets.length) ? edge.nets[0] : (edge.net || "?");
      const labelText = (edge.nets && edge.nets.length > 1)
        ? `${firstName} +${edge.nets.length - 1}`
        : firstName;
      const labelWidth = Math.max(50, labelText.length * 7 + 14);
      const traceGroup = `nettrace:${edge.source}:${firstName}`;
      const sourceKey = `${edge.source}:${firstName}`;

      if (!sourceNetlabels.has(sourceKey)) {
        const srcLabelId = `netlabel:${index}:src`;
        sourceNetlabels.set(sourceKey, srcLabelId);
        elements.push({
          data: {
            id: srcLabelId,
            kind: "netlabel_node",
            net_label_text: labelText,
            netlabel_group: firstName,
            netlabel_trace_group: traceGroup,
            netlabel_role: "source",
            label_width: labelWidth,
            connected_port: edge.source,
            routing_mode: routingType,
            routing_reason: decision.reason,
            port_view: 1,
          },
        });
        elements.push({
          data: {
            id: `${srcLabelId}:edge`,
            source: edge.source,
            target: srcLabelId,
            kind: "connection",
            netlabel_stub: 1,
            netlabel_trace_group: traceGroup,
            port_view: 1,
            routing_mode: routingType,
            routing_reason: decision.reason,
            sig_class: edge.sig_class || "wire",
            is_bus: edge.is_bus ? 1 : 0,
          },
        });
      }

      // Deduplicate target netlabels by target port + signal name
      const targetKey = `${edge.target}:${firstName}`;
      if (!targetNetlabels.has(targetKey)) {
        targetNetlabels.set(targetKey, true);
        const tgtLabelId = `netlabel:${index}:tgt`;
        elements.push({
          data: {
            id: tgtLabelId,
            kind: "netlabel_node",
            net_label_text: labelText,
            netlabel_group: firstName,
            netlabel_trace_group: traceGroup,
            netlabel_role: "target",
            label_width: labelWidth,
            connected_port: edge.target,
            routing_mode: routingType,
            routing_reason: decision.reason,
            port_view: 1,
          },
        });
        elements.push({
          data: {
            id: `${tgtLabelId}:edge`,
            source: tgtLabelId,
            target: edge.target,
            kind: "connection",
            netlabel_stub: 1,
            netlabel_trace_group: traceGroup,
            port_view: 1,
            routing_mode: routingType,
            routing_reason: decision.reason,
            sig_class: edge.sig_class || "wire",
            is_bus: edge.is_bus ? 1 : 0,
          },
        });
      }
      return;
    }

    // Routed: create 4 anchor nodes + 5 straight segment edges
    const baseId = `route:${index}`;
    const routeMeta = {
      ...edge,
      is_bus: edge.is_bus ? 1 : 0,
      sig_class: edge.sig_class || "wire",
      port_view: 1,
      route_segment: 1,
      routing_mode: routingType,
      routing_reason: decision.reason,
      route_id: baseId,
      route_index: index,
    };

    ["a", "b", "c", "d"].forEach((suffix) => {
      elements.push({
        data: {
          id: `${baseId}:${suffix}`,
          label: "",
          kind: "route_anchor",
          route_id: baseId,
          route_index: index,
          sig_class: routeMeta.sig_class,
          is_bus: routeMeta.is_bus,
          bit_width: routeMeta.bit_width,
          port_view: 1,
        },
      });
    });

    const busWidthLabel = edge.is_bus && edge.bit_width > 1 ? `[${edge.bit_width - 1}:0]` : undefined;

    [
      { id: `${baseId}:seg0`, source: edge.source, target: `${baseId}:a`, segment_role: "source" },
      { id: `${baseId}:seg1`, source: `${baseId}:a`, target: `${baseId}:b`, segment_role: "vertical_entry" },
      { id: `${baseId}:seg2`, source: `${baseId}:b`, target: `${baseId}:c`, segment_role: "trunk", ...(busWidthLabel ? { bus_width_label: busWidthLabel } : {}) },
      { id: `${baseId}:seg3`, source: `${baseId}:c`, target: `${baseId}:d`, segment_role: "vertical_exit" },
      { id: `${baseId}:seg4`, source: `${baseId}:d`, target: edge.target, segment_role: "target" },
    ].forEach((segment) => {
      elements.push({ data: { ...routeMeta, ...segment } });
    });
  });

  return elements;
}

function getLayoutRoots(graph) {
  const nodes = (graph.nodes || []).filter((node) => !["instance_port", "process_port"].includes(node.kind));
  const edges = graph.edges || [];

  const incoming = new Map();
  for (const node of nodes) {
    incoming.set(node.id, 0);
  }

  for (const edge of edges) {
    if (!incoming.has(edge.target)) {
      continue;
    }
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
  }

  const ioInputs = nodes
    .filter((node) => node.kind === "module_io" && node.direction === "input")
    .map((node) => node.id);
  if (ioInputs.length) {
    return ioInputs;
  }

  const zeroIncoming = nodes.filter((node) => (incoming.get(node.id) || 0) === 0).map((node) => node.id);
  if (zeroIncoming.length) {
    return zeroIncoming;
  }

  return nodes.length ? [nodes[0].id] : [];
}

function endpointToInstanceId(nodeId) {
  if (!state.cy || !nodeId) {
    return null;
  }

  const node = state.cy.getElementById(nodeId);
  if (!node || node.empty()) {
    return null;
  }

  const kind = node.data("kind");
  if (kind === "instance" || kind === "always") {
    return node.id();
  }

  if (kind === "instance_port" || kind === "process_port") {
    return node.data("parent_node_id") || node.data("instance_node_id") || node.data("process_node_id") || null;
  }

  return null;
}

function computePortViewInstanceLevels(graph) {
  const instanceIds = state.cy.nodes('[kind = "instance"]').map((node) => node.id());
  const indegree = new Map(instanceIds.map((id) => [id, 0]));
  const outgoing = new Map(instanceIds.map((id) => [id, new Set()]));

  for (const edge of graph.edges || []) {
    const srcInst = endpointToInstanceId(edge.source);
    const dstInst = endpointToInstanceId(edge.target);
    if (!srcInst || !dstInst || srcInst === dstInst) {
      continue;
    }

    const neighbors = outgoing.get(srcInst);
    if (!neighbors || neighbors.has(dstInst)) {
      continue;
    }

    neighbors.add(dstInst);
    indegree.set(dstInst, (indegree.get(dstInst) || 0) + 1);
  }

  const level = new Map(instanceIds.map((id) => [id, 0]));
  const queue = instanceIds.filter((id) => (indegree.get(id) || 0) === 0).sort();

  while (queue.length) {
    const current = queue.shift();
    const currentLevel = level.get(current) || 0;
    const neighbors = Array.from(outgoing.get(current) || []).sort();

    for (const nextId of neighbors) {
      level.set(nextId, Math.max(level.get(nextId) || 0, currentLevel + 1));
      indegree.set(nextId, (indegree.get(nextId) || 0) - 1);
      if ((indegree.get(nextId) || 0) === 0) {
        queue.push(nextId);
      }
    }
    queue.sort();
  }

  const unresolved = instanceIds.filter((id) => (indegree.get(id) || 0) > 0).sort();
  for (const nodeId of unresolved) {
    let inferredLevel = 0;
    outgoing.forEach((targets, srcId) => {
      if (targets.has(nodeId)) {
        inferredLevel = Math.max(inferredLevel, (level.get(srcId) || 0) + 1);
      }
    });
    level.set(nodeId, Math.max(level.get(nodeId) || 0, inferredLevel));
  }

  return level;
}

function getNodePositionY(nodeId, resolveToInstance = false) {
  if (!state.cy || !nodeId) {
    return null;
  }

  const lookupId = resolveToInstance ? endpointToInstanceId(nodeId) || nodeId : nodeId;
  const node = state.cy.getElementById(lookupId);
  if (!node || node.empty()) {
    return null;
  }

  return node.position("y");
}

function getAverageConnectedY(nodeId, graph, resolveToInstance = false) {
  const ys = [];

  for (const edge of graph.edges || []) {
    let otherId = null;
    if (edge.source === nodeId) {
      otherId = edge.target;
    } else if (edge.target === nodeId) {
      otherId = edge.source;
    }

    if (!otherId) {
      continue;
    }

    const y = getNodePositionY(otherId, resolveToInstance);
    if (y !== null) {
      ys.push(y);
    }
  }

  if (!ys.length) {
    return null;
  }

  return ys.reduce((sum, value) => sum + value, 0) / ys.length;
}

function getNodeHalfSize(node) {
  return {
    halfWidth: Math.max(12, node.outerWidth() / 2),
    halfHeight: Math.max(12, node.outerHeight() / 2),
  };
}

function stackNodesVertically(nodes, centerY, minGap = 28) {
  const ordered = [...nodes].filter((node) => node && !node.empty());
  if (!ordered.length) {
    return;
  }

  const totalHeight = ordered.reduce((sum, node) => sum + getNodeHalfSize(node).halfHeight * 2, 0)
    + Math.max(0, ordered.length - 1) * minGap;

  let cursorY = centerY - totalHeight / 2;
  ordered.forEach((node) => {
    const { halfHeight } = getNodeHalfSize(node);
    cursorY += halfHeight;
    node.position({ x: node.position("x"), y: cursorY });
    cursorY += halfHeight + minGap;
  });
}

function spreadNodesVertically(nodes, minGap = 28, anchorY = null) {
  const ordered = [...nodes]
    .filter((node) => node && !node.empty())
    .sort((left, right) => left.position("y") - right.position("y"));

  if (anchorY !== null) {
    stackNodesVertically(ordered, anchorY, minGap);
    return;
  }

  let lastBottom = null;
  for (const node of ordered) {
    const { halfHeight } = getNodeHalfSize(node);
    let centerY = node.position("y");
    const topY = centerY - halfHeight;

    if (lastBottom !== null && topY < lastBottom + minGap) {
      centerY = lastBottom + minGap + halfHeight;
      node.position({ x: node.position("x"), y: centerY });
    }

    lastBottom = centerY + halfHeight;
  }
}

function distributeColumns(columnEntries, startX, minGap = 300) {
  let nextLeft = startX;

  columnEntries.forEach((entry) => {
    const widths = entry.nodes.map((node) => node.outerWidth());
    const columnWidth = widths.length ? Math.max(...widths) : 0;
    const centerX = nextLeft + columnWidth / 2;
    entry.nodes.forEach((node) => {
      node.position({ x: centerX, y: node.position("y") });
    });
    nextLeft += columnWidth + minGap;
  });
}

function orderInstancesWithinLevels(graph, groupedByLevel, levelByInstance) {
  const levels = Array.from(groupedByLevel.keys()).sort((a, b) => a - b);
  const incoming = new Map();
  const outgoing = new Map();

  state.cy.nodes('[kind = "instance"]').forEach((node) => {
    incoming.set(node.id(), new Set());
    outgoing.set(node.id(), new Set());
  });

  for (const edge of graph.edges || []) {
    const srcInst = endpointToInstanceId(edge.source);
    const dstInst = endpointToInstanceId(edge.target);
    if (!srcInst || !dstInst || srcInst === dstInst) {
      continue;
    }

    outgoing.get(srcInst)?.add(dstInst);
    incoming.get(dstInst)?.add(srcInst);
  }

  const ordered = new Map();
  levels.forEach((level) => {
    const group = [...(groupedByLevel.get(level) || [])].sort((a, b) => String(a.data("instance_name") || a.data("label") || a.id()).localeCompare(
      String(b.data("instance_name") || b.data("label") || b.id())
    ));
    ordered.set(level, group);
  });

  const buildOrderIndex = () => {
    const index = new Map();
    levels.forEach((level) => {
      (ordered.get(level) || []).forEach((node, position) => {
        index.set(node.id(), position);
      });
    });
    return index;
  };

  const scoreNode = (_node, neighbors, index) => {
    const scores = neighbors
      .map((neighborId) => index.get(neighborId))
      .filter((value) => value !== undefined);

    if (!scores.length) {
      return null;
    }

    return scores.reduce((sum, value) => sum + value, 0) / scores.length;
  };

  for (let pass = 0; pass < 3; pass += 1) {
    let index = buildOrderIndex();
    for (const level of levels) {
      const group = ordered.get(level) || [];
      group.sort((left, right) => {
        const leftScore = scoreNode(left, Array.from(incoming.get(left.id()) || []).filter((id) => (levelByInstance.get(id) || 0) < level), index);
        const rightScore = scoreNode(right, Array.from(incoming.get(right.id()) || []).filter((id) => (levelByInstance.get(id) || 0) < level), index);

        if (leftScore !== null && rightScore !== null && leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        if (leftScore !== null && rightScore === null) {
          return -1;
        }
        if (leftScore === null && rightScore !== null) {
          return 1;
        }
        return (index.get(left.id()) || 0) - (index.get(right.id()) || 0);
      });
    }

    index = buildOrderIndex();
    [...levels].reverse().forEach((level) => {
      const group = ordered.get(level) || [];
      group.sort((left, right) => {
        const leftScore = scoreNode(left, Array.from(outgoing.get(left.id()) || []).filter((id) => (levelByInstance.get(id) || 0) > level), index);
        const rightScore = scoreNode(right, Array.from(outgoing.get(right.id()) || []).filter((id) => (levelByInstance.get(id) || 0) > level), index);

        if (leftScore !== null && rightScore !== null && leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        if (leftScore !== null && rightScore === null) {
          return -1;
        }
        if (leftScore === null && rightScore !== null) {
          return 1;
        }
        return (index.get(left.id()) || 0) - (index.get(right.id()) || 0);
      });
    });
  }

  return { levels, ordered };
}

function placeInstancePortNodes(graph) {
  if (!state.cy) {
    return;
  }

  const portNodes = state.cy.nodes('[kind = "instance_port"], [kind = "process_port"]');
  if (!portNodes.length) {
    return;
  }

  const grouped = new Map();
  portNodes.forEach((portNode) => {
    const parentId = portNode.data("parent_node_id") || portNode.data("instance_node_id") || portNode.data("process_node_id");
    if (!parentId) {
      return;
    }

    if (!grouped.has(parentId)) {
      grouped.set(parentId, []);
    }
    grouped.get(parentId).push(portNode);
  });

  const sortPorts = (ports) => [...ports].sort((left, right) => {
    const leftY = getAverageConnectedY(left.id(), graph, false) ?? getAverageConnectedY(left.id(), graph, true);
    const rightY = getAverageConnectedY(right.id(), graph, false) ?? getAverageConnectedY(right.id(), graph, true);

    if (leftY !== null && rightY !== null && leftY !== rightY) {
      return leftY - rightY;
    }
    if (leftY !== null && rightY === null) {
      return -1;
    }
    if (leftY === null && rightY !== null) {
      return 1;
    }
    return naturalCompare(left.data("port_name") || left.id(), right.data("port_name") || right.id());
  });

  grouped.forEach((ports, parentId) => {
    const instanceNode = state.cy.getElementById(parentId);
    if (!instanceNode || instanceNode.empty()) {
      return;
    }

    const center = instanceNode.position();
    const halfWidth = Math.max(44, instanceNode.outerWidth() / 2);
    const halfHeight = Math.max(22, instanceNode.outerHeight() / 2);

    const leftPorts = [];
    const rightPorts = [];

    for (const portNode of ports) {
      const direction = (portNode.data("direction") || "unknown").toLowerCase();
      if (direction === "output") {
        rightPorts.push(portNode);
      } else {
        leftPorts.push(portNode);
      }
    }

    const placeSide = (sidePorts, xOffset, inset = 0) => {
      if (!sidePorts.length) {
        return;
      }

      const ordered = sortPorts(sidePorts);
      const step = Math.max(PORT_ROW_GAP, snapToGrid((halfHeight * 1.75) / Math.max(1, ordered.length + 1)));
      const totalHeight = Math.max(0, (ordered.length - 1) * step);
      const startY = snapToGrid(center.y - totalHeight / 2);
      ordered.forEach((node, idx) => {
        node.position({
          x: center.x + xOffset + inset,
          y: startY + idx * step,
        });
      });
    };

    placeSide(leftPorts, -halfWidth, 0);
    placeSide(rightPorts, halfWidth, 0);
  });
}

function getPortStubDirection(node) {
  const kind = String(node.data("kind") || "");
  const direction = String(node.data("direction") || "unknown").toLowerCase();

  if (direction === "output") {
    return 1;
  }
  if (direction === "input") {
    return -1;
  }
  if (kind === "module_io") {
    return node.position("x") <= (cyGraph.clientWidth || 0) / 2 ? -1 : 1;
  }
  return -1;
}

function placeUnconnectedPortStubs() {
  if (!state.cy) {
    return;
  }

  state.cy.nodes('[kind = "port_stub_anchor"]').forEach((anchor) => {
    const portId = anchor.data("stub_for");
    const portNode = state.cy.getElementById(portId);
    if (!portNode || portNode.empty()) {
      return;
    }

    const side = getPortStubDirection(portNode);
    anchor.position({
      x: snapToGrid(portNode.position("x") + side * PORT_STUB_LENGTH),
      y: snapToGrid(portNode.position("y")),
    });
  });
}

function placeNetlabelNodes() {
  if (!state.cy) {
    return;
  }

  const netlabelNodes = state.cy.nodes('[kind = "netlabel_node"]');

  // Remove orphaned netlabels whose connected port doesn't exist in the graph.
  const orphans = [];
  netlabelNodes.forEach((node) => {
    const portId = node.data("connected_port");
    const portNode = state.cy.getElementById(portId);
    if (!portNode || portNode.empty()) {
      orphans.push(node);
    }
  });
  orphans.forEach((node) => {
    node.connectedEdges().remove();
    node.remove();
  });

  // Re-query after cleanup.
  const remainingNetlabels = state.cy.nodes('[kind = "netlabel_node"]');
  const placements = [];
  remainingNetlabels.forEach((node) => {
    const portId = node.data("connected_port");
    const portNode = state.cy.getElementById(portId);
    if (!portNode || portNode.empty()) {
      return;
    }

    const portPos = portNode.position();
    const portDirection = String(portNode.data("direction") || "unknown").toLowerCase();
    const portKind = String(portNode.data("kind") || "");
    const role = String(node.data("netlabel_role") || "target");

    let side;
    if (portKind === "module_io") {
      // Module IO sides are inverted: inputs feed data rightward (label on right),
      // outputs receive data from left (label on left)
      if (portDirection === "input") {
        side = 1;   // netlabel to the right of input port
      } else if (portDirection === "output") {
        side = -1;  // netlabel to the left of output port
      } else {
        side = portPos.x <= (cyGraph.clientWidth || 0) / 2 ? 1 : -1;
      }
    } else if (portDirection === "output") {
      side = 1;
    } else if (portDirection === "input") {
      side = -1;
    } else {
      side = -1;
    }

    const ownerId = portKind === "instance_port"
      ? (portNode.data("instance_node_id") || portId)
      : portId;
    const labelWidth = node.data("label_width") || 50;
    const halfWidth = Math.max(0, portNode.outerWidth() / 2);
    const portEdgeX = portPos.x + side * halfWidth;

    placements.push({
      node,
      ownerId,
      role,
      side,
      portX: portPos.x,
      portEdgeX,
      portY: portPos.y,
      idealY: portPos.y,
      labelWidth,
      x: portEdgeX + side * (labelWidth / 2 + NETLABEL_WIRE_GAP),
      y: portPos.y,
      groupKey: `${ownerId}:${side}`,
    });
  });

  const groups = new Map();
  for (const placement of placements) {
    if (!groups.has(placement.groupKey)) {
      groups.set(placement.groupKey, []);
    }
    groups.get(placement.groupKey).push(placement);
  }

  groups.forEach((group) => {
    group.sort((a, b) => {
      if (a.idealY !== b.idealY) {
        return a.idealY - b.idealY;
      }
      if (a.role !== b.role) {
        return a.role === "source" ? -1 : 1;
      }
      return String(a.node.id()).localeCompare(String(b.node.id()), undefined, { numeric: true, sensitivity: "base" });
    });

    let nextY = -Infinity;
    for (const placement of group) {
      placement.y = nextY === -Infinity
        ? placement.idealY
        : Math.max(placement.idealY, nextY + NETLABEL_ROW_GAP);
      nextY = placement.y;
    }

    for (let index = group.length - 2; index >= 0; index -= 1) {
      const current = group[index];
      const below = group[index + 1];
      const maxAllowed = below.y - NETLABEL_ROW_GAP;
      if (current.y > maxAllowed) {
        current.y = maxAllowed;
      }
    }

    const alignedEdgeX = group[0]?.side > 0
      ? Math.max(...group.map((placement) => placement.portEdgeX)) + NETLABEL_WIRE_GAP
      : Math.min(...group.map((placement) => placement.portEdgeX)) - NETLABEL_WIRE_GAP;

    group.forEach((placement) => {
      placement.x = placement.side > 0
        ? alignedEdgeX + placement.labelWidth / 2
        : alignedEdgeX - placement.labelWidth / 2;
    });
  });

  for (const placement of placements) {
    placement.node.position({
      x: snapToGrid(placement.x),
      y: snapToGrid(placement.y),
    });
  }
}

function placeModuleIoTipLabels() {
  if (!state.cy) {
    return;
  }

  state.cy.nodes('[kind = "module_io_tip_label"]').forEach((labelNode) => {
    const anchorId = labelNode.data("anchor_for");
    const anchorNode = state.cy.getElementById(anchorId);
    if (!anchorNode || anchorNode.empty()) {
      return;
    }

    const direction = String(labelNode.data("direction") || "unknown").toLowerCase();
    const side = direction === "output" ? -1 : 1;
    const halfWidth = Math.max(40, anchorNode.outerWidth() / 2);
    const labelWidth = labelNode.data("label_width") || 56;

    labelNode.position({
      x: snapToGrid(anchorNode.position("x") + side * (halfWidth + labelWidth / 2 - 6)),
      y: snapToGrid(anchorNode.position("y")),
    });
  });
}

function placeModuleIoNodes(graph, leftX, rightX) {
  if (!state.cy) {
    return;
  }

  const ioNodes = state.cy.nodes('[kind = "module_io"]');
  if (!ioNodes.length) {
    return;
  }

  const placeList = (nodes, x, fallbackStartY) => {
    const enriched = nodes
      .map((node) => ({
        node,
        y: getAverageConnectedY(node.id(), graph, true) ?? getAverageConnectedY(node.id(), graph, false),
        name: String(node.data("port_name") || node.data("label") || node.id()),
      }))
      .sort((a, b) => {
        if (a.y !== null && b.y !== null && a.y !== b.y) {
          return a.y - b.y;
        }
        if (a.y !== null && b.y === null) {
          return -1;
        }
        if (a.y === null && b.y !== null) {
          return 1;
        }
        return naturalCompare(a.name, b.name);
      });

    let nextY = snapToGrid(fallbackStartY);
    for (const item of enriched) {
      let y = item.y === null ? nextY : snapToGrid(item.y);
      if (y < nextY) {
        y = nextY;
      }

      item.node.position({ x: snapToGrid(x), y });
      nextY = y + IO_ROW_GAP;
    }
  };

  const inputNodes = [];
  const outputNodes = [];
  const unknownNodes = [];

  ioNodes.forEach((node) => {
    const direction = String(node.data("direction") || "unknown").toLowerCase();
    if (direction === "input") {
      inputNodes.push(node);
    } else if (direction === "output") {
      outputNodes.push(node);
    } else {
      unknownNodes.push(node);
    }
  });

  placeList(inputNodes, leftX, 120);
  placeList(outputNodes, rightX, 120);
  placeList(unknownNodes, leftX, 120 + inputNodes.length * IO_ROW_GAP + LAYOUT_GRID);
  placeModuleIoTipLabels();

  const centerY = snapToGrid((cyGraph.clientHeight || 760) / 2);
  spreadNodesVertically(inputNodes, LAYOUT_GRID, centerY);
  spreadNodesVertically(outputNodes, LAYOUT_GRID, centerY);
  spreadNodesVertically(unknownNodes, LAYOUT_GRID, centerY + Math.max(80, inputNodes.length * LAYOUT_GRID));
}

function placePortViewRoutes(graph) {
  if (!state.cy) {
    return;
  }

  const routes = (graph.edges || []).map((edge, index) => {
    const sourceNode = state.cy.getElementById(edge.source);
    const targetNode = state.cy.getElementById(edge.target);
    if (!sourceNode || sourceNode.empty() || !targetNode || targetNode.empty()) {
      return null;
    }

    const sourcePos = sourceNode.position();
    const targetPos = targetNode.position();
    return {
      edge,
      index,
      sourceNode,
      targetNode,
      sourcePos,
      targetPos,
      forward: sourcePos.x <= targetPos.x,
      preferredY: snapToGrid((sourcePos.y + targetPos.y) / 2),
    };
  }).filter(Boolean);

  if (!routes.length) {
    return;
  }

  const allYs = routes.flatMap((route) => [route.sourcePos.y, route.targetPos.y]);
  const minY = Math.min(...allYs);
  const maxY = Math.max(...allYs);
  const midY = (minY + maxY) / 2;

  // Assign lane Y values, only bumping when two routes' horizontal trunks
  // would actually overlap in X.  This keeps each wire close to its natural
  // midpoint Y instead of pushing everything monotonically down.
  const findNonConflictingY = (candidateY, xMin, xMax, assignedLanes, direction, maxIter) => {
    for (let i = 0; i < maxIter; i++) {
      let conflicting = false;
      for (const lane of assignedLanes) {
        if (Math.abs(candidateY - lane.y) < ROUTE_LANE_GAP && xMin < lane.xMax && xMax > lane.xMin) {
          // Jump past this lane's Y in the given direction.
          candidateY = snapToGrid(lane.y + direction * ROUTE_LANE_GAP);
          conflicting = true;
          break;
        }
      }
      if (!conflicting) break;
    }
    return candidateY;
  };

  const assignCenterLanes = (items) => {
    const assignedLanes = []; // { y, xMin, xMax }
    for (const item of [...items].sort((left, right) => left.preferredY - right.preferredY)) {
      const xMin = Math.min(item.sourcePos.x, item.targetPos.x);
      const xMax = Math.max(item.sourcePos.x, item.targetPos.x);
      const candidateY = findNonConflictingY(
        snapToGrid(item.preferredY), xMin, xMax, assignedLanes, 1, items.length + 1,
      );
      item.laneY = candidateY;
      assignedLanes.push({ y: candidateY, xMin, xMax });
    }
  };

  const topRoutes = [];
  const bottomRoutes = [];
  const forwardRoutes = [];

  routes.forEach((route) => {
    if (route.forward) {
      forwardRoutes.push(route);
      return;
    }

    if (route.preferredY <= midY) {
      topRoutes.push(route);
    } else {
      bottomRoutes.push(route);
    }
  });

  assignCenterLanes(forwardRoutes);

  // Backward routes: offset from diagram edges.
  const assignBackwardLanes = (items, baseY, direction) => {
    const assignedLanes = [];
    const sorted = [...items].sort((left, right) => left.preferredY - right.preferredY);
    sorted.forEach((item, idx) => {
      const xMin = Math.min(item.sourcePos.x, item.targetPos.x);
      const xMax = Math.max(item.sourcePos.x, item.targetPos.x);
      const startY = snapToGrid(baseY + direction * idx * ROUTE_LANE_GAP);
      const candidateY = findNonConflictingY(
        startY, xMin, xMax, assignedLanes, direction, items.length + 1,
      );
      item.laneY = candidateY;
      assignedLanes.push({ y: candidateY, xMin, xMax });
    });
  };

  assignBackwardLanes(topRoutes, minY - 100, -1);
  assignBackwardLanes(bottomRoutes, maxY + 100, 1);

  const assignCenteredOffsets = (items, fieldName) => {
    const ordered = [...items].sort((left, right) => {
      if (left.preferredY !== right.preferredY) {
        return left.preferredY - right.preferredY;
      }
      return left.index - right.index;
    });
    const midpoint = (ordered.length - 1) / 2;
    ordered.forEach((item, idx) => {
      item[fieldName] = (idx - midpoint) * ROUTE_FANOUT_GAP;
    });
  };

  const sourceGroups = new Map();
  const targetGroups = new Map();
  const pairGroups = new Map();

  routes.forEach((route) => {
    const sourceKey = `${route.sourceNode.id()}:${route.forward ? "right" : "left"}`;
    const targetKey = `${route.targetNode.id()}:${route.forward ? "left" : "right"}`;
    const pairKey = `${route.sourceNode.id()}->${route.targetNode.id()}`;

    if (!sourceGroups.has(sourceKey)) {
      sourceGroups.set(sourceKey, []);
    }
    if (!targetGroups.has(targetKey)) {
      targetGroups.set(targetKey, []);
    }
    if (!pairGroups.has(pairKey)) {
      pairGroups.set(pairKey, []);
    }

    sourceGroups.get(sourceKey).push(route);
    targetGroups.get(targetKey).push(route);
    pairGroups.get(pairKey).push(route);
  });

  sourceGroups.forEach((items) => assignCenteredOffsets(items, "sourceOffset"));
  targetGroups.forEach((items) => assignCenteredOffsets(items, "targetOffset"));
  pairGroups.forEach((items) => assignCenteredOffsets(items, "parallelOffset"));

  // Stagger vertical segments for routes leaving/entering the same instance side.
  // Without this, all ports on the same side share the same stub X, causing
  // their vertical entry/exit segments to overlap visually.
  const instanceSideSourceGroups = new Map();
  const instanceSideTargetGroups = new Map();
  routes.forEach((route) => {
    const side = route.forward ? 1 : -1;
    const srcParent = route.sourceNode.data("instance_node_id") || route.sourceNode.id();
    const tgtParent = route.targetNode.data("instance_node_id") || route.targetNode.id();
    const srcKey = `${srcParent}:${side}`;
    const tgtKey = `${tgtParent}:${-side}`;
    if (!instanceSideSourceGroups.has(srcKey)) {
      instanceSideSourceGroups.set(srcKey, []);
    }
    if (!instanceSideTargetGroups.has(tgtKey)) {
      instanceSideTargetGroups.set(tgtKey, []);
    }
    instanceSideSourceGroups.get(srcKey).push(route);
    instanceSideTargetGroups.get(tgtKey).push(route);
  });
  instanceSideSourceGroups.forEach((items) => assignCenteredOffsets(items, "instanceSourceOffset"));
  instanceSideTargetGroups.forEach((items) => assignCenteredOffsets(items, "instanceTargetOffset"));

  const getStubX = (node, side, offset = 0, instanceOffset = 0) => {
    const kind = node.data("kind");
    const centerX = node.position("x");
    const halfWidth = Math.max(6, node.outerWidth() / 2);
    const magnitude = Math.abs(offset);
    const signedOffset = side * magnitude;
    const instanceStagger = side * Math.abs(instanceOffset);

    if (kind === "instance_port" || kind === "process_port") {
      return snapToGrid(centerX + side * 18 + signedOffset + instanceStagger, ROUTE_FANOUT_GAP);
    }

    if (kind === "module_io") {
      return snapToGrid(centerX + side * (halfWidth + 22) + signedOffset + instanceStagger, ROUTE_FANOUT_GAP);
    }

    if (kind === "instance") {
      return snapToGrid(centerX + side * (halfWidth + 20) + signedOffset + instanceStagger, ROUTE_FANOUT_GAP);
    }

    return snapToGrid(centerX + side * 26 + signedOffset + instanceStagger, ROUTE_FANOUT_GAP);
  };

  // Collect bounding boxes of all instance/logic blocks for overlap detection.
  const instanceBoxes = [];
  state.cy.nodes('[kind = "instance"], [kind = "gate"], [kind = "assign"], [kind = "always"]').forEach((node) => {
    const pos = node.position();
    const hw = Math.max(6, node.outerWidth() / 2);
    const hh = Math.max(6, node.outerHeight() / 2);
    instanceBoxes.push({
      id: node.id(),
      left: pos.x - hw,
      top: pos.y - hh,
      right: pos.x + hw,
      bottom: pos.y + hh,
    });
  });

  // Helper: does a horizontal or vertical segment cross a bounding box?
  const segmentHitsBox = (x1, y1, x2, y2, box) => {
    if (x1 === x2) { // vertical
      const yLo = Math.min(y1, y2);
      const yHi = Math.max(y1, y2);
      return box.left < x1 && x1 < box.right && yLo < box.bottom && yHi > box.top;
    }
    // horizontal
    const xLo = Math.min(x1, x2);
    const xHi = Math.max(x1, x2);
    return box.top < y1 && y1 < box.bottom && xLo < box.right && xHi > box.left;
  };

  // Map source/target ports to their parent instance for determining
  // which instances a route is connected to.
  const portToParent = new Map();
  state.cy.nodes('[kind = "instance_port"], [kind = "process_port"]').forEach((node) => {
    const parentId = node.data("instance_node_id") || node.data("parent_node_id") || node.data("process_node_id");
    if (parentId) {
      portToParent.set(node.id(), parentId);
    }
  });

  const routesToConvert = [];

  routes.forEach((route) => {
    const side = route.forward ? 1 : -1;
    const sourceStubX = getStubX(route.sourceNode, side, route.sourceOffset || 0, route.instanceSourceOffset || 0);
    const targetStubX = getStubX(route.targetNode, -side, route.targetOffset || 0, route.instanceTargetOffset || 0);
    const laneY = snapToGrid(route.laneY + (route.parallelOffset || 0), ROUTE_PARALLEL_GAP);
    const points = {
      a: { x: sourceStubX, y: snapToGrid(route.sourcePos.y) },
      b: { x: sourceStubX, y: laneY },
      c: { x: targetStubX, y: laneY },
      d: { x: targetStubX, y: snapToGrid(route.targetPos.y) },
    };

    Object.entries(points).forEach(([suffix, position]) => {
      const node = state.cy.getElementById(`route:${route.index}:${suffix}`);
      if (node && !node.empty()) {
        node.position(position);
      }
    });

    // Only check routes that have anchor nodes (i.e. "routed" edges, not netlabel).
    const anchorA = state.cy.getElementById(`route:${route.index}:a`);
    if (!anchorA || anchorA.empty()) return;

    // Check if the routed wire crosses any unconnected instance.
    const connectedIds = new Set();
    const srcParent = portToParent.get(route.sourceNode.id()) || route.sourceNode.id();
    const tgtParent = portToParent.get(route.targetNode.id()) || route.targetNode.id();
    connectedIds.add(srcParent);
    connectedIds.add(tgtParent);

    const segments = [
      [points.a, points.b],
      [points.b, points.c],
      [points.c, points.d],
    ];

    let hitsUnconnected = false;
    for (const [p1, p2] of segments) {
      for (const box of instanceBoxes) {
        if (connectedIds.has(box.id)) continue;
        if (segmentHitsBox(p1.x, p1.y, p2.x, p2.y, box)) {
          hitsUnconnected = true;
          break;
        }
      }
      if (hitsUnconnected) break;
    }

    if (hitsUnconnected) {
      routesToConvert.push(route);
    }
  });

  // If any route crossing a module shares a target port with another route,
  // convert those sibling routes too so we never mix wire + netlabel at one port.
  if (routesToConvert.length) {
    const convertTargets = new Set(routesToConvert.map((r) => r.edge.target));
    routes.forEach((route) => {
      const anchorCheck = state.cy.getElementById(`route:${route.index}:a`);
      if (!anchorCheck || anchorCheck.empty()) return;
      if (routesToConvert.includes(route)) return;
      if (convertTargets.has(route.edge.target)) {
        routesToConvert.push(route);
      }
    });
  }

  // Convert colliding routes to netlabels.
  if (routesToConvert.length && state.cy) {
    // Track which source/target+signal combos already have a netlabel in the graph
    // to avoid creating duplicates of netlabels from buildPortViewCyElements.
    const existingSrcLabels = new Set();
    const existingTgtLabels = new Set();
    state.cy.nodes('[kind = "netlabel_node"]').forEach((n) => {
      const port = n.data("connected_port") || "";
      const group = n.data("netlabel_group") || "";
      const role = n.data("netlabel_role") || "";
      const key = `${port}:${group}`;
      if (role === "source") existingSrcLabels.add(key);
      else existingTgtLabels.add(key);
    });

    routesToConvert.forEach((route) => {
      const baseId = `route:${route.index}`;
      // Remove the route anchor nodes and segment edges.
      ["a", "b", "c", "d"].forEach((suffix) => {
        const node = state.cy.getElementById(`${baseId}:${suffix}`);
        if (node && !node.empty()) {
          node.connectedEdges().remove();
          node.remove();
        }
      });
      // Also remove the direct source→a and d→target edges.
      for (let s = 0; s <= 4; s++) {
        const seg = state.cy.getElementById(`${baseId}:seg${s}`);
        if (seg && !seg.empty()) seg.remove();
      }

      // Add netlabel elements instead, but only if one doesn't already exist.
      const edge = route.edge;
      const firstName = (edge.nets && edge.nets.length) ? edge.nets[0] : (edge.net || "?");
      const labelText = (edge.nets && edge.nets.length > 1)
        ? `${firstName} +${edge.nets.length - 1}`
        : firstName;
      const labelWidth = Math.max(50, labelText.length * 7 + 14);
      const traceGroup = `nettrace:${edge.source}:${firstName}`;

      const srcKey = `${edge.source}:${firstName}`;
      const tgtKey = `${edge.target}:${firstName}`;
      const newElements = [];

      if (!existingSrcLabels.has(srcKey)) {
        existingSrcLabels.add(srcKey);
        const srcLabelId = `netlabel:conv:${route.index}:src`;
        newElements.push(
          {
            group: "nodes",
            data: {
              id: srcLabelId,
              kind: "netlabel_node",
              net_label_text: labelText,
              netlabel_group: firstName,
              netlabel_trace_group: traceGroup,
              netlabel_role: "source",
              label_width: labelWidth,
              connected_port: edge.source,
              routing_mode: "netlabel",
              routing_reason: "Converted: wire crossed unconnected module.",
              port_view: 1,
            },
          },
          {
            group: "edges",
            data: {
              id: `${srcLabelId}:edge`,
              source: edge.source,
              target: srcLabelId,
              kind: "connection",
              netlabel_stub: 1,
              netlabel_trace_group: traceGroup,
              port_view: 1,
              routing_mode: "netlabel",
              sig_class: edge.sig_class || "wire",
              is_bus: edge.is_bus ? 1 : 0,
            },
          },
        );
      }

      if (!existingTgtLabels.has(tgtKey)) {
        existingTgtLabels.add(tgtKey);
        const tgtLabelId = `netlabel:conv:${route.index}:tgt`;
        newElements.push(
          {
            group: "nodes",
            data: {
              id: tgtLabelId,
              kind: "netlabel_node",
              net_label_text: labelText,
              netlabel_group: firstName,
              netlabel_trace_group: traceGroup,
              netlabel_role: "target",
              label_width: labelWidth,
              connected_port: edge.target,
              routing_mode: "netlabel",
              routing_reason: "Converted: wire crossed unconnected module.",
              port_view: 1,
            },
          },
          {
            group: "edges",
            data: {
              id: `${tgtLabelId}:edge`,
              source: tgtLabelId,
              target: edge.target,
              kind: "connection",
              netlabel_stub: 1,
              netlabel_trace_group: traceGroup,
              port_view: 1,
              routing_mode: "netlabel",
              sig_class: edge.sig_class || "wire",
              is_bus: edge.is_bus ? 1 : 0,
            },
          },
        );
      }

      if (newElements.length) {
        state.cy.add(newElements);
      }
    });
  }
}

function applyPortViewBlockLayout(graph) {
  const instanceNodes = state.cy.nodes('[kind = "instance"]');
  const logicNodes = state.cy.nodes('[kind = "gate"], [kind = "assign"], [kind = "always"]');

  if (!instanceNodes.length && !logicNodes.length) {
    placeModuleIoNodes(graph, 120, 420);
    placePortViewRoutes(graph);
    placeUnconnectedPortStubs();
    placeNetlabelNodes();
    return;
  }

  // Place internal logic nodes (gates, assigns, always blocks) alongside instances.
  if (logicNodes.length && !instanceNodes.length) {
    const canvasHeight = cyGraph.clientHeight || 760;
    const centerY = snapToGrid(canvasHeight / 2);
    const rowGap = snapToGrid(logicNodes.length > 12 ? INSTANCE_ROW_GAP_DENSE : INSTANCE_ROW_GAP);
    const totalHeight = Math.max(0, (logicNodes.length - 1) * rowGap);
    const startY = snapToGrid(centerY - totalHeight / 2);
    logicNodes.forEach((node, idx) => {
      node.position({ x: snapToGrid(INSTANCE_COLUMN_START), y: startY + idx * rowGap });
    });
    placeInstancePortNodes(graph);
    placeModuleIoNodes(graph, snapToGrid(INSTANCE_COLUMN_START - IO_COLUMN_MARGIN), snapToGrid(INSTANCE_COLUMN_START + IO_COLUMN_MARGIN));
    placePortViewRoutes(graph);
    placeUnconnectedPortStubs();
    placeNetlabelNodes();
    return;
  }

  const levelByInstance = computePortViewInstanceLevels(graph);
  const groupedByLevel = new Map();

  instanceNodes.forEach((node) => {
    const level = levelByInstance.get(node.id()) || 0;
    if (!groupedByLevel.has(level)) {
      groupedByLevel.set(level, []);
    }
    groupedByLevel.get(level).push(node);
  });

  const { levels, ordered } = orderInstancesWithinLevels(graph, groupedByLevel, levelByInstance);
  const canvasHeight = cyGraph.clientHeight || 760;
  const centerY = snapToGrid(canvasHeight / 2);
  const levelColumns = levels.map((level) => ({
    level,
    nodes: ordered.get(level) || [],
  }));

  levelColumns.forEach((entry) => {
    const rowGap = snapToGrid(entry.nodes.length > 12 ? INSTANCE_ROW_GAP_DENSE : INSTANCE_ROW_GAP);
    const totalHeight = Math.max(0, (entry.nodes.length - 1) * rowGap);
    const startY = snapToGrid(centerY - totalHeight / 2);
    entry.nodes.forEach((node, idx) => {
      node.position({
        x: snapToGrid(INSTANCE_COLUMN_START + entry.level * INSTANCE_COLUMN_STEP),
        y: startY + idx * rowGap,
      });
    });
  });

  distributeColumns(levelColumns, INSTANCE_COLUMN_START - 40, INSTANCE_MIN_COLUMN_GAP);
  levelColumns.forEach((entry) => {
    spreadNodesVertically(entry.nodes, LAYOUT_GRID + 12, centerY);
  });


  // Separate assign nodes from other logic nodes (gates, always blocks).
  const assignNodes = logicNodes.filter('[kind = "assign"]');
  const otherLogicNodes = logicNodes.filter('[kind = "gate"], [kind = "always"]');

  // Place gates and always blocks at a column after instances.
  if (otherLogicNodes.length) {
    const canvasHeight = cyGraph.clientHeight || 760;
    const centerYLogic = snapToGrid(canvasHeight / 2);
    const instanceRightBounds = instanceNodes.map((node) => node.position("x") + getNodeHalfSize(node).halfWidth);
    const maxInstanceRight = instanceRightBounds.length ? Math.max(...instanceRightBounds) : INSTANCE_COLUMN_START;
    const logicWidths = otherLogicNodes.map((node) => node.outerWidth());
    const logicHalfWidth = (logicWidths.length ? Math.max(...logicWidths) : 0) / 2;
    const logicX = snapToGrid(maxInstanceRight + INSTANCE_MIN_COLUMN_GAP + logicHalfWidth);
    const rowGap = snapToGrid(otherLogicNodes.length > 12 ? INSTANCE_ROW_GAP_DENSE : INSTANCE_ROW_GAP);
    const totalHeight = Math.max(0, (otherLogicNodes.length - 1) * rowGap);
    const startY = snapToGrid(centerYLogic - totalHeight / 2);
    otherLogicNodes.forEach((node, idx) => {
      node.position({ x: logicX, y: startY + idx * rowGap });
    });
  }

  // Place assign nodes on the left, below the input ports.
  if (assignNodes.length) {
    const inputNodes = state.cy.nodes('[kind = "module_io"][direction = "input"]');
    const inputPositions = inputNodes.map((node) => node.position("y"));
    const inputBottomY = inputPositions.length ? Math.max(...inputPositions) + 80 : centerY;
    const inputX = inputNodes.length ? inputNodes[0].position("x") : snapToGrid(INSTANCE_COLUMN_START - IO_COLUMN_MARGIN);
    const rowGap = snapToGrid(assignNodes.length > 12 ? INSTANCE_ROW_GAP_DENSE : INSTANCE_ROW_GAP);
    assignNodes.forEach((node, idx) => {
      node.position({ x: inputX, y: snapToGrid(inputBottomY + idx * rowGap) });
    });
  }
  placeInstancePortNodes(graph);

  const allBlockNodes = instanceNodes.union(logicNodes);
  const leftBounds = allBlockNodes.map((node) => node.position("x") - getNodeHalfSize(node).halfWidth);
  const rightBounds = allBlockNodes.map((node) => node.position("x") + getNodeHalfSize(node).halfWidth);
  const minLeft = Math.min(...leftBounds);
  const maxRight = Math.max(...rightBounds);
  placeModuleIoNodes(graph, snapToGrid(minLeft - IO_COLUMN_MARGIN), snapToGrid(maxRight + IO_COLUMN_MARGIN));
  placePortViewRoutes(graph);
  placeUnconnectedPortStubs();
  placeNetlabelNodes();
}

function renderCyGraph(graph) {
  if (!ensureCytoscape()) {
    return;
  }

  const showGraph = () => {
    state.cy.fit(undefined, 60);
    graphEmpty.classList.add("hidden");
  };

  const showError = (error) => {
    graphEmpty.classList.remove("hidden");
    graphEmpty.innerHTML = "<h3>Graph render failed</h3><p>The project loaded, but the graph view could not be rendered.</p>";
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Graph render failed: ${detail}`);
  };

  try {
    state.cy.elements().remove();
    state.cy.add(buildCyElements(graph));
  } catch (error) {
    showError(error);
    throw new Error(`Graph render failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (state.portView) {
    try {
      applyPortViewBlockLayout(graph);
      showGraph();
    } catch (error) {
      showError(error);
    }
    return;
  }

  state.cy.elements().not('node[kind = "instance_port"]').layout({
    name: "elk",
    elk: {
      algorithm: "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.spacing.nodeNode": "60",
      "elk.spacing.edgeNode": "20",
      "elk.spacing.edgeEdge": "10",
    },
    animate: false,
    fit: false,
    stop: showGraph,
  }).run();
}
// ── Cross-module signal trace ────────────────────────────────────────────
// Extracts a traceable {module, signal} from the current node/edge selection.
function getTraceableSelection() {
  const mod = state.selectedModule;
  if (!mod) return null;

  const node = state.selectedNode;
  if (node) {
    if (node.kind === "module_io" || node.kind === "instance_port" || node.kind === "process_port") {
      const sig = node.port_name || node.label;
      if (sig) return { module: mod, signal: sig, label: `${mod}.${sig}` };
    }
    if (node.kind === "assign" && node.target_signal) {
      return { module: mod, signal: node.target_signal, label: `${mod}.${node.target_signal}` };
    }
    if (node.kind === "net") {
      const sig = node.label || node.id;
      if (sig) return { module: mod, signal: sig, label: `${mod}.${sig}` };
    }
  }

  const edge = state.selectedEdge;
  if (edge) {
    const sig = (edge.nets && edge.nets[0]) || edge.net || edge.signal_name;
    if (sig) return { module: mod, signal: sig, label: `${mod}.${sig}` };
  }

  return null;
}

async function requestCrossModuleTrace(moduleName, signal) {
  try {
    setStatus(`Tracing ${moduleName}.${signal}...`, "loading");
    const response = await fetch(`${API_BASE}/api/signal/trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: moduleName, signal, max_hops: 500 }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }
    const trace = await response.json();
    renderCrossModuleTracePanel(trace);
    setStatus(
      `Trace: ${trace.fanin.length} upstream, ${trace.fanout.length} downstream${trace.truncated ? " (truncated)" : ""}`,
      "ok"
    );
  } catch (exc) {
    setStatus(`Trace failed: ${exc.message || exc}`, "error");
  }
}

// ── Trace rendering: role/op helpers ────────────────────────────────────
const TRACE_ROLE_STYLE = {
  driver:    { color: "#22d3ee", label: "DRIVER" },
  compute:   { color: "#facc15", label: "COMPUTE" },
  pipeline:  { color: "#f472b6", label: "PIPELINE" },
  transport: { color: "#a1a1aa", label: "TRANSPORT" },
  load:      { color: "#60a5fa", label: "LOAD" },
  unknown:   { color: "#71717a", label: "STEP" },
};

const TRACE_OP_BADGE = {
  arithmetic: { color: "#fb923c", label: "+−×" },
  comparison: { color: "#a78bfa", label: "=?" },
  logic:      { color: "#34d399", label: "&|^" },
  mux:        { color: "#e879f9", label: "MUX" },
  wire:       null,
};

function traceRoleStyle(role) {
  return TRACE_ROLE_STYLE[role] || TRACE_ROLE_STYLE.unknown;
}

function traceHopIsMeaningful(hop) {
  // Used for summary view: only compute + pipeline + module-crossings count.
  if (hop.role === "compute") return true;
  if (hop.role === "pipeline") return true;
  if (hop.crosses) return true;
  return false;
}

// Groups hops by (module, signal, block_name) so that e.g. ten always-assignments
// to `imm` in one block become a single summarized entry with a variant count.
function groupTraceHops(hops) {
  const groups = [];
  for (const h of hops) {
    const key = `${h.module}::${h.signal}::${h.role}::${h.block_name || ""}::${h.next_module || ""}::${h.next_signal || ""}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(h);
    } else {
      groups.push({ key, items: [h] });
    }
  }
  return groups.map((g) => {
    const first = g.items[0];
    const variantCount = g.items.length;
    // Collect distinct op_categories within the group for a richer badge set.
    const ops = new Set();
    for (const h of g.items) {
      if (h.op_category && h.op_category !== "wire") ops.add(h.op_category);
    }
    return {
      module: first.module,
      signal: first.signal,
      role: first.role,
      kind: first.kind,
      label: first.label,
      detail: first.detail,
      expression: first.expression,
      block_name: first.block_name,
      process_style: first.process_style,
      blocking: first.blocking,
      crosses: first.crosses,
      next_module: first.next_module,
      next_signal: first.next_signal,
      op_categories: Array.from(ops),
      variants: variantCount,
      raw: g.items,
    };
  });
}

function formatHopHeadline(group) {
  // Short, readable headline for one grouped hop.
  if (group.role === "pipeline") {
    const expr = group.expression ? ` ← ${group.expression}` : "";
    return `${group.signal}${expr}`;
  }
  if (group.role === "compute") {
    if (group.kind === "assign" || group.kind === "always") {
      return group.detail || `${group.signal} = ${group.expression || "?"}`;
    }
    if (group.kind === "gate") {
      return group.detail || group.label;
    }
  }
  if (group.role === "transport") {
    if (group.crosses === "down") {
      return `\u2193 ${group.next_module}.${group.next_signal}`;
    }
    if (group.crosses === "up") {
      return `\u2191 ${group.next_module}.${group.next_signal}`;
    }
    return group.label || group.detail;
  }
  return group.label || group.signal;
}

function renderTraceBadges(group) {
  const parts = [];
  if (group.variants > 1) {
    parts.push(
      `<span style="background:#3f3f46;color:#e4e4e7;padding:0 5px;border-radius:8px;font-size:9px;margin-left:4px;">×${group.variants}</span>`
    );
  }
  if (group.process_style === "seq") {
    parts.push(
      `<span style="background:rgba(244,114,182,0.18);color:#f9a8d4;padding:0 5px;border-radius:8px;font-size:9px;margin-left:4px;">clocked</span>`
    );
  }
  for (const op of group.op_categories || []) {
    const badge = TRACE_OP_BADGE[op];
    if (!badge) continue;
    parts.push(
      `<span style="background:rgba(255,255,255,0.04);color:${badge.color};padding:0 5px;border-radius:8px;font-size:9px;margin-left:4px;border:1px solid ${badge.color}33;">${badge.label}</span>`
    );
  }
  return parts.join("");
}

function renderCrossModuleTracePanel(trace) {
  if (!trace) {
    const existing = document.getElementById("crossTracePanel");
    if (existing) existing.remove();
    return;
  }

  let panel = document.getElementById("crossTracePanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "crossTracePanel";
    panel.style.cssText = `
      position: absolute; top: 8px; right: 8px; z-index: 210;
      background: #18181b; border: 1px solid rgba(255,255,255,0.10); border-radius: 4px;
      padding: 10px 12px; min-width: 340px; max-width: 520px;
      max-height: 78vh; overflow-y: auto; color: #e4e4e7;
      font-family: 'IBM Plex Mono', Consolas, Monaco, monospace; font-size: 11px;
    `;
    const canvas = document.getElementById("graphCanvas");
    if (canvas) canvas.appendChild(panel);
  }

  // Persist the expand/collapse mode between re-renders.
  const modeKey = "__traceViewMode";
  const mode = panel[modeKey] || "summary"; // "summary" | "details"
  panel[modeKey] = mode;

  const groupedFanin = groupTraceHops(trace.fanin || []);
  const groupedFanout = groupTraceHops(trace.fanout || []);

  // Summary view: critical path only (compute + pipeline + boundary crossings).
  const summaryFanin = groupedFanin.filter(traceHopIsMeaningful);
  const summaryFanout = groupedFanout.filter(traceHopIsMeaningful);

  // Fan-out collapse: cap at this many entries in summary view.
  const FANOUT_SUMMARY_CAP = 5;
  const fanoutShown = mode === "summary"
    ? summaryFanout.slice(0, FANOUT_SUMMARY_CAP)
    : groupedFanout;
  const fanoutHiddenCount = mode === "summary"
    ? Math.max(0, summaryFanout.length - FANOUT_SUMMARY_CAP)
    : 0;

  const faninList = mode === "summary" ? summaryFanin : groupedFanin;

  const renderGroup = (group, accentColor) => {
    const roleStyle = traceRoleStyle(group.role);
    const headline = formatHopHeadline(group);
    const badges = renderTraceBadges(group);
    const scopeAttr = `data-trace-module="${escapeHtml(group.module)}" data-trace-signal="${escapeHtml(group.signal)}"`;
    const nextAttr = group.next_module && group.next_signal
      ? `data-trace-module="${escapeHtml(group.next_module)}" data-trace-signal="${escapeHtml(group.next_signal)}"`
      : "";

    // Scope line: "Module.signal"
    const scopeLine = `
      <div style="font-size:9px;color:#71717a;letter-spacing:0.02em;">
        <a href="#" class="xtrace-nav" data-trace-module="${escapeHtml(group.module)}" style="color:#22d3ee;text-decoration:none;">${escapeHtml(group.module)}</a><span style="color:#3f3f46;">.</span><a href="#" class="xtrace-retrace" ${scopeAttr} style="color:#a1a1aa;text-decoration:none;">${escapeHtml(group.signal)}</a>
      </div>`;

    // Role pill
    const rolePill = `<span style="display:inline-block;background:${roleStyle.color}22;color:${roleStyle.color};padding:1px 6px;border-radius:2px;font-size:8px;font-weight:700;letter-spacing:0.08em;margin-right:6px;">${roleStyle.label}</span>`;

    // Optional "follow" link for boundary crossings.
    const followLink = nextAttr
      ? ` <a href="#" class="xtrace-retrace" ${nextAttr} style="color:#a78bfa;text-decoration:none;font-size:9px;">[follow]</a>`
      : "";

    return `
      <div style="margin:4px 0;padding:5px 8px;border-left:2px solid ${accentColor};background:rgba(255,255,255,0.02);border-radius:0 2px 2px 0;">
        ${scopeLine}
        <div style="margin-top:3px;line-height:1.5;">
          ${rolePill}<span style="color:#e4e4e7;">${escapeHtml(headline)}</span>${badges}${followLink}
        </div>
      </div>`;
  };

  const renderSection = (groups, accent, heading, emptyMsg, extraFooter = "") => {
    let html = `<div style="color:${accent};font-weight:600;margin:8px 0 4px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;">${heading}</div>`;
    if (!groups.length) {
      html += `<div style="color:#52525b;margin:2px 0 4px 2px;font-size:10px;">${emptyMsg}</div>`;
      return html;
    }
    html += groups.map((g) => renderGroup(g, accent)).join("");
    if (extraFooter) html += extraFooter;
    return html;
  };

  const origin = trace.origin || {};
  const modeToggle = `
    <button id="traceModeToggle" style="background:none;border:1px solid #3f3f46;color:#a1a1aa;padding:2px 8px;border-radius:2px;cursor:pointer;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;">
      ${mode === "summary" ? "Show details" : "Show summary"}
    </button>`;

  const totals = `
    <div style="color:#71717a;font-size:9px;margin-top:2px;">
      ${mode === "summary"
        ? `${summaryFanin.length} key driver${summaryFanin.length === 1 ? "" : "s"} / ${summaryFanout.length} key load${summaryFanout.length === 1 ? "" : "s"} (filtered from ${groupedFanin.length + groupedFanout.length})`
        : `${groupedFanin.length + groupedFanout.length} grouped steps (${(trace.fanin || []).length + (trace.fanout || []).length} raw)`}
    </div>`;

  const fanoutFooter = fanoutHiddenCount > 0
    ? `<div style="margin:4px 0 0 2px;font-size:10px;color:#71717a;">+ ${fanoutHiddenCount} more load${fanoutHiddenCount === 1 ? "" : "s"} <a href="#" id="traceExpandFanout" style="color:#22d3ee;text-decoration:none;">expand</a></div>`
    : "";

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-weight:600;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#a1a1aa;">Signal Trace</span>
      <div style="display:flex;gap:6px;align-items:center;">
        ${modeToggle}
        <button id="closeCrossTracePanel" style="background:none;border:none;color:#52525b;cursor:pointer;font-size:16px;line-height:1;">&times;</button>
      </div>
    </div>
    <div style="padding:5px 8px;border:1px solid rgba(34,211,238,0.3);border-radius:3px;margin-bottom:6px;background:rgba(34,211,238,0.06);">
      <div style="color:#22d3ee;font-size:9px;font-weight:600;letter-spacing:0.08em;">ORIGIN</div>
      <div style="margin-top:2px;"><strong style="color:#e4e4e7;">${escapeHtml(origin.module || "")}</strong><span style="color:#71717a;">.</span>${escapeHtml(origin.signal || "")}</div>
      ${totals}
    </div>
    ${renderSection(
      faninList,
      "#4ade80",
      "\u25b2 Fan-in (what drives it)",
      mode === "summary" ? "(no meaningful drivers — try details view)" : "(no drivers found)"
    )}
    ${renderSection(
      fanoutShown,
      "#60a5fa",
      "\u25bc Fan-out (what it drives)",
      mode === "summary" ? "(no meaningful loads — try details view)" : "(no loads found)",
      fanoutFooter
    )}
    ${trace.truncated ? `<div style="color:#f59e0b;margin-top:6px;font-size:9px;">Result truncated at max_hops.</div>` : ""}
    <div style="color:#3f3f46;margin-top:8px;font-size:9px;line-height:1.5;">
      Click <span style="color:#22d3ee;">module</span> to open it. Click signal / [follow] to re-trace.
    </div>
  `;

  panel.querySelector("#closeCrossTracePanel")?.addEventListener("click", () => {
    panel.remove();
  });

  panel.querySelector("#traceModeToggle")?.addEventListener("click", () => {
    panel[modeKey] = panel[modeKey] === "summary" ? "details" : "summary";
    renderCrossModuleTracePanel(trace);
  });

  panel.querySelector("#traceExpandFanout")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    panel[modeKey] = "details";
    renderCrossModuleTracePanel(trace);
  });

  panel.querySelectorAll(".xtrace-nav").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const mod = ev.currentTarget.getAttribute("data-trace-module");
      if (mod && mod !== state.selectedModule) {
        await loadGraph(mod);
      }
    });
  });

  panel.querySelectorAll(".xtrace-retrace").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const mod = ev.currentTarget.getAttribute("data-trace-module");
      const sig = ev.currentTarget.getAttribute("data-trace-signal");
      if (mod && sig) {
        if (mod !== state.selectedModule) {
          await loadGraph(mod);
        }
        requestCrossModuleTrace(mod, sig);
      }
    });
  });
}

function renderSignalTracePanel(trace) {
  if (!trace) {
    const existing = document.getElementById("signalTracePanel");
    if (existing) existing.remove();
    return;
  }

  let panel = document.getElementById("signalTracePanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "signalTracePanel";
    panel.style.cssText = `
      position: absolute; top: 8px; left: 8px; z-index: 200;
      background: #18181b; border: 1px solid rgba(255,255,255,0.10); border-radius: 4px;
      padding: 10px 12px; min-width: 260px; max-width: 380px;
      max-height: 60vh; overflow-y: auto; color: #e4e4e7;
      font-family: 'IBM Plex Mono', Consolas, Monaco, monospace; font-size: 11px;
    `;
    const canvas = document.getElementById("graphCanvas");
    if (canvas) canvas.appendChild(panel);
  }

  const kindIcon = (kind) => {
    if (kind === "module_io") return "\u25c6"; // ◆
    if (kind === "instance") return "\u25a0"; // ■
    if (kind === "always") return "\u25b6"; // ▶
    if (kind === "assign") return "\u2190"; // ←
    if (kind === "gate") return "\u25b3"; // △
    return "\u25cb"; // ○
  };

  const renderSteps = (steps, color, label) => {
    if (!steps.length) return `<div style="color:#52525b;margin:2px 0;">${label}: (none)</div>`;

    // Group consecutive steps by parent instance.
    const groups = [];
    for (const step of steps) {
      const last = groups[groups.length - 1];
      if (last && last.parentInstance === step.parentInstance) {
        last.ports.push(step);
      } else {
        groups.push({
          parentInstance: step.parentInstance,
          parentLabel: step.parentLabel,
          parentKind: step.parentKind,
          ports: [step],
        });
      }
    }

    let html = `<div style="color:${color};font-weight:600;margin:6px 0 3px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;">${label}</div>`;
    for (const group of groups) {
      const icon = kindIcon(group.parentKind);
      const portList = group.ports.map((p) => {
        const netTag = p.netName ? `<span style="color:#22d3ee;"> [${escapeHtml(p.netName)}]</span>` : "";
        const arrow = p.crossedInstance ? " \u2192 " : ""; // →
        const dirTag = p.direction === "input" ? "\u2192" : p.direction === "output" ? "\u2190" : "\u2194";
        return `${arrow}<span style="color:#71717a;">${dirTag}</span> ${escapeHtml(p.portName)}${netTag}`;
      }).join("<br>");
      html += `<div style="margin:2px 0 2px 6px;padding:3px 6px;border-left:1.5px solid ${color};background:rgba(255,255,255,0.02);border-radius:0 2px 2px 0;">
        <div style="font-weight:600;">${icon} ${escapeHtml(group.parentLabel)}</div>
        <div style="margin-left:10px;">${portList}</div>
      </div>`;
    }
    return html;
  };

  const origin = trace.origin;
  const originIcon = kindIcon(origin.parentKind);

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <span style="font-weight:600;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#a1a1aa;">Signal Trace</span>
      <button id="closeTracePanel" style="background:none;border:none;color:#52525b;cursor:pointer;font-size:14px;line-height:1;">&times;</button>
    </div>
    <div style="padding:3px 6px;border:1px solid rgba(34,211,238,0.3);border-radius:3px;margin-bottom:6px;background:rgba(34,211,238,0.06);">
      <span style="color:#22d3ee;font-size:10px;font-weight:500;">ORIGIN</span> ${originIcon} <strong>${escapeHtml(origin.parentLabel)}</strong>
      .${escapeHtml(origin.portName)}
    </div>
    ${renderSteps(trace.upstream, "#4ade80", "\u25b2 Upstream (sources)")}
    ${renderSteps(trace.downstream, "#60a5fa", "\u25bc Downstream (sinks)")}
    <div style="color:#3f3f46;margin-top:6px;font-size:9px;">Double-click port to trace. Click background to clear.</div>
  `;

  document.getElementById("closeTracePanel").addEventListener("click", () => {
    if (state.cy) {
      state.cy.elements(
        ".signal-trace-upstream, .signal-trace-downstream, .signal-trace-origin, .signal-trace-dimmed"
      ).removeClass(
        "signal-trace-upstream signal-trace-downstream signal-trace-origin signal-trace-dimmed"
      );
    }
    state.signalTrace = null;
    panel.remove();
  });
}

function renderInspector() {
  const summary = state.summary || {};
  const traceable = getTraceableSelection();
  const traceButton = traceable
    ? `<button id="traceSignalBtn" data-trace-module="${escapeHtml(traceable.module)}" data-trace-signal="${escapeHtml(traceable.signal)}" style="margin-top:8px;padding:4px 10px;background:#22d3ee;color:#18181b;border:none;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">Trace ${escapeHtml(traceable.label)}</button>`
    : "";

  let selectionBlock = "";
  if (state.selectedNode) {
    let connected = 0;
    if (state.cy) {
      const nodeRef = state.cy.getElementById(state.selectedNode.id);
      if (nodeRef) {
        connected = nodeRef.connectedEdges().length;
      }
    }

    const widthText = state.selectedNode.bit_width && state.selectedNode.bit_width > 1
      ? `[${state.selectedNode.bit_width}]`
      : "1";

    selectionBlock = `
      <hr style="border-color:#2b3f4d;border-style:solid;border-width:1px 0 0; margin:10px 0;" />
      <div><span class="k">Selected node:</span> ${escapeHtml(state.selectedNode.label || state.selectedNode.id)}</div>
      <div><span class="k">Kind:</span> ${escapeHtml(state.selectedNode.kind || "unknown")}</div>
      <div><span class="k">Signal class:</span> ${state.selectedNode.is_bus ? "bus" : "wire"}</div>
      <div><span class="k">Bit width:</span> ${escapeHtml(widthText)}</div>
      <div><span class="k">ID:</span><br>${escapeHtml(state.selectedNode.id)}</div>
      <div><span class="k">Connected edges:</span> ${connected}</div>
      ${state.selectedNode.kind === "instance" ? `<div><span class="k">Double-click behavior:</span> Open instance module graph</div>` : ""}
      ${state.selectedNode.kind === "gate" ? `<div><span class="k">Gate type:</span> ${escapeHtml(state.selectedNode.gate_type || "")}</div>` : ""}
      ${state.selectedNode.kind === "assign" ? `<div><span class="k">Target:</span> ${escapeHtml(state.selectedNode.target_signal || "")}</div><div><span class="k">Expression:</span> ${escapeHtml(state.selectedNode.expression || "")}</div>` : ""}
      ${state.selectedNode.kind === "always" ? `<div><span class="k">Process type:</span> ${escapeHtml(state.selectedNode.process_style || state.selectedNode.always_kind || "always")}</div><div><span class="k">Sensitivity:</span> ${escapeHtml(state.selectedNode.sensitivity_title || state.selectedNode.title || (state.selectedNode.sensitivity ? `ALWAYS @(${state.selectedNode.sensitivity})` : "ALWAYS"))}</div><div><span class="k">Reads:</span> ${escapeHtml((state.selectedNode.read_signals || []).join(", ") || "-")}</div><div><span class="k">Writes:</span> ${escapeHtml((state.selectedNode.written_signals || []).join(", ") || "-")}</div><div><span class="k">Feedback:</span> ${escapeHtml((state.selectedNode.feedback_signals || []).join(", ") || "-")}</div>${(state.selectedNode.control_summary || []).length ? `<div><span class="k">Top-level control:</span><br>${escapeHtml(state.selectedNode.control_summary.join(" | "))}</div>` : ""}${(state.selectedNode.summary_lines || []).length ? `<div><span class="k">Assignments:</span><br>${escapeHtml(state.selectedNode.summary_lines.join(" | "))}</div>` : ""}<div><span class="k">Double-click:</span> View detailed internals</div>` : ""}
      ${state.selectedNode.kind === "process_port" ? `<div><span class="k">Process pin:</span> ${escapeHtml(state.selectedNode.port_name || "")}</div><div><span class="k">Direction:</span> ${escapeHtml(state.selectedNode.direction || "unknown")}</div>` : ""}
    `;
  } else if (state.selectedEdge) {
    const netInfo = state.selectedEdge.nets?.length
      ? `${state.selectedEdge.nets.slice(0, 8).join(", ")}${state.selectedEdge.nets.length > 8 ? " ..." : ""}`
      : state.selectedEdge.net || "(unnamed net)";

    const widthText = state.selectedEdge.bit_width && state.selectedEdge.bit_width > 1
      ? `[${state.selectedEdge.bit_width}]`
      : "1";

    selectionBlock = `
      <hr style="border-color:#2b3f4d;border-style:solid;border-width:1px 0 0; margin:10px 0;" />
      <div><span class="k">Selected connection:</span> ${escapeHtml(netInfo)}</div>
      <div><span class="k">From:</span> ${escapeHtml(state.selectedEdge.source)}</div>
      <div><span class="k">To:</span> ${escapeHtml(state.selectedEdge.target)}</div>
      <div><span class="k">Flow:</span> ${escapeHtml(state.selectedEdge.flow || "directed")}</div>
      <div><span class="k">Signal class:</span> ${escapeHtml(state.selectedEdge.sig_class || "wire")}</div>
      <div><span class="k">Bit width:</span> ${escapeHtml(widthText)}</div>
      <div><span class="k">Net count:</span> ${state.selectedEdge.net_count || 1}</div>

      <div><span class="k">Display mode:</span> ${escapeHtml(state.selectedEdge.routing_mode || "direct")}</div>

      <div><span class="k">Why:</span> ${escapeHtml(state.selectedEdge.routing_reason || "Direct connection rendering.")}</div>
    `;
  }

  const selectedInstance =
    state.selectedNode && state.selectedNode.kind === "instance" ? state.selectedNode : null;

  const viewCodeButton = state.selectedModule
    ? `<button id="viewModuleCodeBtn" data-module="${escapeHtml(state.selectedModule)}">View / Edit Code</button>`
    : "";

  const jumpToDefButton = selectedInstance
    ? `<button id="jumpToDefBtn"
                data-parent-module="${escapeHtml(state.selectedModule || "")}"
                data-instance-name="${escapeHtml(selectedInstance.instance_name || selectedInstance.label || "")}"
                data-child-module="${escapeHtml(selectedInstance.module_name || "")}">Jump to Definition</button>`
    : "";

  inspector.innerHTML = `
    <div><span class="k">Parser:</span> ${escapeHtml(summary.parser_backend || "-")}</div>
    <div><span class="k">Files:</span> ${summary.file_count ?? 0}</div>
    <div><span class="k">Modules:</span> ${summary.module_count ?? 0}</div>
    <div><span class="k">Top candidates:</span> ${escapeHtml((summary.top_candidates || []).join(", ") || "(none)")}</div>
    <div><span class="k">Selected top:</span> ${escapeHtml(state.selectedTop || "(none)")}</div>
    <div><span class="k">Focus module:</span> ${escapeHtml(state.selectedModule || "(none)")}</div>
    ${selectionBlock}
    ${viewCodeButton}
    ${jumpToDefButton}
    ${traceButton}
  `;

  const btn = document.getElementById("traceSignalBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      const mod = btn.getAttribute("data-trace-module");
      const sig = btn.getAttribute("data-trace-signal");
      if (mod && sig) requestCrossModuleTrace(mod, sig);
    });
  }

  const codeBtn = document.getElementById("viewModuleCodeBtn");
  if (codeBtn) {
    codeBtn.addEventListener("click", () => {
      const mod = codeBtn.getAttribute("data-module");
      if (mod) openModuleCodeEditor(mod);
    });
  }

  const jumpBtn = document.getElementById("jumpToDefBtn");
  if (jumpBtn) {
    jumpBtn.addEventListener("click", () => {
      const parentModule = jumpBtn.getAttribute("data-parent-module");
      const instanceName = jumpBtn.getAttribute("data-instance-name");
      const childModule = jumpBtn.getAttribute("data-child-module");
      if (!parentModule) return;
      openModuleCodeEditor(parentModule, {
        jumpToInstance: { instanceName, childModule },
      });
    });
  }
}

function showAlwaysDetail(data) {
  const overlay = document.getElementById("alwaysDetailOverlay");
  const titleEl = document.getElementById("alwaysDetailTitle");
  const bodyEl = document.getElementById("alwaysDetailBody");
  const closeBtn = document.getElementById("alwaysDetailClose");

  const title = data.sensitivity_title || data.title || `ALWAYS @(${data.sensitivity || "*"})`;
  const processStyle = data.process_style || "generic";
  const styleLabels = { comb: "Combinational", seq: "Sequential", latch: "Latch", generic: "Generic" };

  titleEl.textContent = `${styleLabels[processStyle] || processStyle} - ${data.block_name || data.label}`;

  const readSignals = data.read_signals || [];
  const writtenSignals = data.written_signals || [];
  const feedbackSignals = data.feedback_signals || [];
  const assignments = data.assignments || [];
  const controlSummary = data.control_summary || [];

  // Group assignments by condition
  const conditionGroups = new Map();
  for (const a of assignments) {
    const cond = a.condition || "(unconditional)";
    if (!conditionGroups.has(cond)) {
      conditionGroups.set(cond, []);
    }
    conditionGroups.get(cond).push(a);
  }

  let html = "";

  // Header info
  html += `<div class="detail-section">
    <div class="detail-section-title">Sensitivity</div>
    <div>${escapeHtml(title)}</div>
  </div>`;

  // Signal summary
  html += `<div class="detail-section">
    <div class="detail-section-title">Input Signals (read only)</div>
    <div>${readSignals.length ? readSignals.map((s) => `<span class="signal-chip">${escapeHtml(s)}</span>`).join("") : "<em>none</em>"}</div>
  </div>`;

  html += `<div class="detail-section">
    <div class="detail-section-title">Output Signals (written only)</div>
    <div>${writtenSignals.length ? writtenSignals.map((s) => `<span class="signal-chip output">${escapeHtml(s)}</span>`).join("") : "<em>none</em>"}</div>
  </div>`;

  if (feedbackSignals.length) {
    html += `<div class="detail-section">
      <div class="detail-section-title">Feedback Signals (read &amp; written)</div>
      <div>${feedbackSignals.map((s) => `<span class="signal-chip feedback">${escapeHtml(s)}</span>`).join("")}</div>
    </div>`;
  }

  // Control flow
  if (controlSummary.length) {
    html += `<div class="detail-section">
      <div class="detail-section-title">Control Flow</div>
      <div>${controlSummary.map((c) => escapeHtml(c)).join("<br>")}</div>
    </div>`;
  }

  // Assignments grouped by condition
  if (assignments.length) {
    html += `<div class="detail-section">
      <div class="detail-section-title">Assignments</div>`;

    for (const [condition, assigns] of conditionGroups) {
      if (condition !== "(unconditional)") {
        html += `<div class="assign-condition">when ${escapeHtml(condition)}:</div>`;
      } else if (conditionGroups.size > 1) {
        html += `<div class="assign-condition">unconditional:</div>`;
      }
      for (const a of assigns) {
        const op = a.blocking ? "=" : "&lt;=";
        html += `<div class="assignment-row">
          <span><span class="assign-target">${escapeHtml(a.target)}</span> <span class="assign-op">${op}</span></span>
          <span class="assign-expr">${escapeHtml(a.expression)}</span>
        </div>`;
      }
    }
    html += `</div>`;
  } else {
    // Fallback to summary_lines if no structured assignments
    const summaryLines = data.summary_lines || [];
    if (summaryLines.length) {
      html += `<div class="detail-section">
        <div class="detail-section-title">Assignment Summary</div>
        <div>${summaryLines.map((l) => escapeHtml(l)).join("<br>")}</div>
      </div>`;
    }
  }

  bodyEl.innerHTML = html;
  overlay.classList.remove("hidden");

  const closeHandler = () => {
    overlay.classList.add("hidden");
    closeBtn.removeEventListener("click", closeHandler);
    overlay.removeEventListener("click", bgClickHandler);
  };
  const bgClickHandler = (e) => {
    if (e.target === overlay) closeHandler();
  };
  closeBtn.addEventListener("click", closeHandler);
  overlay.addEventListener("click", bgClickHandler);
}

function renderGraph(rawGraph) {
  if (!rawGraph) {
    graphTag.textContent = "No graph loaded";
    clearGraphStats();
    graphEmpty.classList.remove("hidden");
    hideTooltip();

    if (state.cy) {
      state.cy.elements().remove();
    }

    return;
  }

  const graph = getRenderableGraph(rawGraph);
  const nodeCounts = countByKind(graph.nodes || []);
  const edgeCounts = countByKind(graph.edges || []);
  const edgeSignalCounts = countEdgeSignalClasses(graph.edges || []);

  const focus = graph.focus_module || graph.top_module || state.selectedModule || "(unknown)";
  graphTag.textContent = `${focus} — ${graph.nodes.length} nodes / ${graph.edges.length} edges`;
  renderGraphStats(nodeCounts, edgeCounts, edgeSignalCounts);

  renderCyGraph(graph);
}

async function loadHierarchy(topModule) {
  state.hierarchy = await apiRequest(`/api/project/hierarchy/${encodeURIComponent(topModule)}`);
  renderHierarchyTree();
}

async function loadGraph(moduleName, breadcrumb = null) {
  state.selectedModule = moduleName;
  if (breadcrumb) {
    state.breadcrumb = breadcrumb;
  } else if (!state.breadcrumb.length) {
    state.breadcrumb = [moduleName];
  }

  renderTopList();
  renderBreadcrumb();
  renderHierarchyTree();
  enforcePortViewMode();

  const params = new URLSearchParams({
    mode: getEffectiveGraphMode(),
    aggregate_edges: String(getEffectiveAggregateEdges()),
    port_view: String(state.portView),
    schematic: String(state.portView),
    schematic_mode: state.schematicMode,
  });

  const graph = await apiRequest(`/api/project/connectivity/${encodeURIComponent(moduleName)}?${params.toString()}`);
  state.graph = graph;
  state.selectedNode = null;
  state.selectedEdge = null;
  renderGraph(graph);
  renderInspector();
}

async function selectTop(topModule) {
  state.selectedTop = topModule;
  state.breadcrumb = [topModule];
  renderTopList();
  renderBreadcrumb();

  await loadHierarchy(topModule);
  await loadGraph(topModule, [topModule]);
}

async function refreshProject() {
  const [topsPayload, modulesPayload] = await Promise.all([
    apiRequest("/api/project/tops"),
    apiRequest("/api/project/modules"),
  ]);

  state.tops = topsPayload.top_candidates || [];
  state.modules = modulesPayload.modules || [];

  if (!state.tops.length) {
    state.selectedTop = null;
    state.selectedModule = null;
    state.hierarchy = null;
    state.breadcrumb = [];
    renderTopList();
    renderHierarchyTree();
    renderBreadcrumb();
    renderGraph(null);
    renderInspector();
    return;
  }

  const retainedTop = state.selectedTop && state.tops.includes(state.selectedTop) ? state.selectedTop : state.tops[0];
  await selectTop(retainedTop);
}

async function handleLoad() {
  const folder = folderInput ? folderInput.value.trim() : state.folder;
  if (!folder) {
    setStatus("Need folder path", "error");
    return;
  }

  state.folder = folder;
  state.parser = parserSelect ? parserSelect.value : state.parser;

  try {
    setStatus("Loading...", "busy");
    const summary = await apiRequest("/api/project/load", {
      method: "POST",
      body: JSON.stringify({ folder: state.folder, parser_backend: state.parser }),
    });

    state.summary = summary;
    renderInspector();
  } catch (error) {
    setStatus("Project load failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    renderGraph(null);
    return;
  }

  try {
    await refreshProject();
    renderInspector();
    setStatus(`Project loaded (${state.summary?.parser_backend || state.parser})`, "ok");
  } catch (error) {
    setStatus("Project loaded, refresh failed", "error");
    inspector.innerHTML = `
      <p>${escapeHtml(error.message)}</p>
      <p>Project parsing succeeded with parser: <strong>${escapeHtml(state.summary?.parser_backend || state.parser)}</strong></p>
    `;
    renderGraph(null);
  }
}

loadBtn?.addEventListener("click", handleLoad);
refreshBtn?.addEventListener("click", async () => {
  try {
    setStatus("Refreshing...", "busy");
    await refreshProject();
    setStatus("Refreshed", "ok");
  } catch (error) {
    setStatus("Refresh failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
});

statsToggle?.addEventListener("click", () => {
  const wrapper = statsToggle.closest(".stats-wrapper");
  const collapsed = wrapper.classList.toggle("collapsed");
  statsToggle.setAttribute("aria-expanded", String(!collapsed));
});

fitBtn?.addEventListener("click", () => {
  if (!state.cy || !state.cy.elements().length) {
    return;
  }
  state.cy.fit(undefined, 30);
});

showUnknownToggle?.addEventListener("change", () => {
  state.showUnknownEdges = showUnknownToggle.checked;
  if (!state.graph) {
    return;
  }

  renderGraph(state.graph);
  renderInspector();
});

portViewToggle?.addEventListener("change", async () => {
  state.portView = portViewToggle.checked;
  enforcePortViewMode();

  if (!state.selectedModule) {
    return;
  }

  try {
    setStatus("Updating ports...", "busy");
    await loadGraph(state.selectedModule, state.breadcrumb.length ? [...state.breadcrumb] : [state.selectedModule]);
    setStatus("Graph updated", "ok");
  } catch (error) {
    setStatus("Graph update failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
});


folderInput?.addEventListener("change", () => {
  state.folder = folderInput.value;
});


// ═══════════════════════════════════════════════════════════════════
// Schematic Search
// ═══════════════════════════════════════════════════════════════════

const searchBar = document.getElementById("schematicSearch");
const searchInput = document.getElementById("searchInput");
const searchCount = document.getElementById("searchCount");
const searchPrevBtn = document.getElementById("searchPrev");
const searchNextBtn = document.getElementById("searchNext");
const searchCloseBtn = document.getElementById("searchClose");

const searchState = {
  matches: [],      // array of Cytoscape node references
  activeIndex: -1,  // which match is currently focused
  query: "",
};

function openSearch() {
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchInput.value = "";
  clearSearchHighlights();
  searchCount.textContent = "";
  searchState.matches = [];
  searchState.activeIndex = -1;
  searchState.query = "";
  searchInput.blur();
}

function clearSearchHighlights() {
  if (!state.cy) return;
  state.cy.elements(".search-match, .search-active, .search-dimmed").removeClass("search-match search-active search-dimmed");
}

function getSearchableText(node) {
  const d = node.data();
  const kind = d.kind || "";
  // Only search the node's own visible name — not parent IDs or metadata
  // that would cause child ports to match their parent's name.
  switch (kind) {
    case "instance":
      return [d.instance_name, d.module_name].filter(Boolean).join(" ").toLowerCase();
    case "instance_port":
    case "process_port":
      return (d.port_name || d.display_label || "").toLowerCase();
    case "module_io":
      return (d.port_name || d.label || "").toLowerCase();
    case "netlabel_node":
      return (d.net_label_text || "").toLowerCase();
    case "always":
    case "gate":
    case "assign":
      return (d.label || "").toLowerCase();
    case "port_stub_anchor":
      return (d.port_name || "").toLowerCase();
    default:
      return (d.label || "").toLowerCase();
  }
}

function executeSearch(query) {
  clearSearchHighlights();
  searchState.query = query;
  searchState.matches = [];
  searchState.activeIndex = -1;

  if (!state.cy || !query.trim()) {
    searchCount.textContent = "";
    return;
  }

  const q = query.trim().toLowerCase();

  // Filter to visible, meaningful nodes (skip route_anchor, etc.)
  const skipKinds = new Set(["route_anchor"]);
  state.cy.nodes().forEach((node) => {
    const kind = node.data("kind");
    if (skipKinds.has(kind)) return;
    if (getSearchableText(node).includes(q)) {
      searchState.matches.push(node);
    }
  });

  if (searchState.matches.length === 0) {
    searchCount.textContent = "0 / 0";
    return;
  }

  // Highlight all matches and dim non-matches
  const matchCollection = state.cy.collection();
  searchState.matches.forEach((n) => matchCollection.merge(n));
  matchCollection.addClass("search-match");

  // Dim everything not matched
  state.cy.elements().not(matchCollection).not(matchCollection.connectedEdges()).addClass("search-dimmed");

  // Focus on the first match
  searchState.activeIndex = 0;
  goToActiveMatch();
}

function goToActiveMatch() {
  if (!state.cy || searchState.matches.length === 0) return;

  // Remove previous active highlight
  state.cy.nodes(".search-active").removeClass("search-active");

  const idx = searchState.activeIndex;
  const node = searchState.matches[idx];
  node.addClass("search-active");

  searchCount.textContent = `${idx + 1} / ${searchState.matches.length}`;

  // Center on the active match, zooming in if currently too far out
  const targetZoom = Math.max(state.cy.zoom(), 1);
  state.cy.animate({
    center: { eles: node },
    zoom: targetZoom,
    duration: 250,
  });
}

function searchNext() {
  if (searchState.matches.length === 0) return;
  searchState.activeIndex = (searchState.activeIndex + 1) % searchState.matches.length;
  goToActiveMatch();
}

function searchPrev() {
  if (searchState.matches.length === 0) return;
  searchState.activeIndex = (searchState.activeIndex - 1 + searchState.matches.length) % searchState.matches.length;
  goToActiveMatch();
}

// Debounce helper for live search
let searchTimeout = null;
searchInput?.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    executeSearch(searchInput.value);
  }, 200);
});

searchInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) {
      searchPrev();
    } else {
      searchNext();
    }
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});

searchNextBtn?.addEventListener("click", searchNext);
searchPrevBtn?.addEventListener("click", searchPrev);
searchCloseBtn?.addEventListener("click", closeSearch);

// Ctrl+F / Cmd+F to open search when graph canvas is present
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    // Only intercept if a graph is loaded
    if (state.cy && state.cy.elements().length) {
      e.preventDefault();
      openSearch();
    }
  }
});

populateProjectOptions();
enforcePortViewMode();
showUnknownToggle.checked = state.showUnknownEdges;
portViewToggle.checked = state.portView;

clearGraphStats();
renderBreadcrumb();
renderHierarchyTree();
renderInspector();

(async function init() {
  try {
    const health = await apiRequest("/api/health");
    if (health.status === "ok") {
      setStatus("API ready", "ok");
    }
  } catch {
    setStatus("API unavailable", "error");
  }
})();

// ═══════════════════════════════════════════════════════════════════
// Module source code editor
// ═══════════════════════════════════════════════════════════════════
const codeEditorState = {
  cm: null,
  module: null,
  path: null,
  original: "",
};

function ensureCodeMirror() {
  if (codeEditorState.cm) return codeEditorState.cm;
  const ta = document.getElementById("codeEditorTextarea");
  if (!ta || typeof CodeMirror === "undefined") return null;
  codeEditorState.cm = CodeMirror.fromTextArea(ta, {
    mode: "verilog",
    theme: "material-darker",
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    lineWrapping: false,
    matchBrackets: true,
  });
  return codeEditorState.cm;
}

function setEditorStatus(text) {
  const el = document.getElementById("codeEditorStatus");
  if (el) el.textContent = text || "";
}

async function openModuleCodeEditor(moduleName, options = {}) {
  const overlay = document.getElementById("codeEditorOverlay");
  const titleEl = document.getElementById("codeEditorTitle");
  const pathEl = document.getElementById("codeEditorPath");
  if (!overlay) return;

  overlay.classList.remove("hidden");
  titleEl.textContent = `Module Source — ${moduleName}`;
  pathEl.textContent = "Loading...";
  setEditorStatus("Loading...");

  const cm = ensureCodeMirror();
  if (cm) cm.setValue("");

  try {
    const data = await apiRequest(`/api/project/modules/${encodeURIComponent(moduleName)}/source`);
    codeEditorState.module = moduleName;
    codeEditorState.path = data.path || "";
    codeEditorState.original = data.content || "";
    pathEl.textContent = codeEditorState.path;
    if (cm) {
      cm.setValue(codeEditorState.original);
      cm.clearHistory();
      setTimeout(() => {
        cm.refresh();
        if (options.jumpToInstance) {
          jumpToInstantiation(cm, options.jumpToInstance);
        }
      }, 0);
    }
    if (!options.jumpToInstance) setEditorStatus("Loaded.");
  } catch (error) {
    setEditorStatus(`Failed to load: ${error.message}`);
    pathEl.textContent = "";
  }
}

function jumpToInstantiation(cm, target) {
  if (!cm || !target) return false;
  const { instanceName, childModule } = target;
  if (!childModule) {
    setEditorStatus("Missing child module name for instantiation lookup.");
    return false;
  }

  // Comment-stripped buffer (preserving offsets) so commented-out code is
  // ignored when locating the instantiation.
  const raw = cm.getValue();
  const sanitized = raw
    .replace(/\/\*[\s\S]*?\*\//g, (s) => " ".repeat(s.length))
    .replace(/\/\/[^\n]*/g, (s) => " ".repeat(s.length));

  const escapedChild = childModule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A Verilog instantiation looks like:
  //     <child_module> [#( params )] <instance_name> ( ... );
  // We try the most specific match first (with the instance name), then fall
  // back to just the child-module + identifier + `(` pattern.

  let identIndex = -1;
  let identLength = 0;

  if (instanceName) {
    const escapedInst = instanceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Allow optional `#(...)` parameter block between the type and the name.
    // Use a tolerant `[^;]*?` so multi-line param blocks still match, but the
    // `;` boundary keeps us from running across statements.
    const specific = new RegExp(
      `\\b${escapedChild}\\b[^;]*?\\b${escapedInst}\\b\\s*\\(`,
    );
    const m = specific.exec(sanitized);
    if (m) {
      identIndex = m.index + m[0].lastIndexOf(instanceName);
      identLength = instanceName.length;
    }
  }

  if (identIndex < 0) {
    // Fallback: any `<child_module> <ident> (` — useful when instance_name
    // is unknown or doesn't match (e.g. generate-block expansion).
    const generic = new RegExp(
      `\\b${escapedChild}\\b\\s*(?:#\\s*\\([^;]*?\\))?\\s*([A-Za-z_][A-Za-z0-9_$]*)\\s*\\(`,
    );
    const m = generic.exec(sanitized);
    if (m) {
      identIndex = m.index + m[0].indexOf(m[1]);
      identLength = m[1].length;
    }
  }

  if (identIndex < 0) {
    setEditorStatus(
      `Could not locate instantiation of "${childModule}"${instanceName ? ` (${instanceName})` : ""} in this file.`,
    );
    return false;
  }

  const fromPos = cm.posFromIndex(identIndex);
  const toPos = cm.posFromIndex(identIndex + identLength);

  cm.focus();
  cm.setSelection(fromPos, toPos);
  const margin = Math.floor(cm.getScrollerElement().offsetHeight / 3);
  cm.scrollIntoView({ from: fromPos, to: toPos }, margin);

  const lineHandle = cm.addLineClass(fromPos.line, "background", "cm-jump-highlight");
  setTimeout(() => {
    cm.removeLineClass(lineHandle, "background", "cm-jump-highlight");
  }, 1500);

  setEditorStatus(
    `Jumped to line ${fromPos.line + 1}: instantiation of ${childModule}${instanceName ? ` (${instanceName})` : ""}.`,
  );
  return true;
}

function closeModuleCodeEditor() {
  const overlay = document.getElementById("codeEditorOverlay");
  if (overlay) overlay.classList.add("hidden");
  codeEditorState.module = null;
  codeEditorState.path = null;
  codeEditorState.original = "";
}

async function saveModuleCodeEditor() {
  const cm = codeEditorState.cm;
  if (!cm || !codeEditorState.module) return;
  const content = cm.getValue();

  const saveBtn = document.getElementById("codeEditorSave");
  const discardBtn = document.getElementById("codeEditorDiscard");
  if (saveBtn) saveBtn.disabled = true;
  if (discardBtn) discardBtn.disabled = true;
  setEditorStatus("Saving and re-parsing project...");

  try {
    await apiRequest(`/api/project/modules/${encodeURIComponent(codeEditorState.module)}/source`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
    codeEditorState.original = content;
    setEditorStatus("Saved. Refreshing viewer...");

    // Re-parse already happened on the server. Refresh the project listing
    // and reload the currently focused module's graph so the viewer updates.
    try {
      await refreshProject();
      if (state.selectedModule) {
        await loadGraph(
          state.selectedModule,
          state.breadcrumb.length ? [...state.breadcrumb] : [state.selectedModule],
        );
      }
      setStatus("Module updated", "ok");
      setEditorStatus("Saved.");
    } catch (refreshErr) {
      setEditorStatus(`Saved, but refresh failed: ${refreshErr.message}`);
    }
  } catch (error) {
    setEditorStatus(`Save failed: ${error.message}`);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (discardBtn) discardBtn.disabled = false;
  }
}

function discardModuleCodeEditor() {
  const cm = codeEditorState.cm;
  if (!cm) return;
  cm.setValue(codeEditorState.original || "");
  setEditorStatus("Changes discarded.");
}

document.getElementById("codeEditorClose")?.addEventListener("click", closeModuleCodeEditor);
document.getElementById("codeEditorSave")?.addEventListener("click", saveModuleCodeEditor);
document.getElementById("codeEditorDiscard")?.addEventListener("click", discardModuleCodeEditor);
document.getElementById("codeEditorOverlay")?.addEventListener("click", (ev) => {
  if (ev.target && ev.target.id === "codeEditorOverlay") closeModuleCodeEditor();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    const overlay = document.getElementById("codeEditorOverlay");
    if (overlay && !overlay.classList.contains("hidden")) closeModuleCodeEditor();
  }
});
