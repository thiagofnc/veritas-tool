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
    label: "tracing test",
    folder: "C:\\Users\\costatf\\OneDrive - Rose-Hulman Institute of Technology\\Desktop\\Verilog Tool Project\\verilog-tool\\sample_projects\\05_tracer_path_lab",
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

const CUSTOM_PROJECT_VALUE = "__custom__";

const state = {
  folder: "",
  folderPreset: CUSTOM_PROJECT_VALUE,
  customFolder: "",
  parser: "pyverilog",
  leftSidebarTab: "modules",
  tops: [],
  modules: [],
  sourceFiles: [],
  unusedModules: [],
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
const folderPathInput = document.getElementById("folderPathInput");
const parserSelect = document.getElementById("parserSelect");
const loadBtn = document.getElementById("loadBtn");
const refreshBtn = document.getElementById("refreshBtn");
const fitBtn = document.getElementById("fitBtn");
const showUnknownToggle = document.getElementById("showUnknownToggle");
const portViewToggle = document.getElementById("portViewToggle");
const statusBadge = document.getElementById("statusBadge");
const topList = document.getElementById("topList");
const hierarchyTree = document.getElementById("hierarchyTree");
const sourceFileList = document.getElementById("sourceFileList");
const leftTabModules = document.getElementById("leftTabModules");
const leftTabFiles = document.getElementById("leftTabFiles");
const leftTabPanelModules = document.getElementById("leftTabPanelModules");
const leftTabPanelFiles = document.getElementById("leftTabPanelFiles");
const breadcrumbBar = document.getElementById("breadcrumbBar");
const graphTag = document.getElementById("graphTag");
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
  const customOption = document.createElement("option");
  customOption.value = CUSTOM_PROJECT_VALUE;
  customOption.textContent = "Custom path";
  folderInput.appendChild(customOption);

  for (const project of PROJECT_OPTIONS) {
    const option = document.createElement("option");
    option.value = project.folder;
    option.textContent = project.label;
    folderInput.appendChild(option);
  }

  syncFolderControls();
}

function syncFolderControls() {
  if (folderInput) {
    folderInput.value = state.folderPreset || CUSTOM_PROJECT_VALUE;
  }
  if (folderPathInput) {
    folderPathInput.value = state.customFolder || "";
    folderPathInput.disabled = (state.folderPreset || CUSTOM_PROJECT_VALUE) !== CUSTOM_PROJECT_VALUE;
  }
}

function getSelectedFolderPath() {
  if (folderInput?.value === CUSTOM_PROJECT_VALUE) {
    return folderPathInput ? folderPathInput.value.trim() : state.customFolder;
  }
  return folderInput ? folderInput.value.trim() : state.folder;
}

function updateFolderStateFromControls() {
  if (!folderInput) {
    return;
  }

  state.folderPreset = folderInput.value || CUSTOM_PROJECT_VALUE;
  state.folder = getSelectedFolderPath();

  if (folderPathInput) {
    if (state.folderPreset === CUSTOM_PROJECT_VALUE) {
      folderPathInput.value = state.customFolder || "";
      folderPathInput.disabled = false;
    } else {
      folderPathInput.value = state.folderPreset;
      folderPathInput.disabled = true;
    }
  }
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

  function shouldMarkUnusedModule(moduleName, node) {
    if (!moduleName || node?.unresolved) return false;
    if (state.tops.includes(moduleName)) return false;
    return state.unusedModules.includes(moduleName);
  }

  function canInstantiateModule(moduleName, node = null) {
    if (!moduleName) return false;
    if (node?.unresolved || node?.cycle) return false;
    return !state.tops.includes(moduleName);
  }

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
    button.dataset.moduleName = moduleName;
    if (moduleName === state.selectedModule) {
      button.classList.add("active");
    }

    button.textContent = flags.length ? `${moduleName} [${flags.join(",")}]` : moduleName;

    // Mark modules that are never instantiated by any other module.
    if (shouldMarkUnusedModule(moduleName, node)) {
      button.classList.add("unused");
    }

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

    // "Instantiate" action link — lets the user add this module as an instance in another module.
    if (canInstantiateModule(moduleName, node)) {
      const instLink = document.createElement("button");
      instLink.type = "button";
      instLink.className = "tree-action-link";
      instLink.textContent = "instantiate";
      instLink.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openInstantiateDialog(moduleName);
      });
      item.appendChild(instLink);
    }

    const instances = node.instances || [];
    if (instances.length) {
      const childList = document.createElement("ul");
      childList.className = "tree-group";

      for (const child of instances) {
        const childItem = document.createElement("li");
        childItem.className = "tree-item";

        const line = document.createElement("div");
        line.className = "tree-instance-line";
        if (child.instance) line.dataset.instanceName = child.instance;
        if (child.module) line.dataset.moduleName = child.module;
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

  // ── Orphan modules: defined in the project but not in the hierarchy tree ──
  const treeModules = new Set();
  (function collectTreeModules(node) {
    if (node.module) treeModules.add(node.module);
    for (const child of node.instances || []) {
      if (child.children) collectTreeModules(child.children);
    }
  })(state.hierarchy);

  const orphans = state.modules.filter((name) => !treeModules.has(name));
  if (orphans.length) {
    const heading = document.createElement("h4");
    heading.className = "orphan-heading";
    heading.textContent = "Not in hierarchy";
    hierarchyTree.appendChild(heading);

    const orphanList = document.createElement("ul");
    orphanList.className = "tree-root orphan-list";

    for (const name of orphans) {
      const li = document.createElement("li");
      li.className = "tree-item";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-module-btn orphan";
      btn.textContent = name;
      btn.addEventListener("click", async () => {
        try {
          setStatus("Loading graph...", "busy");
          await loadGraph(name, [name]);
          setStatus("Graph loaded", "ok");
        } catch (error) {
          setStatus("Graph load failed", "error");
          inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
        }
      });
      li.appendChild(btn);

      if (!state.tops.includes(name)) {
        const instLink = document.createElement("button");
        instLink.type = "button";
        instLink.className = "tree-action-link";
        instLink.textContent = "instantiate";
        instLink.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openInstantiateDialog(name);
        });
        li.appendChild(instLink);
      }

      orphanList.appendChild(li);
    }
    hierarchyTree.appendChild(orphanList);
  }
}

function renderSourceFileList() {
  if (!sourceFileList) return;
  sourceFileList.innerHTML = "";

  if (!state.sourceFiles.length) {
    sourceFileList.innerHTML = '<p class="source-file-empty">Load a project to browse source files.</p>';
    return;
  }

  for (const file of state.sourceFiles) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source-file-btn";

    const name = document.createElement("span");
    name.className = "source-file-name";
    name.textContent = file.name || "untitled";
    button.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "source-file-meta";
    meta.textContent = (file.modules && file.modules.length)
      ? `modules: ${file.modules.join(", ")}`
      : "no modules defined";
    button.appendChild(meta);

    button.title = file.path || file.name || "";
    button.addEventListener("click", () => {
      if (file.path) openSourceFileEditor(file.path);
    });
    sourceFileList.appendChild(button);
  }
}

function setLeftSidebarTab(tabName) {
  state.leftSidebarTab = tabName === "files" ? "files" : "modules";
  const modulesActive = state.leftSidebarTab === "modules";
  leftTabModules?.classList.toggle("active", modulesActive);
  leftTabModules?.setAttribute("aria-selected", String(modulesActive));
  leftTabFiles?.classList.toggle("active", !modulesActive);
  leftTabFiles?.setAttribute("aria-selected", String(!modulesActive));
  leftTabPanelModules?.classList.toggle("active", modulesActive);
  leftTabPanelFiles?.classList.toggle("active", !modulesActive);
  if (leftTabPanelModules) leftTabPanelModules.hidden = !modulesActive;
  if (leftTabPanelFiles) leftTabPanelFiles.hidden = modulesActive;
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
      // ── Unconnected ports (highlighted red) ─────────────────
      {
        selector: 'node[kind = "instance_port"][connected = 0]',
        style: {
          "background-color": "#ef4444",
          "border-color": "#7f1d1d",
          "border-width": 2,
          color: "#fca5a5",
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
        selector: "node.signal-trace-step-active",
        style: {
          "border-color": "#f59e0b",
          "border-width": 4,
          "z-index": 200,
          opacity: 1,
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
      // ── Cross-module trace highlight (schematic overlay) ───
      {
        selector: "node.xtrace-hit",
        style: {
          "border-color": "#f59e0b",
          "border-width": 2.5,
          "z-index": 150,
        },
      },
      {
        selector: "node.xtrace-active",
        style: {
          "border-color": "#22d3ee",
          "border-width": 3,
          "z-index": 160,
        },
      },
      {
        selector: "edge.xtrace-hit",
        style: {
          "line-color": "#f59e0b",
          "target-arrow-color": "#f59e0b",
          width: 2.5,
          "line-opacity": 1,
          "z-index": 150,
        },
      },
      {
        selector: "node.xtrace-dimmed",
        style: {
          opacity: 0.15,
        },
      },
      {
        selector: "edge.xtrace-dimmed",
        style: {
          opacity: 0.06,
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
      ".signal-trace-upstream, .signal-trace-downstream, .signal-trace-origin, .signal-trace-dimmed, .signal-trace-step-active"
    ).removeClass(
      "signal-trace-upstream signal-trace-downstream signal-trace-origin signal-trace-dimmed signal-trace-step-active"
    );
    state.signalTrace = null;
    clearLocalTraceSteps();
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

  function applySignalTrace(startPortId, keepHistory) {
    if (!keepHistory) signalTraceHistory.length = 0;
    // Cap history stacks
    while (signalTraceHistory.length > TRACE_HISTORY_CAP) signalTraceHistory.shift();
    while (signalTraceFuture.length > TRACE_HISTORY_CAP) signalTraceFuture.shift();
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

    // Build local step-through list from the trace
    localTraceStepList = buildLocalTraceStepList(trace);
    localTraceStepIndex = 0; // start at origin

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

  });

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
        connected: node.connected === false ? 0 : 1,
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
        connected: node.connected === false ? 0 : 1,
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

function distributeColumns(columnEntries, startX, minGap = 300, columnProtrusions = null) {
  let nextLeft = startX;

  columnEntries.forEach((entry, i) => {
    const widths = entry.nodes.map((node) => node.outerWidth());
    const columnWidth = widths.length ? Math.max(...widths) : 0;
    const centerX = nextLeft + columnWidth / 2;
    entry.nodes.forEach((node) => {
      node.position({ x: centerX, y: node.position("y") });
    });
    // Ensure the gap between columns accounts for netlabel/stub protrusions
    // on the right side of this column and the left side of the next column.
    let gap = minGap;
    if (columnProtrusions && i + 1 < columnEntries.length) {
      const rightProt = columnProtrusions[i].right;
      const leftProt = columnProtrusions[i + 1].left;
      gap = Math.max(minGap, rightProt + leftProt + 40);
    }
    nextLeft += columnWidth + gap;
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

  // Compute per-column netlabel protrusions so distributeColumns leaves
  // enough horizontal room for netlabel rectangles on each side.
  const netlabelNodes = state.cy.nodes('[kind = "netlabel_node"]');
  const columnProtrusions = levelColumns.map(() => ({ left: 0, right: 0 }));

  if (netlabelNodes.length) {
    // Map each instance id to its column index, then map ports through it.
    const instanceToColumn = new Map();
    levelColumns.forEach((entry, colIdx) => {
      entry.nodes.forEach((instNode) => {
        instanceToColumn.set(instNode.id(), colIdx);
      });
    });

    const portToColumn = new Map();
    state.cy.nodes('[kind = "instance_port"], [kind = "process_port"]').forEach((portNode) => {
      const instId = portNode.data("instance_node_id") || portNode.data("process_node_id");
      const colIdx = instanceToColumn.get(instId);
      if (colIdx !== undefined) {
        portToColumn.set(portNode.id(), colIdx);
      }
    });

    netlabelNodes.forEach((nl) => {
      const portId = nl.data("connected_port");
      const colIdx = portToColumn.get(portId);
      if (colIdx === undefined) {
        return;
      }
      const labelWidth = nl.data("label_width") || 50;
      const protrusion = NETLABEL_WIRE_GAP + labelWidth;
      const portNode = state.cy.getElementById(portId);
      const dir = String(portNode.data("direction") || "").toLowerCase();
      if (dir === "output") {
        columnProtrusions[colIdx].right = Math.max(columnProtrusions[colIdx].right, protrusion);
      } else {
        columnProtrusions[colIdx].left = Math.max(columnProtrusions[colIdx].left, protrusion);
      }
    });
  }

  distributeColumns(levelColumns, INSTANCE_COLUMN_START - 40, INSTANCE_MIN_COLUMN_GAP, columnProtrusions);
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

  // Resolve vertical overlaps: after ports are placed, instances whose port
  // stacks extend beyond their own bounds may overlap vertically.
  levelColumns.forEach((entry) => {
    const sorted = [...entry.nodes]
      .filter((n) => n && !n.empty())
      .sort((a, b) => a.position("y") - b.position("y"));

    let lastBottom = null;
    for (const node of sorted) {
      const instId = node.id();
      const nodeY = node.position("y");
      const baseHH = getNodeHalfSize(node).halfHeight;
      let topY = nodeY - baseHH;
      let bottomY = nodeY + baseHH;

      // Expand bounds to include port nodes.
      const portNodes = state.cy.nodes('[kind = "instance_port"], [kind = "process_port"]').filter((p) =>
        p.data("instance_node_id") === instId || p.data("process_node_id") === instId);
      portNodes.forEach((p) => {
        topY = Math.min(topY, p.position("y") - 10);
        bottomY = Math.max(bottomY, p.position("y") + 10);
      });

      if (lastBottom !== null && topY < lastBottom + LAYOUT_GRID) {
        const shift = lastBottom + LAYOUT_GRID - topY;
        node.position({ x: node.position("x"), y: nodeY + shift });
        portNodes.forEach((p) => {
          p.position({ x: p.position("x"), y: p.position("y") + shift });
        });
        bottomY += shift;
      }

      lastBottom = bottomY;
    }
  });

  const allBlockNodes = instanceNodes.union(logicNodes);
  const leftBounds = allBlockNodes.map((node) => node.position("x") - getNodeHalfSize(node).halfWidth);
  const rightBounds = allBlockNodes.map((node) => node.position("x") + getNodeHalfSize(node).halfWidth);
  const minLeft = Math.min(...leftBounds);
  const maxRight = Math.max(...rightBounds);

  // Compute dynamic IO margin: ensure enough space for tip labels + netlabels
  // on both the module_io side and the outermost instance column side.
  let maxTipLabelWidth = 0;
  state.cy.nodes('[kind = "module_io_tip_label"]').forEach((tl) => {
    maxTipLabelWidth = Math.max(maxTipLabelWidth, tl.data("label_width") || 56);
  });
  let maxIoNetlabelWidth = 0;
  let maxEdgeInstanceNetlabelWidth = 0;
  netlabelNodes.forEach((nl) => {
    const portNode = state.cy.getElementById(nl.data("connected_port"));
    if (!portNode || portNode.empty()) {
      return;
    }
    const lw = nl.data("label_width") || 50;
    if (portNode.data("kind") === "module_io") {
      maxIoNetlabelWidth = Math.max(maxIoNetlabelWidth, lw);
    } else if (portNode.data("kind") === "instance_port" || portNode.data("kind") === "process_port") {
      // Check if this port belongs to an edge column (first or last).
      const instId = portNode.data("instance_node_id") || portNode.data("process_node_id");
      if (instId && levelColumns.length) {
        const firstCol = levelColumns[0].nodes.some((n) => n.id() === instId);
        const lastCol = levelColumns[levelColumns.length - 1].nodes.some((n) => n.id() === instId);
        if (firstCol || lastCol) {
          maxEdgeInstanceNetlabelWidth = Math.max(maxEdgeInstanceNetlabelWidth, lw);
        }
      }
    }
  });
  const ioNetlabelSpace = maxIoNetlabelWidth > 0 ? NETLABEL_WIRE_GAP + maxIoNetlabelWidth : 0;
  const edgeInstanceNetlabelSpace = maxEdgeInstanceNetlabelWidth > 0 ? NETLABEL_WIRE_GAP + maxEdgeInstanceNetlabelWidth : 0;
  const dynamicIoMargin = Math.max(IO_COLUMN_MARGIN,
    maxTipLabelWidth + ioNetlabelSpace + edgeInstanceNetlabelSpace + 80);

  placeModuleIoNodes(graph, snapToGrid(minLeft - dynamicIoMargin), snapToGrid(maxRight + dynamicIoMargin));
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
    if (node.kind === "netlabel_node") {
      const sig = node.net_label_text || node.label;
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

function clearCrossTraceHighlights() {
  if (state.cy) {
    state.cy.elements(".xtrace-hit, .xtrace-active, .xtrace-dimmed")
      .removeClass("xtrace-hit xtrace-active xtrace-dimmed");
  }
  document.querySelectorAll(".tree-module-btn.xtrace-highlight").forEach((el) => {
    el.classList.remove("xtrace-highlight");
  });
  document.querySelectorAll(".tree-instance-line.xtrace-highlight").forEach((el) => {
    el.classList.remove("xtrace-highlight");
  });
}

function applyCrossTraceHighlights(trace) {
  if (!state.cy || !state.graph) return;
  clearCrossTraceHighlights();

  const currentModule = state.selectedModule || "";
  const allHops = [...(trace.fanin || []), ...(trace.fanout || [])];
  const origin = trace.origin || {};

  // 1. Collect exact current-scope instance names plus module names touched by the trace.
  const traceModules = new Set();
  const traceInstances = new Set();
  if (origin.module) traceModules.add(origin.module);
  for (const hop of allHops) {
    if (hop.module) traceModules.add(hop.module);
    if (hop.next_module) traceModules.add(hop.next_module);
    if (hop.module === currentModule && hop.instance_name) {
      traceInstances.add(hop.instance_name);
    }
  }

  // 2. Collect signal names that belong to the CURRENT module's scope.
  //    These are the ones we can actually highlight on the schematic.
  const localSignals = new Set();
  if (origin.module === currentModule && origin.signal) localSignals.add(origin.signal);
  for (const hop of allHops) {
    if (hop.module === currentModule && hop.signal) localSignals.add(hop.signal);
    // When a signal crosses into/out of this module, the next_signal is also local
    if (hop.next_module === currentModule && hop.next_signal) localSignals.add(hop.next_signal);
  }

  // If no signals belong to the current module, still highlight instances.
  // 3. Build a set of net names from the graph edges that match local signals.
  //    Graph edges carry the parent-scope net names that connect ports.
  const hitNetNames = new Set();
  for (const edge of (state.graph.edges || [])) {
    const netName = summarizeEdgeNetName(edge);
    if (netName && localSignals.has(netName)) {
      hitNetNames.add(netName);
    }
  }
  // Also add the local signal names directly — module_io port_name matches these.
  for (const sig of localSignals) hitNetNames.add(sig);

  // 4. Dim everything, then highlight matches.
  state.cy.elements().addClass("xtrace-dimmed");

  const undim = (ele, cls) => {
    ele.removeClass("xtrace-dimmed").addClass(cls || "xtrace-hit");
  };

  // Pass 1: Highlight nodes.
  state.cy.nodes().forEach((node) => {
    const data = node.data();

    // Instance blocks must match the specific traced instance name in the
    // current module, not just the child module type. Otherwise every MUX,
    // register file, etc. lights up when only one instance is related.
    if (data.kind === "instance" && data.instance_name && traceInstances.has(data.instance_name)) {
      undim(node);
      return;
    }

    // Module IO ports whose port_name matches a local signal
    if (data.kind === "module_io") {
      const pn = data.port_name || "";
      if (pn && hitNetNames.has(pn)) {
        undim(node);
        return;
      }
    }

    // Instance ports — check if the net connecting them is a traced signal.
    // We do this by checking connected edges' net names.
    if (data.kind === "instance_port" || data.kind === "process_port") {
      const connEdges = node.connectedEdges();
      let matched = false;
      connEdges.forEach((e) => {
        const en = e.data("net") || e.data("signal_name") || (e.data("nets") && e.data("nets")[0]) || "";
        if (en && hitNetNames.has(en)) matched = true;
      });
      if (matched) {
        undim(node);
        // Also un-dim parent instance
        const pid = data.instance_node_id || data.parent_node_id || data.process_node_id;
        if (pid) {
          const parent = state.cy.getElementById(pid);
          if (parent && !parent.empty()) undim(parent);
        }
        return;
      }
    }

    // Net nodes (if they exist) whose label matches
    if (data.kind === "net") {
      const lbl = data.label || "";
      if (lbl && hitNetNames.has(lbl)) {
        undim(node);
        return;
      }
    }

    // Netlabel nodes
    if (data.kind === "netlabel_node") {
      const nlText = data.net_label_text || "";
      if (nlText && hitNetNames.has(nlText)) {
        undim(node);
      }
    }
  });

  // Pass 2: Highlight edges whose net name matches, or whose endpoints are both highlighted.
  state.cy.edges().forEach((edge) => {
    const data = edge.data();
    const netName = data.net || data.signal_name || (data.nets && data.nets[0]) || "";

    if (netName && hitNetNames.has(netName)) {
      undim(edge);
      // Un-dim route anchors
      [data.source, data.target].forEach((id) => {
        const n = state.cy.getElementById(id);
        if (n && !n.empty() && n.data("kind") === "route_anchor") undim(n);
      });
      return;
    }

    // Netlabel stubs
    if (data.netlabel_stub) {
      const src = state.cy.getElementById(data.source);
      const tgt = state.cy.getElementById(data.target);
      if ((src && src.hasClass("xtrace-hit")) || (tgt && tgt.hasClass("xtrace-hit"))) {
        undim(edge);
      }
      return;
    }

    // Route segments
    if (data.route_segment) {
      const routeId = data.route_id;
      // Check if any non-anchor endpoint in this route is highlighted
      if (routeId) {
        const routeEdges = state.cy.edges(`[route_id = "${routeId}"]`);
        let anyHit = false;
        routeEdges.forEach((re) => {
          const s = state.cy.getElementById(re.data("source"));
          const t = state.cy.getElementById(re.data("target"));
          if ((s && s.hasClass("xtrace-hit") && s.data("kind") !== "route_anchor") ||
              (t && t.hasClass("xtrace-hit") && t.data("kind") !== "route_anchor")) {
            anyHit = true;
          }
        });
        if (anyHit) {
          // Highlight the entire route
          routeEdges.forEach((re) => {
            undim(re);
            [re.data("source"), re.data("target")].forEach((id) => {
              const n = state.cy.getElementById(id);
              if (n && !n.empty() && n.data("kind") === "route_anchor") undim(n);
            });
          });
        }
      }
      return;
    }

    // Generic: both endpoints highlighted
    const src = state.cy.getElementById(data.source);
    const tgt = state.cy.getElementById(data.target);
    if (src && tgt && src.hasClass("xtrace-hit") && tgt.hasClass("xtrace-hit")) {
      undim(edge);
    }
  });

  // 5. Highlight exact instances in the hierarchy tree, plus the currently
  // inspected module button so users keep orientation without lighting up
  // every repeated module type.
  document.querySelectorAll(".tree-instance-line").forEach((line) => {
    const instanceName = line.dataset.instanceName || "";
    if (instanceName && traceInstances.has(instanceName)) {
      line.classList.add("xtrace-highlight");
    }
  });

  document.querySelectorAll(".tree-module-btn").forEach((btn) => {
    const modName = btn.dataset.moduleName || btn.textContent.trim().replace(/\s*\[.*\]$/, "");
    if (modName === currentModule || (origin.module && modName === origin.module)) {
      btn.classList.add("xtrace-highlight");
    }
  });
}

// Cross-module trace navigation history for forward stepping.
const TRACE_HISTORY_CAP = 50;
const crossTraceHistory = [];
const crossTraceFuture = [];

// Step-through state for walking the local trace path one node at a time.
let localTraceStepList = [];   // flat ordered list of waypoints in the current schematic
let localTraceStepIndex = -1;  // current active step (-1 = none)

// Build a linear step list from the local trace.
// Each step: { portId, cyNode (resolved later), description, detail, color }
// Order: downstream steps in BFS order (origin first, then each waypoint
// the signal flows through in the current schematic).
function buildLocalTraceStepList(trace) {
  if (!trace || !state.cy) return [];
  const steps = [];

  // Helper: look up the parent instance/block data from the graph
  function getParentData(portId) {
    const node = state.cy.getElementById(portId);
    if (!node || node.empty()) return null;
    const d = node.data();
    const pid = d.parent_node_id || d.instance_node_id || d.process_node_id;
    if (!pid) return null;
    const parent = state.cy.getElementById(pid);
    if (!parent || parent.empty()) return null;
    return parent.data();
  }

  // Describe what is happening at a step
  function describeStep(step) {
    const node = state.cy.getElementById(step.portId);
    if (!node || node.empty()) return { desc: step.portName, detail: "" };
    const d = node.data();
    const kind = d.kind || "";
    const parentData = getParentData(step.portId);

    // Module IO ports
    if (kind === "module_io") {
      const dir = (d.direction || "").toLowerCase();
      if (dir === "input") {
        return { desc: `Module input: ${step.portName}`, detail: "Signal enters this module from outside" };
      }
      if (dir === "output") {
        return { desc: `Module output: ${step.portName}`, detail: "Signal leaves this module" };
      }
      return { desc: `Module port: ${step.portName}`, detail: "" };
    }

    // Instance/process ports
    if (kind === "instance_port" || kind === "process_port") {
      const dir = (d.direction || "").toLowerCase();
      const instLabel = step.parentLabel || "(block)";
      const netInfo = step.netName ? ` via ${step.netName}` : "";

      if (step.crossedInstance) {
        // This is an output of an instance the signal passed through
        if (parentData) {
          const modType = parentData.module_name || parentData.always_kind || parentData.gate_type || "";
          const modInfo = modType ? ` (${modType})` : "";
          return {
            desc: `${instLabel}${modInfo} produces ${step.portName}`,
            detail: `Signal passes through ${instLabel} and exits as ${step.portName}`,
          };
        }
        return { desc: `${instLabel} produces ${step.portName}`, detail: "Signal exits this block" };
      }

      if (dir === "input") {
        return {
          desc: `${step.portName} enters ${instLabel}`,
          detail: `Signal${netInfo} connects to input ${step.portName} of ${instLabel}`,
        };
      }
      if (dir === "output") {
        return {
          desc: `${instLabel} drives ${step.portName}`,
          detail: `Output ${step.portName} of ${instLabel}`,
        };
      }
      return { desc: `${instLabel}.${step.portName}`, detail: netInfo };
    }

    return { desc: step.portName || step.portId, detail: "" };
  }

  // Origin step
  const origin = trace.origin;
  const originDesc = describeStep(origin);
  steps.push({
    portId: origin.portId,
    portName: origin.portName,
    parentLabel: origin.parentLabel,
    direction: "origin",
    color: "#22d3ee",
    ...originDesc,
  });

  // Downstream steps (signal flows forward from origin)
  for (const step of trace.downstream) {
    const desc = describeStep(step);
    steps.push({
      portId: step.portId,
      portName: step.portName,
      parentLabel: step.parentLabel,
      netName: step.netName,
      crossedInstance: step.crossedInstance,
      direction: "downstream",
      color: "#60a5fa",
      ...desc,
    });
  }

  return steps;
}

function goToLocalTraceStep(index) {
  if (index < 0 || index >= localTraceStepList.length || !state.cy) return;
  localTraceStepIndex = index;
  const step = localTraceStepList[index];

  // Clear previous step-active highlight
  state.cy.nodes(".signal-trace-step-active").removeClass("signal-trace-step-active");

  // Find and center on the node
  const node = state.cy.getElementById(step.portId);
  if (node && !node.empty()) {
    node.removeClass("signal-trace-dimmed").addClass("signal-trace-step-active");
    // Also un-dim parent instance
    const pid = node.data("parent_node_id") || node.data("instance_node_id") || node.data("process_node_id");
    if (pid) {
      const parent = state.cy.getElementById(pid);
      if (parent && !parent.empty()) parent.removeClass("signal-trace-dimmed");
    }
    const targetZoom = Math.max(state.cy.zoom(), 1);
    state.cy.animate({
      center: { eles: node },
      zoom: targetZoom,
      duration: 250,
    });
  }

  // Re-render the panel so button states and description update
  if (state.signalTrace) {
    renderSignalTracePanel(state.signalTrace);
  }
}

function localTraceStepNext() {
  if (localTraceStepList.length === 0) return;
  const next = localTraceStepIndex + 1;
  if (next < localTraceStepList.length) goToLocalTraceStep(next);
}

function localTraceStepPrev() {
  if (localTraceStepList.length === 0) return;
  const prev = localTraceStepIndex - 1;
  if (prev >= 0) goToLocalTraceStep(prev);
}

function clearLocalTraceSteps() {
  localTraceStepList = [];
  localTraceStepIndex = -1;
  if (state.cy) state.cy.nodes(".signal-trace-step-active").removeClass("signal-trace-step-active");
}

function focusTracePort(portId, { stepIndex = null, animate = true } = {}) {
  if (!portId || !state.cy) return;
  if (typeof stepIndex === "number" && stepIndex >= 0 && stepIndex < localTraceStepList.length) {
    goToLocalTraceStep(stepIndex);
    return;
  }

  const node = state.cy.getElementById(portId);
  if (!node || node.empty()) return;

  const targetZoom = Math.max(state.cy.zoom(), 1);
  state.cy.animate({
    center: { eles: node },
    zoom: targetZoom,
    duration: animate ? 250 : 0,
  });
}

async function requestCrossModuleTrace(moduleName, signal, keepHistory) {
  if (!keepHistory) {
    crossTraceHistory.length = 0;
    crossTraceFuture.length = 0;
  }
  // Cap history stacks
  while (crossTraceHistory.length > TRACE_HISTORY_CAP) crossTraceHistory.shift();
  while (crossTraceFuture.length > TRACE_HISTORY_CAP) crossTraceFuture.shift();

  try {
    setStatus(`Tracing ${moduleName}.${signal}...`, "loading");
    // Show inline loading indicator on the panel if it exists
    const existingPanel = document.getElementById("crossTracePanel");
    if (existingPanel) {
      existingPanel.style.opacity = "0.5";
      existingPanel.style.pointerEvents = "none";
    }
    const response = await fetch(`${API_BASE}/api/signal/trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: moduleName, signal, max_hops: 160 }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }
    const trace = await response.json();
    applyCrossTraceHighlights(trace);
    renderCrossModuleTracePanel(trace);

    setStatus(
      `Trace: ${trace.fanin.length} upstream, ${trace.fanout.length} downstream${trace.truncated ? " (truncated)" : ""}`,
      "ok"
    );
  } catch (exc) {
    setStatus(`Trace failed: ${exc.message || exc}`, "error");
  } finally {
    // Always restore the panel to interactive state
    const panel = document.getElementById("crossTracePanel");
    if (panel) {
      panel.style.opacity = "";
      panel.style.pointerEvents = "";
    }
  }
}

// ── Trace rendering: role/op helpers ────────────────────────────────────
const TRACE_ROLE_STYLE = {
  driver:    { color: "#22d3ee", label: "DRIVER",     tip: "This signal drives the traced path" },
  compute:   { color: "#facc15", label: "COMPUTE",    tip: "Combinational logic that transforms the signal" },
  pipeline:  { color: "#f472b6", label: "SEQUENTIAL", tip: "Clocked register / pipeline stage (non-blocking assignment)" },
  transport: { color: "#a1a1aa", label: "TRANSPORT",  tip: "Signal passes through a module boundary or instance pin" },
  load:      { color: "#60a5fa", label: "LOAD",       tip: "This signal is consumed here" },
  dead_end:  { color: "#ef4444", label: "DEAD END",   tip: "No further connections found in this direction" },
  unknown:   { color: "#71717a", label: "STEP",       tip: "Trace step" },
};

const TRACE_OP_BADGE = {
  arithmetic: { color: "#fb923c", label: "+\u2212\u00d7", tip: "Arithmetic operation (add, subtract, multiply, shift)" },
  comparison: { color: "#a78bfa", label: "=?",  tip: "Comparison operation (==, !=, <, >)" },
  logic:      { color: "#34d399", label: "&|^", tip: "Bitwise/logic operation (AND, OR, XOR, NOT)" },
  mux:        { color: "#e879f9", label: "MUX", tip: "Multiplexer / conditional select (ternary, case)" },
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
      `<span title="${escapeHtml(badge.tip || badge.label)}" style="background:rgba(255,255,255,0.04);color:${badge.color};padding:0 5px;border-radius:8px;font-size:9px;margin-left:4px;border:1px solid ${badge.color}33;cursor:help;">${badge.label}</span>`
    );
  }
  return parts.join("");
}

let crossTraceStepList = [];
let crossTraceStepIndex = -1;

function flattenTraceChainHops(chains) {
  const seen = new Set();
  const hops = [];
  for (const chain of chains || []) {
    for (const hop of chain || []) {
      const key = [
        hop.module || "",
        hop.signal || "",
        hop.kind || "",
        hop.detail || "",
        hop.next_module || "",
        hop.next_signal || "",
      ].join("::");
      if (seen.has(key)) continue;
      seen.add(key);
      hops.push(hop);
    }
  }
  return hops;
}

function buildExpandedTraceGroups(trace) {
  const upstreamSource = (trace?.chains?.fanin && trace.chains.fanin.length)
    ? trace.chains.fanin
    : (trace?.fanin || []).map((hop) => [hop]);
  const downstreamSource = (trace?.chains?.fanout && trace.chains.fanout.length)
    ? trace.chains.fanout
    : (trace?.fanout || []).map((hop) => [hop]);
  const upstreamHops = flattenTraceChainHops(upstreamSource);
  const downstreamHops = flattenTraceChainHops(downstreamSource);
  return {
    fanin: groupTraceHops(upstreamHops),
    fanout: groupTraceHops(downstreamHops),
  };
}

function buildCrossTraceStepList(groupedFanin, groupedFanout) {
  const steps = [];
  const addStep = (group, direction) => {
    steps.push({
      direction,
      module: group.next_module || group.module,
      signal: group.next_signal || group.signal,
      label: formatHopHeadline(group),
      detail: group.detail || "",
    });
  };

  [...groupedFanin].reverse().forEach((group) => addStep(group, "fanin"));
  groupedFanout.forEach((group) => addStep(group, "fanout"));
  return steps;
}

function findCrossTraceFocusElement(signal) {
  if (!state.cy || !signal) return null;

  const exactNode = state.cy.nodes().filter((node) => {
    const data = node.data();
    if (data.kind === "module_io") return (data.port_name || "") === signal;
    if (data.kind === "netlabel_node") return (data.net_label_text || "") === signal;
    if (data.kind === "net") return (data.label || "") === signal;
    return false;
  });
  if (exactNode.length) return exactNode[0];

  const portNode = state.cy.nodes().filter((node) => {
    const data = node.data();
    if (data.kind !== "instance_port" && data.kind !== "process_port") return false;
    return node.connectedEdges().some((edge) => summarizeEdgeNetName(edge.data()) === signal);
  });
  if (portNode.length) return portNode[0];

  const edge = state.cy.edges().filter((candidate) => summarizeEdgeNetName(candidate.data()) === signal);
  if (edge.length) return edge[0];

  return null;
}

async function goToCrossTraceStep(index, trace) {
  if (!trace) return;
  if (index < 0 || index >= crossTraceStepList.length) return;
  crossTraceStepIndex = index;

  const step = crossTraceStepList[index];
  if (step && step.module && step.module !== state.selectedModule) {
    await loadGraph(step.module);
    applyCrossTraceHighlights(trace);
  }

  if (state.cy) {
    state.cy.elements(".xtrace-active").removeClass("xtrace-active");
    const target = findCrossTraceFocusElement(step?.signal || "");
    if (target && !target.empty()) {
      target.addClass("xtrace-active");
      const centerEles = target.isEdge && target.isEdge() ? target.connectedNodes() : target;
      state.cy.animate({
        center: { eles: centerEles },
        zoom: Math.max(state.cy.zoom(), 1),
        duration: 250,
      });
    }
  }

  const panel = document.getElementById("crossTracePanel");
  if (!panel) return;

  panel.querySelectorAll(".xtrace-hop").forEach((row) => {
    row.style.outline = "";
    row.style.background = "rgba(255,255,255,0.025)";
  });

  const row = panel.querySelector(`.xtrace-hop[data-step-index="${index}"]`);
  if (row) {
    row.style.outline = "1.5px solid #f59e0b";
    row.style.background = "rgba(245,158,11,0.08)";
    setTimeout(() => row.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
  }

  renderCrossModuleTracePanel(trace);
}

async function crossTraceStepPrev(trace) {
  if (crossTraceStepList.length === 0) return;
  await goToCrossTraceStep(Math.max(0, crossTraceStepIndex - 1), trace);
}

async function crossTraceStepNext(trace) {
  if (crossTraceStepList.length === 0) return;
  await goToCrossTraceStep(Math.min(crossTraceStepList.length - 1, crossTraceStepIndex + 1), trace);
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
      background: #18181b; border: 1px solid rgba(255,255,255,0.10); border-radius: 6px;
      padding: 14px 16px; min-width: 320px; max-width: 480px;
      max-height: 78vh; overflow-y: auto; color: #e4e4e7;
      font-family: 'IBM Plex Mono', Consolas, Monaco, monospace; font-size: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    `;
    const canvas = document.getElementById("graphCanvas");
    if (canvas) canvas.appendChild(panel);
  }

  const expandedGroups = buildExpandedTraceGroups(trace);
  const groupedFanin = expandedGroups.fanin;
  const groupedFanout = expandedGroups.fanout;
  crossTraceStepList = buildCrossTraceStepList(groupedFanin, groupedFanout);
  if (crossTraceStepIndex < 0 || crossTraceStepIndex >= crossTraceStepList.length) {
    crossTraceStepIndex = crossTraceStepList.length ? 0 : -1;
  }

  const renderHop = (group, accentColor, index, direction, stepIndex) => {
    const roleStyle = traceRoleStyle(group.role);
    const headline = formatHopHeadline(group);
    const badges = renderTraceBadges(group);
    const crossIcon = group.crosses === "down" ? " \u2193" : group.crosses === "up" ? " \u2191" : "";
    const stepLabel = direction === "fanin" ? "Step backward" : "Step forward";

    return `
      <div class="xtrace-hop" data-hop-dir="${direction}" data-hop-idx="${index}" data-step-index="${stepIndex}" data-trace-module="${escapeHtml(group.next_module || group.module)}" data-trace-signal="${escapeHtml(group.next_signal || group.signal)}" style="margin:3px 0;padding:6px 8px;border-left:2.5px solid ${accentColor};background:rgba(255,255,255,0.025);border-radius:0 4px 4px 0;transition:background 0.1s;">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span title="${escapeHtml(roleStyle.tip || roleStyle.label)}" style="display:inline-block;background:${roleStyle.color}22;color:${roleStyle.color};padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:0.06em;flex-shrink:0;cursor:help;">${roleStyle.label}</span>
          <span style="color:#e4e4e7;font-size:12px;">${escapeHtml(headline)}</span>
          ${badges}
        </div>
        <div style="display:flex;align-items:center;gap:4px;margin-top:3px;font-size:10px;">
          <a href="#" class="xtrace-nav" data-trace-module="${escapeHtml(group.module)}" style="color:#22d3ee;text-decoration:none;font-weight:500;">${escapeHtml(group.module)}</a><span style="color:#3f3f46;">.</span><a href="#" class="xtrace-retrace" data-trace-module="${escapeHtml(group.module)}" data-trace-signal="${escapeHtml(group.signal)}" style="color:#a1a1aa;text-decoration:none;">${escapeHtml(group.signal)}</a>${crossIcon ? `<span style="color:#a78bfa;font-weight:600;">${crossIcon}</span>` : ""}${group.next_module && group.next_signal
            ? ` <span style="color:#a78bfa;font-size:10px;">${escapeHtml(group.next_module)}.${escapeHtml(group.next_signal)}</span>`
            : ""}
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <button type="button" class="xtrace-retrace-btn" data-trace-module="${escapeHtml(group.next_module || group.module)}" data-trace-signal="${escapeHtml(group.next_signal || group.signal)}" style="background:none;border:1px solid ${accentColor}55;color:${accentColor};cursor:pointer;font-size:10px;padding:2px 7px;border-radius:3px;">${stepLabel}</button>
        </div>
      </div>`;
  };

  let renderedStepIndex = 0;
  const renderSection = (groups, accent, heading, emptyMsg, direction) => {
    let html = `<div style="color:${accent};font-weight:700;margin:10px 0 6px;font-size:11px;letter-spacing:0.04em;">${heading} <span style="font-weight:400;color:#71717a;font-size:10px;">(${groups.length})</span></div>`;
    if (!groups.length) {
      html += `<div style="color:#52525b;margin:2px 0 4px 2px;font-size:11px;">${emptyMsg}</div>`;
      return html;
    }
    html += groups.map((g, i) => {
      const htmlRow = renderHop(g, accent, i, direction, renderedStepIndex);
      renderedStepIndex += 1;
      return htmlRow;
    }).join("");
    return html;
  };

  const origin = trace.origin || {};
  const totalDrivers = groupedFanin.length;
  const totalLoads = groupedFanout.length;
  const activeStep = crossTraceStepIndex >= 0 ? crossTraceStepList[crossTraceStepIndex] : null;
  const stepCount = crossTraceStepList.length;
  const stepLabel = stepCount > 0 ? `${crossTraceStepIndex + 1} / ${stepCount}` : "";

  // Build breadcrumb from crossTraceHistory
  let breadcrumbHtml = "";
  if (crossTraceHistory.length > 0) {
    const crumbs = crossTraceHistory.map((h, i) =>
      `<a href="#" class="xtrace-history-jump" data-history-index="${i}" style="color:#f59e0b;text-decoration:none;white-space:nowrap;">${escapeHtml(h.module)}.${escapeHtml(h.signal)}</a>`
    );
    breadcrumbHtml = `
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:8px;padding:5px 8px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.15);border-radius:4px;overflow-x:auto;font-size:10px;flex-wrap:wrap;">
        <span style="color:#71717a;flex-shrink:0;">Path:</span>
        ${crumbs.join('<span style="color:#3f3f46;flex-shrink:0;"> \u2192 </span>')}
        <span style="color:#3f3f46;flex-shrink:0;"> \u2192 </span>
        <span style="color:#e4e4e7;font-weight:600;white-space:nowrap;">${escapeHtml(origin.module || "")}.${escapeHtml(origin.signal || "")}</span>
      </div>`;
  }

  const backButton = crossTraceHistory.length > 0
    ? `<button id="xtraceBackBtn" style="background:none;border:1px solid #3f3f46;color:#a1a1aa;cursor:pointer;font-size:10px;padding:2px 8px;border-radius:3px;display:flex;align-items:center;gap:3px;"><span>←</span> Back</button>`
    : "";
  const forwardButton = crossTraceFuture.length > 0
    ? `<button id="xtraceForwardBtn" style="background:none;border:1px solid #3f3f46;color:#a1a1aa;cursor:pointer;font-size:10px;padding:2px 8px;border-radius:3px;display:flex;align-items:center;gap:3px;">Forward <span>→</span></button>`
    : "";

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        ${backButton}
        ${forwardButton}
        <span style="font-weight:700;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#a1a1aa;">Direct Signal Trace</span>
      </div>
      <button id="closeCrossTracePanel" style="background:none;border:none;color:#71717a;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;">&times;</button>
    </div>

    ${breadcrumbHtml}

      <div style="padding:8px 10px;border:1.5px solid rgba(34,211,238,0.35);border-radius:5px;margin-bottom:8px;background:rgba(34,211,238,0.07);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="color:#22d3ee;font-size:9px;font-weight:700;letter-spacing:0.1em;">TRACE SUMMARY</div>
        <span style="color:#a1a1aa;font-size:9px;text-transform:uppercase;letter-spacing:0.08em;">Scope: Direct relations only</span>
      </div>
      <div style="font-size:13px;font-weight:600;"><strong style="color:#e4e4e7;">${escapeHtml(origin.module || "")}</strong><span style="color:#71717a;">.</span>${escapeHtml(origin.signal || "")}</div>
      <div style="color:#71717a;font-size:10px;margin-top:3px;">${totalDrivers} direct driver${totalDrivers === 1 ? "" : "s"} \u2022 ${totalLoads} direct load${totalLoads === 1 ? "" : "s"}${trace.truncated ? " \u2022 truncated" : ""}</div>
    </div>

    ${stepCount > 0 ? `
    <div style="margin-bottom:10px;padding:8px 10px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.18);border-radius:5px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <span style="color:#f59e0b;font-size:10px;font-weight:700;letter-spacing:0.06em;flex-shrink:0;">GUIDED TRACE</span>
        <button id="crossStepPrev" ${crossTraceStepIndex <= 0 ? "disabled" : ""} style="background:none;border:1px solid ${crossTraceStepIndex <= 0 ? "#3f3f4655" : "#f59e0b55"};color:${crossTraceStepIndex <= 0 ? "#52525b" : "#f59e0b"};cursor:${crossTraceStepIndex <= 0 ? "default" : "pointer"};font-size:13px;padding:1px 8px;border-radius:3px;line-height:1;" title="Previous step">&#9650;</button>
        <span style="color:#e4e4e7;font-size:11px;font-weight:600;min-width:48px;text-align:center;">${stepLabel}</span>
        <button id="crossStepNext" ${crossTraceStepIndex >= stepCount - 1 ? "disabled" : ""} style="background:none;border:1px solid ${crossTraceStepIndex >= stepCount - 1 ? "#3f3f4655" : "#f59e0b55"};color:${crossTraceStepIndex >= stepCount - 1 ? "#52525b" : "#f59e0b"};cursor:${crossTraceStepIndex >= stepCount - 1 ? "default" : "pointer"};font-size:13px;padding:1px 8px;border-radius:3px;line-height:1;" title="Next step">&#9660;</button>
      </div>
      <div style="color:#e4e4e7;font-size:12px;font-weight:600;margin-bottom:2px;">${activeStep ? escapeHtml(activeStep.label) : ""}</div>
      <div style="color:#71717a;font-size:10px;">${activeStep ? escapeHtml(`${activeStep.module}.${activeStep.signal}${activeStep.detail ? ` - ${activeStep.detail}` : ""}`) : ""}</div>
    </div>` : ""}

    ${renderSection(
      groupedFanin,
      "#4ade80",
      "\u25b2 Upstream",
      "No drivers found",
      "fanin"
    )}
    ${renderSection(
      groupedFanout,
      "#60a5fa",
      "\u25bc Downstream",
      "No loads found",
      "fanout"
    )}

    ${trace.truncated ? `<div style="color:#f59e0b;margin-top:8px;font-size:10px;">Only the first set of direct relations is shown.</div>` : ""}
    <div style="color:#52525b;margin-top:10px;font-size:10px;border-top:1px solid #27272a;padding-top:8px;">
      The lists below are the full upstream and downstream steps for this signal. Use the guided trace arrows to walk them one step at a time, or click a row to jump directly to that step.${crossTraceHistory.length > 0 || crossTraceFuture.length > 0 ? " Back/Forward navigates the walked path." : ""}
    </div>
  `;

  // ── Event listeners ──

  panel.querySelector("#closeCrossTracePanel")?.addEventListener("click", () => {
    clearCrossTraceHighlights();
    crossTraceHistory.length = 0;
    crossTraceFuture.length = 0;
    panel.remove();
  });

  // Back/forward buttons
  panel.querySelector("#xtraceBackBtn")?.addEventListener("click", () => {
    const prev = crossTraceHistory.pop();
    if (prev) {
      crossTraceFuture.push({ module: origin.module, signal: origin.signal });
      if (prev.module !== state.selectedModule) {
        loadGraph(prev.module).then(() => requestCrossModuleTrace(prev.module, prev.signal, true));
      } else {
        requestCrossModuleTrace(prev.module, prev.signal, true);
      }
    }
  });

  panel.querySelector("#xtraceForwardBtn")?.addEventListener("click", () => {
    const next = crossTraceFuture.pop();
    if (next) {
      crossTraceHistory.push({ module: origin.module, signal: origin.signal });
      if (next.module !== state.selectedModule) {
        loadGraph(next.module).then(() => requestCrossModuleTrace(next.module, next.signal, true));
      } else {
        requestCrossModuleTrace(next.module, next.signal, true);
      }
    }
  });

  // Breadcrumb history jumps
  panel.querySelectorAll(".xtrace-history-jump").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      const idx = parseInt(el.getAttribute("data-history-index"), 10);
      if (isNaN(idx) || idx < 0) return;
      const target = crossTraceHistory[idx];
      crossTraceFuture.length = 0;
      crossTraceFuture.push({ module: origin.module, signal: origin.signal }, ...crossTraceHistory.slice(idx + 1));
      crossTraceHistory.length = idx;
      if (target) {
        if (target.module !== state.selectedModule) {
          loadGraph(target.module).then(() => requestCrossModuleTrace(target.module, target.signal, true));
        } else {
          requestCrossModuleTrace(target.module, target.signal, true);
        }
      }
    });
  });

  panel.querySelector("#crossStepPrev")?.addEventListener("click", () => crossTraceStepPrev(trace));
  panel.querySelector("#crossStepNext")?.addEventListener("click", () => crossTraceStepNext(trace));

    // Navigate to module schematic
  panel.querySelectorAll(".xtrace-nav").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const mod = ev.currentTarget.getAttribute("data-trace-module");
      if (mod && mod !== state.selectedModule) {
        await loadGraph(mod);
        // Re-apply highlights on the new schematic
        applyCrossTraceHighlights(trace);
      }
    });
  });

  // Re-trace from a signal
  panel.querySelectorAll(".xtrace-retrace, .xtrace-retrace-btn").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const mod = ev.currentTarget.getAttribute("data-trace-module");
      const sig = ev.currentTarget.getAttribute("data-trace-signal");
      if (mod && sig) {
        // Don't push to history if we're already tracing this exact signal
        if (mod !== origin.module || sig !== origin.signal) {
          crossTraceHistory.push({ module: origin.module, signal: origin.signal });
          crossTraceFuture.length = 0;
        }
        if (mod !== state.selectedModule) {
          await loadGraph(mod);
        }
        requestCrossModuleTrace(mod, sig, true);
      }
    });
  });

  // Hover affordance on hop rows
  panel.querySelectorAll(".xtrace-hop").forEach((row) => {
    row.addEventListener("mouseenter", () => {
      if (!row.style.outline) row.style.background = "rgba(255,255,255,0.05)";
    });
    row.addEventListener("mouseleave", () => {
      if (!row.style.outline) row.style.background = "rgba(255,255,255,0.025)";
    });
    row.addEventListener("click", () => {
      const raw = row.getAttribute("data-step-index");
      const idx = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(idx)) {
        goToCrossTraceStep(idx, trace);
      }
    });
  });

  if (crossTraceStepIndex >= 0) {
    const activeRow = panel.querySelector(`.xtrace-hop[data-step-index="${crossTraceStepIndex}"]`);
    if (activeRow) {
      activeRow.style.outline = "1.5px solid #f59e0b";
      activeRow.style.background = "rgba(245,158,11,0.08)";
    }
  }

}

// ── Signal trace history (step-by-step navigation) ──────────────────────
const signalTraceHistory = [];
const signalTraceFuture = [];

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
      background: #18181b; border: 1px solid rgba(255,255,255,0.10); border-radius: 6px;
      padding: 14px 16px; min-width: 280px; max-width: 400px;
      max-height: 70vh; overflow-y: auto; color: #e4e4e7;
      font-family: 'IBM Plex Mono', Consolas, Monaco, monospace; font-size: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    `;
    const canvas = document.getElementById("graphCanvas");
    if (canvas) canvas.appendChild(panel);
  }

  const kindIcon = (kind) => {
    if (kind === "module_io") return "\u25c6";
    if (kind === "instance") return "\u25a0";
    if (kind === "always") return "\u25b6";
    if (kind === "assign") return "\u2190";
    if (kind === "gate") return "\u25b3";
    return "\u25cb";
  };

  const stepIndexByPortId = new Map();
  for (let i = 0; i < localTraceStepList.length; i += 1) {
    const step = localTraceStepList[i];
    if (step && step.portId && !stepIndexByPortId.has(step.portId)) {
      stepIndexByPortId.set(step.portId, i);
    }
  }

  // Build a flat, deduplicated list grouped by parent block.
  // Each row lets the user inspect a hop first, then explicitly choose to re-trace.
  const renderSection = (steps, color, heading, emptyText) => {
    if (!steps.length) return `<div style="color:#52525b;margin:6px 0 2px;font-size:11px;">${emptyText}</div>`;

    // Group by parent instance for readability.
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

    let html = `<div style="color:${color};font-weight:700;margin:10px 0 6px;font-size:11px;letter-spacing:0.04em;">${heading}</div>`;
    for (const group of groups) {
      const icon = kindIcon(group.parentKind);
      html += `<div style="margin:0 0 4px 0;padding:6px 8px;border-left:2.5px solid ${color};background:rgba(255,255,255,0.025);border-radius:0 4px 4px 0;">`;
      html += `<div style="font-weight:600;font-size:12px;margin-bottom:3px;">${icon} ${escapeHtml(group.parentLabel)}</div>`;
      for (const p of group.ports) {
        const net = p.netName ? `<span style="color:#22d3ee;font-size:10px;"> via <strong>${escapeHtml(p.netName)}</strong></span>` : "";
        const crossed = p.crossedInstance ? `<span style="color:#71717a;font-size:10px;"> (through)</span>` : "";
        const stepIndex = stepIndexByPortId.has(p.portId) ? stepIndexByPortId.get(p.portId) : "";
        html += `<div class="strace-port-row" data-port-id="${escapeHtml(p.portId)}" data-step-index="${stepIndex}" style="margin:2px 0 2px 12px;padding:5px 6px;border-radius:3px;display:flex;align-items:center;gap:6px;transition:background 0.1s;">`;
        html += `<button type="button" class="strace-focus-btn" data-port-id="${escapeHtml(p.portId)}" data-step-index="${stepIndex}" style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:baseline;gap:6px;min-width:0;flex:1;text-align:left;">`;
        html += `<span style="color:${color};font-size:10px;flex-shrink:0;">${p.direction === "input" ? "\u2192" : p.direction === "output" ? "\u2190" : "\u2194"}</span>`;
        html += `<span style="color:#e4e4e7;min-width:0;">${escapeHtml(p.portName)}</span>${net}${crossed}`;
        html += `</button>`;
        html += `<button type="button" class="strace-retrace-btn" data-port-id="${escapeHtml(p.portId)}" style="background:none;border:1px solid #3f3f46;color:#e4e4e7;cursor:pointer;font-size:10px;padding:2px 7px;border-radius:3px;flex-shrink:0;">Re-trace</button>`;
        html += `</div>`;
      }
      html += `</div>`;
    }
    return html;
  };

  const origin = trace.origin;
  const originIcon = kindIcon(origin.parentKind);

  // Build breadcrumb trail from history
  let breadcrumbHtml = "";
  if (signalTraceHistory.length > 0) {
    const crumbs = signalTraceHistory.map((h, i) =>
      `<a href="#" class="strace-history-jump" data-history-index="${i}" style="color:#22d3ee;text-decoration:none;white-space:nowrap;">${escapeHtml(h.parentLabel)}.${escapeHtml(h.portName)}</a>`
    );
    breadcrumbHtml = `
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:8px;padding:5px 8px;background:rgba(255,255,255,0.025);border-radius:4px;overflow-x:auto;font-size:10px;flex-wrap:wrap;">
        <span style="color:#71717a;flex-shrink:0;">Path:</span>
        ${crumbs.join('<span style="color:#3f3f46;flex-shrink:0;"> \u2192 </span>')}
        <span style="color:#3f3f46;flex-shrink:0;"> \u2192 </span>
        <span style="color:#e4e4e7;font-weight:600;white-space:nowrap;">${escapeHtml(origin.parentLabel)}.${escapeHtml(origin.portName)}</span>
      </div>`;
  }

  const backButton = signalTraceHistory.length > 0
    ? `<button id="traceBackBtn" style="background:none;border:1px solid #3f3f46;color:#a1a1aa;cursor:pointer;font-size:10px;padding:2px 8px;border-radius:3px;display:flex;align-items:center;gap:3px;"><span>←</span> Back</button>`
    : "";
  const forwardButton = signalTraceFuture.length > 0
    ? `<button id="traceForwardBtn" style="background:none;border:1px solid #3f3f46;color:#a1a1aa;cursor:pointer;font-size:10px;padding:2px 8px;border-radius:3px;display:flex;align-items:center;gap:3px;">Forward <span>→</span></button>`
    : "";

  const stepCount = localTraceStepList.length;
  const stepIdx = localTraceStepIndex;
  const currentStep = stepIdx >= 0 && stepIdx < stepCount ? localTraceStepList[stepIdx] : null;
  const stepLabel = stepCount > 0 ? `${stepIdx + 1} / ${stepCount}` : "";

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        ${backButton}
        ${forwardButton}
        <span style="font-weight:700;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#a1a1aa;">Signal Trace</span>
      </div>
      <button id="closeTracePanel" style="background:none;border:none;color:#71717a;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;">&times;</button>
    </div>

    ${breadcrumbHtml}

    <div style="padding:8px 10px;border:1.5px solid rgba(34,211,238,0.35);border-radius:5px;margin-bottom:8px;background:rgba(34,211,238,0.07);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="color:#22d3ee;font-size:9px;font-weight:700;letter-spacing:0.1em;">TRACE SUMMARY</div>
        <span style="color:#a1a1aa;font-size:9px;text-transform:uppercase;letter-spacing:0.08em;">Scope: Current module</span>
      </div>
      <div style="font-size:13px;font-weight:600;">${originIcon} ${escapeHtml(origin.parentLabel)}<span style="color:#71717a;">.</span>${escapeHtml(origin.portName)}</div>
      <div style="color:#71717a;font-size:10px;margin-top:3px;">${trace.upstream.length} upstream hop${trace.upstream.length === 1 ? "" : "s"} \u2022 ${trace.downstream.length} downstream hop${trace.downstream.length === 1 ? "" : "s"}</div>
    </div>

    ${stepCount > 1 ? `
    <div style="margin-bottom:10px;padding:8px 10px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.18);border-radius:5px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <span style="color:#f59e0b;font-size:10px;font-weight:700;letter-spacing:0.06em;flex-shrink:0;">GUIDED TRACE</span>
        <button id="localStepPrev" ${stepIdx <= 0 ? "disabled" : ""} style="background:none;border:1px solid ${stepIdx <= 0 ? "#3f3f4655" : "#f59e0b55"};color:${stepIdx <= 0 ? "#52525b" : "#f59e0b"};cursor:${stepIdx <= 0 ? "default" : "pointer"};font-size:13px;padding:1px 8px;border-radius:3px;line-height:1;" title="Previous step (upstream)">&#9650;</button>
        <span id="localStepCounter" style="color:#e4e4e7;font-size:11px;font-weight:600;min-width:48px;text-align:center;">${stepLabel}</span>
        <button id="localStepNext" ${stepIdx >= stepCount - 1 ? "disabled" : ""} style="background:none;border:1px solid ${stepIdx >= stepCount - 1 ? "#3f3f4655" : "#f59e0b55"};color:${stepIdx >= stepCount - 1 ? "#52525b" : "#f59e0b"};cursor:${stepIdx >= stepCount - 1 ? "default" : "pointer"};font-size:13px;padding:1px 8px;border-radius:3px;line-height:1;" title="Next step (downstream)">&#9660;</button>
        <span style="color:#71717a;font-size:9px;margin-left:auto;">arrow keys</span>
      </div>
      <div id="localStepDesc" style="color:#e4e4e7;font-size:12px;font-weight:600;margin-bottom:2px;">${currentStep ? escapeHtml(currentStep.desc) : ""}</div>
      <div id="localStepDetail" style="color:#71717a;font-size:10px;">${currentStep ? escapeHtml(currentStep.detail) : ""}</div>
    </div>` : ""}

    ${renderSection(trace.upstream, "#4ade80", "\u25b2 Upstream", "No upstream sources found")}
    ${renderSection(trace.downstream, "#60a5fa", "\u25bc Downstream", "No downstream loads found")}

    <div style="color:#52525b;margin-top:10px;font-size:10px;border-top:1px solid #27272a;padding-top:8px;">
      ${stepCount > 1 ? 'Use <span style="color:#f59e0b;">Guided Trace</span> or arrow keys to walk the current path. ' : ""}Click a row to inspect that hop without changing the trace origin. Use <span style="color:#e4e4e7;">Re-trace</span> only when you want to start over from that port.${signalTraceHistory.length > 0 || signalTraceFuture.length > 0 ? " Back/Forward navigates trace origins." : ""}
    </div>
  `;

  // Close button
  document.getElementById("closeTracePanel").addEventListener("click", () => {
    if (state.cy) {
      state.cy.elements(
        ".signal-trace-upstream, .signal-trace-downstream, .signal-trace-origin, .signal-trace-dimmed, .signal-trace-step-active"
      ).removeClass(
        "signal-trace-upstream signal-trace-downstream signal-trace-origin signal-trace-dimmed signal-trace-step-active"
      );
    }
    state.signalTrace = null;
    signalTraceHistory.length = 0;
    signalTraceFuture.length = 0;
    clearLocalTraceSteps();
    panel.remove();
  });

  // Step-through buttons
  document.getElementById("localStepPrev")?.addEventListener("click", () => localTraceStepPrev());
  document.getElementById("localStepNext")?.addEventListener("click", () => localTraceStepNext());

  // Back/forward buttons
  document.getElementById("traceBackBtn")?.addEventListener("click", () => {
    const prev = signalTraceHistory.pop();
    if (prev) {
      signalTraceFuture.push({
        portId: origin.portId || trace.origin.portId,
        parentLabel: origin.parentLabel,
        portName: origin.portName,
      });
      const node = state.cy.getElementById(prev.portId);
      if (node && !node.empty()) {
        state.cy.animate({ center: { eles: node }, duration: 300 });
      }
      applySignalTrace(prev.portId, true);
    }
  });

  document.getElementById("traceForwardBtn")?.addEventListener("click", () => {
    const next = signalTraceFuture.pop();
    if (next) {
      signalTraceHistory.push({
        portId: origin.portId || trace.origin.portId,
        parentLabel: origin.parentLabel,
        portName: origin.portName,
      });
      const node = state.cy.getElementById(next.portId);
      if (node && !node.empty()) {
        state.cy.animate({ center: { eles: node }, duration: 300 });
      }
      applySignalTrace(next.portId, true);
    }
  });

  // Breadcrumb history jumps — click to go back to that point in the path
  panel.querySelectorAll(".strace-history-jump").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      const idx = parseInt(el.getAttribute("data-history-index"), 10);
      if (isNaN(idx) || idx < 0) return;
      // Pop history back to that index
      const target = signalTraceHistory[idx];
      signalTraceFuture.length = 0;
      signalTraceFuture.push({
        portId: origin.portId || trace.origin.portId,
        parentLabel: origin.parentLabel,
        portName: origin.portName,
      }, ...signalTraceHistory.slice(idx + 1));
      signalTraceHistory.length = idx; // remove this entry and everything after
      if (target) {
        const node = state.cy.getElementById(target.portId);
        if (node && !node.empty()) {
          state.cy.animate({ center: { eles: node }, duration: 300 });
        }
        applySignalTrace(target.portId, true);
      }
    });
  });

  panel.querySelectorAll(".strace-port-row").forEach((row) => {
    row.addEventListener("mouseenter", () => {
      if (!row.style.outline) row.style.background = "rgba(255,255,255,0.06)";
    });
    row.addEventListener("mouseleave", () => {
      if (!row.style.outline) row.style.background = "";
    });
  });

  panel.querySelectorAll(".strace-focus-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const portId = btn.getAttribute("data-port-id");
      const stepIndexRaw = btn.getAttribute("data-step-index");
      const stepIndex = stepIndexRaw === "" ? null : parseInt(stepIndexRaw, 10);
      if (!portId) return;
      focusTracePort(portId, { stepIndex: Number.isFinite(stepIndex) ? stepIndex : null });
    });
  });

  panel.querySelectorAll(".strace-retrace-btn").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const portId = btn.getAttribute("data-port-id");
      if (!portId) return;
      signalTraceHistory.push({
        portId: origin.portId || trace.origin.portId,
        parentLabel: origin.parentLabel,
        portName: origin.portName,
      });
      signalTraceFuture.length = 0;
      focusTracePort(portId);
      applySignalTrace(portId, true);
    });
  });

  // Highlight the row matching the current step-through position
  if (localTraceStepIndex >= 0 && localTraceStepIndex < localTraceStepList.length) {
    const activeStep = localTraceStepList[localTraceStepIndex];
    const activeRow = panel.querySelector(`.strace-port-row[data-port-id="${CSS.escape(activeStep.portId)}"]`);
    if (activeRow) {
      activeRow.style.outline = "1.5px solid #f59e0b";
      activeRow.style.background = "rgba(245,158,11,0.08)";
      // Scroll into view after a brief delay so the panel layout is settled
      setTimeout(() => activeRow.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    }
  }
}

function renderInspector() {
  const summary = state.summary || {};
  const traceable = getTraceableSelection();
  const traceButton = traceable
    ? `<button id="traceSignalBtn" data-trace-module="${escapeHtml(traceable.module)}" data-trace-signal="${escapeHtml(traceable.signal)}" style="margin-top:10px;padding:6px 12px;background:#22d3ee;color:#18181b;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:700;letter-spacing:0.04em;width:100%;">Trace ${escapeHtml(traceable.label)}</button>`
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
    graphEmpty.classList.remove("hidden");
    hideTooltip();

    if (state.cy) {
      state.cy.elements().remove();
    }

    return;
  }

  const graph = getRenderableGraph(rawGraph);

  const focus = graph.focus_module || graph.top_module || state.selectedModule || "(unknown)";
  graphTag.textContent = `${focus} — ${graph.nodes.length} nodes / ${graph.edges.length} edges`;

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
  const [topsPayload, modulesPayload, filesPayload, unusedPayload] = await Promise.all([
    apiRequest("/api/project/tops"),
    apiRequest("/api/project/modules"),
    apiRequest("/api/project/files"),
    apiRequest("/api/project/unused_modules").catch(() => ({ unused_modules: [] })),
  ]);

  state.tops = topsPayload.top_candidates || [];
  state.modules = modulesPayload.modules || [];
  state.sourceFiles = filesPayload.files || [];
  state.unusedModules = unusedPayload.unused_modules || [];

  const createBtn = document.getElementById("createModuleBtn");
  if (createBtn) createBtn.disabled = false;

  if (!state.tops.length) {
    state.selectedTop = null;
    state.selectedModule = null;
    state.hierarchy = null;
    state.breadcrumb = [];
    renderTopList();
    renderHierarchyTree();
    renderSourceFileList();
    renderBreadcrumb();
    renderGraph(null);
    renderInspector();
    return;
  }

  const retainedTop = state.selectedTop && state.tops.includes(state.selectedTop) ? state.selectedTop : state.tops[0];
  const retainedModule = state.selectedModule && state.modules.includes(state.selectedModule)
    ? state.selectedModule
    : retainedTop;
  const retainedBreadcrumb = state.breadcrumb.length
    ? state.breadcrumb.filter((name) => state.modules.includes(name))
    : [];

  state.selectedTop = retainedTop;
  renderTopList();
  renderSourceFileList();

  await loadHierarchy(retainedTop);
  await loadGraph(
    retainedModule,
    retainedBreadcrumb.length ? retainedBreadcrumb : [retainedModule],
  );
}

// ── Project load progress bar ──────────────────────────────────────
const loadProgressEl = document.getElementById("loadProgress");
const loadProgressFill = document.getElementById("loadProgressFill");
const loadProgressLabel = document.getElementById("loadProgressLabel");
const loadProgressCount = document.getElementById("loadProgressCount");
const loadProgressFile = document.getElementById("loadProgressFile");

function showLoadProgress() {
  if (!loadProgressEl) return;
  loadProgressEl.classList.remove("hidden");
  loadProgressEl.classList.add("indeterminate");
  if (loadProgressFill) loadProgressFill.style.width = "0%";
  if (loadProgressLabel) loadProgressLabel.textContent = "Scanning project...";
  if (loadProgressCount) loadProgressCount.textContent = "";
  if (loadProgressFile) loadProgressFile.textContent = "";
}

function updateLoadProgress(p) {
  if (!loadProgressEl) return;
  const total = p.total || 0;
  const current = p.current || 0;

  if (p.stage === "parsing" && total > 0) {
    loadProgressEl.classList.remove("indeterminate");
    const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
    if (loadProgressFill) loadProgressFill.style.width = `${pct}%`;
    if (loadProgressLabel) loadProgressLabel.textContent = `Parsing files (${pct}%)`;
    if (loadProgressCount) loadProgressCount.textContent = `${current} / ${total}`;
  } else if (p.stage === "scanning") {
    loadProgressEl.classList.add("indeterminate");
    if (loadProgressLabel) loadProgressLabel.textContent = "Scanning project...";
    if (loadProgressCount) loadProgressCount.textContent = "";
  } else if (p.stage === "finalizing") {
    loadProgressEl.classList.remove("indeterminate");
    if (loadProgressFill) loadProgressFill.style.width = "100%";
    if (loadProgressLabel) loadProgressLabel.textContent = "Building hierarchy...";
    if (loadProgressCount) loadProgressCount.textContent = `${total} / ${total}`;
  }

  if (loadProgressFile) {
    // Show only the basename so the line stays readable on long paths.
    const f = p.current_file || "";
    const base = f ? f.replace(/\\/g, "/").split("/").pop() : "";
    loadProgressFile.textContent = base;
  }
}

function hideLoadProgress() {
  if (!loadProgressEl) return;
  loadProgressEl.classList.add("hidden");
  loadProgressEl.classList.remove("indeterminate");
  if (loadProgressFill) loadProgressFill.style.width = "0%";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollLoadProgress() {
  // Poll until the backend reports done or error.
  // Returns the final progress payload.
  while (true) {
    let snap;
    try {
      snap = await apiRequest("/api/project/load/progress");
    } catch (err) {
      // If polling itself fails, surface the error and stop.
      throw err;
    }
    updateLoadProgress(snap);
    if (snap.done) return snap;
    await sleep(180);
  }
}

async function handleLoad() {
  const folder = getSelectedFolderPath();
  if (!folder) {
    setStatus("Need folder path", "error");
    return;
  }

  state.folderPreset = folderInput ? folderInput.value : state.folderPreset;
  state.folder = folder;
  if (state.folderPreset === CUSTOM_PROJECT_VALUE) {
    state.customFolder = folder;
  }
  state.parser = parserSelect ? parserSelect.value : state.parser;

  showLoadProgress();
  setStatus("Loading...", "busy");

  try {
    await apiRequest("/api/project/load", {
      method: "POST",
      body: JSON.stringify({ folder: state.folder, parser_backend: state.parser }),
    });
  } catch (error) {
    hideLoadProgress();
    setStatus("Project load failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    renderGraph(null);
    return;
  }

  let finalSnap;
  try {
    finalSnap = await pollLoadProgress();
  } catch (error) {
    hideLoadProgress();
    setStatus("Progress polling failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    return;
  }

  if (finalSnap.error) {
    hideLoadProgress();
    setStatus("Project load failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(finalSnap.error)}</p>`;
    renderGraph(null);
    return;
  }

  state.summary = finalSnap.summary || null;
  renderInspector();

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
  } finally {
    hideLoadProgress();
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
  updateFolderStateFromControls();
});

folderPathInput?.addEventListener("input", () => {
  if (folderInput?.value !== CUSTOM_PROJECT_VALUE) {
    return;
  }
  state.customFolder = folderPathInput.value;
  state.folder = folderPathInput.value.trim();
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
leftTabModules?.addEventListener("click", () => setLeftSidebarTab("modules"));
leftTabFiles?.addEventListener("click", () => setLeftSidebarTab("files"));

// Ctrl+F / Cmd+F to open search when graph canvas is present
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    // Only intercept if a graph is loaded
    if (state.cy && state.cy.elements().length) {
      e.preventDefault();
      openSearch();
    }
  }
  // Arrow key step-through for local signal trace (when panel is open and
  // no input/textarea is focused)
  if (localTraceStepList.length > 0 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      localTraceStepNext();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      localTraceStepPrev();
    }
  }
});

populateProjectOptions();
enforcePortViewMode();
showUnknownToggle.checked = state.showUnknownEdges;
portViewToggle.checked = state.portView;
setLeftSidebarTab(state.leftSidebarTab);
renderBreadcrumb();
renderHierarchyTree();
renderSourceFileList();
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
  sourceKind: "module",
  path: null,
  original: "",
  lintMarks: [],
  lintTimer: null,
  statusSticky: false,
  statusKind: "info",
  lintBound: false,
  suspendLint: false,
  initPromise: null,
  openRequestId: 0,
  overlayReady: false,
};

// ── Verilog syntax linter ──────────────────────────────────────────
// Lightweight client-side checker that flags unbalanced delimiters and
// block keywords (begin/end, module/endmodule, case/endcase, …). It is
// not a full parser — just enough to surface obvious typos as the user
// types. Errors are highlighted via CodeMirror markText + a gutter.
const VERILOG_BLOCK_PAIRS = {
  begin: ["end"],
  module: ["endmodule"],
  case: ["endcase"],
  casex: ["endcase"],
  casez: ["endcase"],
  function: ["endfunction"],
  task: ["endtask"],
  generate: ["endgenerate"],
  specify: ["endspecify"],
  fork: ["join", "join_any", "join_none"],
  package: ["endpackage"],
  interface: ["endinterface"],
  class: ["endclass"],
  config: ["endconfig"],
  primitive: ["endprimitive"],
  table: ["endtable"],
};
const VERILOG_BLOCK_OPENERS = new Set(Object.keys(VERILOG_BLOCK_PAIRS));
const VERILOG_BLOCK_CLOSERS = new Set();
for (const arr of Object.values(VERILOG_BLOCK_PAIRS)) {
  for (const c of arr) VERILOG_BLOCK_CLOSERS.add(c);
}

function verilogLint(source) {
  const errors = [];
  const lines = source.split("\n");

  // Step 1: build a "clean" copy of the source where comments and string
  // contents are replaced with spaces, so column positions are preserved
  // but we don't tokenize their contents.
  const clean = lines.map((l) => l.split(""));
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const row = clean[i];
    let inString = false;
    for (let j = 0; j < row.length; j++) {
      const c = row[j];
      const next = row[j + 1];
      if (inBlockComment) {
        if (c === "*" && next === "/") {
          row[j] = " "; row[j + 1] = " "; j++;
          inBlockComment = false;
        } else {
          row[j] = " ";
        }
        continue;
      }
      if (inString) {
        if (c === "\\" && next !== undefined) { row[j] = " "; row[j + 1] = " "; j++; continue; }
        if (c === '"') { inString = false; continue; }
        row[j] = " ";
        continue;
      }
      if (c === "/" && next === "/") {
        for (let k = j; k < row.length; k++) row[k] = " ";
        break;
      }
      if (c === "/" && next === "*") {
        row[j] = " "; row[j + 1] = " "; j++;
        inBlockComment = true;
        continue;
      }
      if (c === '"') { inString = true; continue; }
    }
  }

  // Step 2: tokenize the cleaned source into delimiters and identifiers,
  // tracking (line, ch) positions.
  const stack = []; // { type, open, line, ch, length }
  const closers = { ")": "(", "]": "[", "}": "{" };
  const openerNames = { "(": "parenthesis", "[": "bracket", "{": "brace" };

  for (let i = 0; i < clean.length; i++) {
    const row = clean[i].join("");
    let j = 0;
    while (j < row.length) {
      const c = row[j];
      if (/\s/.test(c)) { j++; continue; }
      if (c === "(" || c === "[" || c === "{") {
        stack.push({ type: c, open: c, line: i, ch: j, length: 1, kind: "paren" });
        j++;
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        const expected = closers[c];
        const top = stack[stack.length - 1];
        if (!top || top.kind !== "paren" || top.open !== expected) {
          errors.push({
            from: { line: i, ch: j },
            to: { line: i, ch: j + 1 },
            msg: `Unmatched closing ${openerNames[expected] || c} '${c}'`,
          });
        } else {
          stack.pop();
        }
        j++;
        continue;
      }
      // Identifier / keyword
      if (/[A-Za-z_]/.test(c)) {
        let k = j + 1;
        while (k < row.length && /[\w$]/.test(row[k])) k++;
        const word = row.slice(j, k);
        if (VERILOG_BLOCK_OPENERS.has(word)) {
          stack.push({
            type: word, open: word, line: i, ch: j, length: word.length, kind: "block",
          });
        } else if (VERILOG_BLOCK_CLOSERS.has(word)) {
          // Find nearest matching block opener on the stack.
          let matched = false;
          for (let s = stack.length - 1; s >= 0; s--) {
            const f = stack[s];
            if (f.kind !== "block") continue;
            const allowed = VERILOG_BLOCK_PAIRS[f.open] || [];
            if (allowed.includes(word)) {
              // Anything above this frame is unclosed.
              for (let t = stack.length - 1; t > s; t--) {
                const u = stack[t];
                errors.push({
                  from: { line: u.line, ch: u.ch },
                  to: { line: u.line, ch: u.ch + u.length },
                  msg: `Unclosed '${u.open}' (missing matching closer)`,
                });
              }
              stack.length = s;
              matched = true;
              break;
            }
          }
          if (!matched) {
            errors.push({
              from: { line: i, ch: j },
              to: { line: i, ch: j + word.length },
              msg: `Unmatched '${word}' with no opening block`,
            });
          }
        }
        j = k;
        continue;
      }
      j++;
    }
  }

  if (inBlockComment) {
    errors.push({
      from: { line: lines.length - 1, ch: 0 },
      to: { line: lines.length - 1, ch: (lines[lines.length - 1] || "").length },
      msg: "Unterminated block comment '/* … */'",
    });
  }

  // Anything left on the stack is an unclosed opener.
  for (const f of stack) {
    errors.push({
      from: { line: f.line, ch: f.ch },
      to: { line: f.line, ch: f.ch + f.length },
      msg: f.kind === "paren"
        ? `Unclosed ${openerNames[f.open]} '${f.open}'`
        : `Unclosed '${f.open}' (missing matching closer)`,
    });
  }

  return errors;
}

function clearLintMarks(cm) {
  for (const m of codeEditorState.lintMarks) {
    try { m.clear(); } catch (_) {}
  }
  codeEditorState.lintMarks = [];
  try { cm.clearGutter("cm-lint-gutter"); } catch (_) {}
}

function normalizeLintError(cm, err) {
  if (!cm || !err) return null;
  const totalLines = Math.max(1, cm.lineCount());
  const lineIdx = Math.max(0, Math.min(totalLines - 1, (err.line || 1) - 1));
  const lineText = cm.getLine(lineIdx) || "";
  let from = err.from || err._from || { line: lineIdx, ch: 0 };
  let to = err.to || err._to || { line: lineIdx, ch: lineText.length };

  if (!err.from && !err._from && err.token) {
    const idx = lineText.indexOf(err.token);
    if (idx >= 0) {
      from = { line: lineIdx, ch: idx };
      to = { line: lineIdx, ch: idx + err.token.length };
    }
  }

  if (from.line !== to.line && to.ch === 0 && to.line > from.line) {
    to = { line: from.line, ch: (cm.getLine(from.line) || "").length };
  }
  if (from.line === to.line && from.ch === to.ch) {
    to = { line: from.line, ch: Math.min(from.ch + 1, (cm.getLine(from.line) || "").length || from.ch + 1) };
  }

  return {
    line: lineIdx + 1,
    from,
    to,
    message: err.message || err.msg || "Syntax error",
  };
}

function renderLintErrors(cm, errors) {
  clearLintMarks(cm);
  const byLine = new Map();
  const seen = new Set();
  const normalizedErrors = [];
  for (const err of errors) {
    const normalized = normalizeLintError(cm, err);
    if (!normalized) continue;
    const key = `${normalized.from.line}:${normalized.from.ch}:${normalized.to.line}:${normalized.to.ch}:${normalized.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedErrors.push(normalized);
  }
  for (const err of normalizedErrors) {
    const lineIdx = err.from.line;
    const mark = cm.markText(err.from, err.to, {
      className: "cm-lint-error",
      title: err.message,
    });
    codeEditorState.lintMarks.push(mark);
    const lineHandle = cm.addLineClass(lineIdx, "background", "cm-lint-error-line");
    codeEditorState.lintMarks.push({
      clear: () => cm.removeLineClass(lineHandle, "background", "cm-lint-error-line"),
    });
    if (!byLine.has(lineIdx)) byLine.set(lineIdx, []);
    byLine.get(lineIdx).push(err.message);
  }
  for (const [line, msgs] of byLine.entries()) {
    const marker = document.createElement("div");
    marker.className = "cm-lint-gutter-marker";
    marker.title = msgs.join("\n");
    marker.textContent = "!";
    try { cm.setGutterMarker(line, "cm-lint-gutter", marker); } catch (_) {}
  }
  const statusEl = document.getElementById("codeEditorStatus");
  if (statusEl) {
    updateEditorLintStatus(
      normalizedErrors.length
        ? normalizedErrors.length === 1
          ? `Line ${normalizedErrors[0].line}: ${normalizedErrors[0].message}`
          : `${normalizedErrors.length} syntax issues. First: line ${normalizedErrors[0].line}: ${normalizedErrors[0].message}`
        : "No syntax issues",
      normalizedErrors.length > 0,
    );
  }
}

async function applyLint(cm) {
  if (!cm) return;
  const localErrors = verilogLint(cm.getValue()).map((e) => ({
    line: e.from.line + 1,
    token: null,
    message: e.msg,
    _local: true,
    _from: e.from,
    _to: e.to,
  }));
  let serverErrors = [];
  try {
    const resp = await apiRequest("/api/lint/verilog", {
      method: "POST",
      body: JSON.stringify({ content: cm.getValue() }),
    });
    if (resp && Array.isArray(resp.errors)) serverErrors = resp.errors;
  } catch (_) {
  }
  renderLintErrors(cm, [...serverErrors, ...localErrors]);
}

function scheduleLint(cm) {
  if (codeEditorState.lintTimer) clearTimeout(codeEditorState.lintTimer);
  codeEditorState.lintTimer = setTimeout(() => applyLint(cm), 350);
}

// ── Veritas overlay tokenizer ──────────────────────────────────────
// CodeMirror's stock verilog mode tags both module type names and named-port
// connection arguments as plain `cm-variable`, so a CSS-only theme cannot
// color them differently. This overlay walks the source line by line and
// emits two extra token classes:
//   vt-module    — the type name in `Foo bar (...)` instantiations
//   vt-arg       — identifiers appearing inside `.port(<here>)` connections
// CodeMirror prefixes overlay token names with `cm-`, so the resulting CSS
// classes are `cm-vt-module` and `cm-vt-arg` (themed in styles.css).
const VERITAS_VERILOG_KEYWORDS = new Set([
  "module", "endmodule", "if", "else", "for", "while", "case", "casex", "casez",
  "endcase", "begin", "end", "always", "always_ff", "always_comb", "always_latch",
  "assign", "wire", "reg", "logic", "input", "output", "inout", "parameter",
  "localparam", "function", "endfunction", "task", "endtask", "initial",
  "generate", "endgenerate", "genvar", "integer", "real", "time", "return",
  "default", "forever", "repeat", "do", "fork", "join", "typedef", "struct",
  "union", "enum", "interface", "endinterface", "modport", "package",
  "endpackage", "import", "export", "automatic", "static", "const", "var",
  "void", "bit", "byte", "int", "longint", "shortint", "shortreal", "string",
  "signed", "unsigned", "negedge", "posedge", "or", "and", "not", "xor",
  "xnor", "nand", "nor", "buf", "supply0", "supply1", "tri", "wand", "wor",
]);

const veritasVerilogOverlay = {
  startState: () => ({
    argDepth: 0,
    pendingPortArg: false,
    moduleTypeStart: null,
    moduleTypeEnd: null,
  }),
  copyState: (s) => ({
    argDepth: s.argDepth,
    pendingPortArg: s.pendingPortArg,
    moduleTypeStart: s.moduleTypeStart,
    moduleTypeEnd: s.moduleTypeEnd,
  }),
  token(stream, state) {
    // ── Inside a port-connection's argument list ──
    if (state.argDepth > 0) {
      const ch = stream.peek();
      if (ch === "(") { stream.next(); state.argDepth++; return null; }
      if (ch === ")") { stream.next(); state.argDepth--; return null; }
      if (ch === "\\") {
        stream.next();
        stream.eatWhile(/[^\s,;(){}\[\]]/);
        return "vt-arg";
      }
      // Identifier → mark as a connection argument.
      if (/[A-Za-z_]/.test(ch)) {
        stream.eatWhile(/[\w$]/);
        return "vt-arg";
      }
      // Skip strings, numbers, operators, whitespace — leave them to the base mode.
      stream.next();
      return null;
    }

    if (state.pendingPortArg) {
      const ch = stream.peek();
      if (ch === null) {
        state.pendingPortArg = false;
      } else if (/\s/.test(ch)) {
        stream.next();
        return null;
      } else if (ch === "(") {
        stream.next();
        state.argDepth = 1;
        state.pendingPortArg = false;
        return null;
      } else {
        state.pendingPortArg = false;
      }
    }

    // ── At start of line: try to detect a module instantiation header ──
    // Pattern (allowing optional `#(...)` parameter block):
    //     <indent><TYPE> [#(...)] <INSTANCE> (
    if (stream.sol()) {
      const rest = stream.string.slice(stream.pos);
      const m = rest.match(
        /^(\s*)([A-Za-z_]\w*)\s*(?:#\s*\([^)]*\))?\s+([A-Za-z_]\w*)\s*\(/,
      );
      if (m && !VERITAS_VERILOG_KEYWORDS.has(m[2])) {
        state.moduleTypeStart = stream.pos + m[1].length;
        state.moduleTypeEnd = state.moduleTypeStart + m[2].length;
      }
    }

    // ── Emit the module type token when we reach its column ──
    if (
      state.moduleTypeStart !== null &&
      stream.pos === state.moduleTypeStart
    ) {
      while (stream.pos < state.moduleTypeEnd) stream.next();
      state.moduleTypeStart = null;
      state.moduleTypeEnd = null;
      return "vt-module";
    }

    // ── Detect `.identifier(` and arm argument highlighting at `(` ──
    if (stream.peek() === ".") {
      const rest = stream.string.slice(stream.pos);
      if (/^\.[A-Za-z_]\w*\s*\(/.test(rest)) {
        state.pendingPortArg = true;
      }
      stream.next();
      return null;
    }

    stream.next();
    return null;
  },
};

async function ensureCodeMirrorReady() {
  if (codeEditorState.cm) {
    // Make sure the lint gutter and change listener exist on instances
    // that may have been constructed before the linter shipped.
    const cm = codeEditorState.cm;
    const gutters = cm.getOption("gutters") || [];
    if (!gutters.includes("cm-lint-gutter")) {
      cm.setOption("gutters", [...gutters, "cm-lint-gutter"]);
    }
    if (!codeEditorState.lintBound) {
      cm.on("change", () => handleEditorChange(cm));
      codeEditorState.lintBound = true;
    }
    return Promise.resolve(cm);
  }
  if (codeEditorState.initPromise) return codeEditorState.initPromise;
  codeEditorState.initPromise = Promise.resolve().then(() => {
    const ta = document.getElementById("codeEditorTextarea");
    if (!ta || typeof CodeMirror === "undefined") return null;
    const cm = CodeMirror.fromTextArea(ta, {
      mode: "verilog",
      theme: "material-darker",
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 2,
      inputStyle: "textarea",
      lineWrapping: false,
      matchBrackets: true,
      gutters: ["CodeMirror-linenumbers", "cm-lint-gutter"],
    });
    const inputField = cm.getInputField?.();
    if (inputField) {
      inputField.setAttribute("spellcheck", "false");
      inputField.setAttribute("autocorrect", "off");
      inputField.setAttribute("autocapitalize", "off");
    }
    // Layer the Veritas overlay on top of the base verilog mode so module
    // types and port-connection arguments get their own token classes.
    // Some CodeMirror builds reject stateful overlays; that should not block
    // the editor from opening.
    try {
      cm.addOverlay(veritasVerilogOverlay);
      codeEditorState.overlayReady = true;
    } catch (error) {
      codeEditorState.overlayReady = false;
      console.warn("Veritas overlay disabled:", error);
    }
    cm.on("change", () => handleEditorChange(cm));
    codeEditorState.cm = cm;
    codeEditorState.lintBound = true;
    return cm;
  }).finally(() => {
    codeEditorState.initPromise = null;
  });
  return codeEditorState.initPromise;
}

function setEditorStatus(text, kind = "info", options = {}) {
  const { sticky = false } = options;
  codeEditorState.statusSticky = sticky;
  codeEditorState.statusKind = kind;

  const el = document.getElementById("codeEditorStatus");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("has-errors", kind === "error");
  el.classList.toggle("has-warning", kind === "warning");
}

function clearEditorStickyStatus() {
  if (!codeEditorState.statusSticky) return;
  codeEditorState.statusSticky = false;
}

function setCodeEditorValue(cm, value, { clearHistory = false } = {}) {
  if (!cm) return;
  codeEditorState.suspendLint = true;
  try {
    cm.setValue(value);
    if (clearHistory) cm.clearHistory();
  } finally {
    codeEditorState.suspendLint = false;
  }
}

function updateEditorLintStatus(text, hasErrors) {
  if (codeEditorState.statusSticky) return;
  setEditorStatus(text, hasErrors ? "error" : "info");
}

function handleEditorChange(cm) {
  if (codeEditorState.suspendLint) return;
  clearEditorStickyStatus();
  scheduleLint(cm);
}

async function openModuleCodeEditor(moduleName, options = {}) {
  const requestId = ++codeEditorState.openRequestId;
  const overlay = document.getElementById("codeEditorOverlay");
  const titleEl = document.getElementById("codeEditorTitle");
  const pathEl = document.getElementById("codeEditorPath");
  if (!overlay) return;

  overlay.classList.remove("hidden");
  titleEl.textContent = `Module Source — ${moduleName}`;
  pathEl.textContent = "Loading...";
  setEditorStatus("Loading...", "info");

  // CodeMirror can mis-measure when created immediately after a display:none
  // overlay becomes visible; wait for the visible layout to paint first.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  let cm = null;
  try {
    cm = await ensureCodeMirrorReady();
  } catch (error) {
    setEditorStatus(`Editor failed to initialize: ${error.message || error}`, "error", { sticky: true });
    return;
  }
  if (cm) {
    cm.refresh();
    setCodeEditorValue(cm, "");
  }

  try {
    const data = await apiRequest(`/api/project/modules/${encodeURIComponent(moduleName)}/source`);
    if (requestId !== codeEditorState.openRequestId) return;
    codeEditorState.sourceKind = "module";
    codeEditorState.module = moduleName;
    codeEditorState.path = data.path || "";
    codeEditorState.original = data.content || "";
    pathEl.textContent = codeEditorState.path;
    if (cm) {
      setCodeEditorValue(cm, codeEditorState.original, { clearHistory: true });
      requestAnimationFrame(() => {
        if (requestId !== codeEditorState.openRequestId) return;
        cm.refresh();
        if (options.jumpToInstance) {
          jumpToInstantiation(cm, options.jumpToInstance);
        }
        applyLint(cm);
      });
    }
  } catch (error) {
    setEditorStatus(`Failed to load: ${error.message}`, "error", { sticky: true });
    pathEl.textContent = "";
  }
}

function jumpToInstantiation(cm, target) {
  if (!cm || !target) return false;
  const { instanceName, childModule } = target;
  if (!childModule) {
    setEditorStatus("Missing child module name for instantiation lookup.", "warning", { sticky: true });
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
      "warning",
      { sticky: true },
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
    "info",
  );
  return true;
}

function closeModuleCodeEditor() {
  const overlay = document.getElementById("codeEditorOverlay");
  if (overlay) overlay.classList.add("hidden");
  codeEditorState.openRequestId += 1;
  codeEditorState.sourceKind = "module";
  codeEditorState.module = null;
  codeEditorState.path = null;
  codeEditorState.original = "";
}

async function saveModuleCodeEditor() {
  const cm = codeEditorState.cm;
  if (!cm || !codeEditorState.path) return;
  const content = cm.getValue();
  const moduleToReload = state.selectedModule;
  const breadcrumbToReload = state.breadcrumb.length ? [...state.breadcrumb] : [];

  const saveBtn = document.getElementById("codeEditorSave");
  const discardBtn = document.getElementById("codeEditorDiscard");
  if (saveBtn) saveBtn.disabled = true;
  if (discardBtn) discardBtn.disabled = true;
  setEditorStatus("Saving and re-parsing project...", "info");

  try {
    const savePath = codeEditorState.sourceKind === "file"
      ? `/api/project/files/source?path=${encodeURIComponent(codeEditorState.path)}`
      : `/api/project/modules/${encodeURIComponent(codeEditorState.module)}/source`;
    const saveResp = await apiRequest(savePath, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
    codeEditorState.original = content;
    const warning = saveResp && saveResp.reparse && saveResp.reparse.warning;
    if (warning) {
      const detail = saveResp && saveResp.reparse && saveResp.reparse.error;
      setEditorStatus(detail ? `${warning} ${detail}` : warning, "warning", { sticky: true });
      setStatus("Saved with parse warning", "warn");
      return;
    }
    setEditorStatus("Saved. Refreshing viewer...", "info");

    // Re-parse already happened on the server. Refresh the project listing
    // and reload the currently focused module's graph so the viewer updates.
    try {
      await refreshProject();
      if (moduleToReload && state.modules.includes(moduleToReload)) {
        await loadGraph(
          moduleToReload,
          breadcrumbToReload.length ? breadcrumbToReload : [moduleToReload],
        );
      }
      setStatus("Module updated", "ok");
      setEditorStatus("Saved.", "info");
    } catch (refreshErr) {
      setEditorStatus(`Saved, but refresh failed: ${refreshErr.message}`, "warning", { sticky: true });
    }
  } catch (error) {
    setEditorStatus(`Save failed: ${error.message}`, "error", { sticky: true });
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (discardBtn) discardBtn.disabled = false;
  }
}

function discardModuleCodeEditor() {
  const cm = codeEditorState.cm;
  if (!cm) return;
  setCodeEditorValue(cm, codeEditorState.original || "");
  setEditorStatus("Changes discarded.", "info");
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

function warmCodeEditor() {
  const start = () => {
    ensureCodeMirrorReady()
      .then((cm) => {
        if (cm) setCodeEditorValue(cm, "");
      })
      .catch(() => {});
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 500 });
  } else {
    setTimeout(start, 0);
  }
}

async function openSourceFileEditor(filePath) {
  const requestId = ++codeEditorState.openRequestId;
  const overlay = document.getElementById("codeEditorOverlay");
  const titleEl = document.getElementById("codeEditorTitle");
  const pathEl = document.getElementById("codeEditorPath");
  if (!overlay) return;

  const label = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "Source File";
  overlay.classList.remove("hidden");
  titleEl.textContent = `File Source — ${label}`;
  pathEl.textContent = "Loading...";
  setEditorStatus("Loading...", "info");

  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  let cm = null;
  try {
    cm = await ensureCodeMirrorReady();
  } catch (error) {
    setEditorStatus(`Editor failed to initialize: ${error.message || error}`, "error", { sticky: true });
    return;
  }
  if (cm) {
    cm.refresh();
    setCodeEditorValue(cm, "");
  }

  try {
    const data = await apiRequest(`/api/project/files/source?path=${encodeURIComponent(filePath)}`);
    if (requestId !== codeEditorState.openRequestId) return;
    codeEditorState.sourceKind = "file";
    codeEditorState.module = null;
    codeEditorState.path = data.path || filePath || "";
    codeEditorState.original = data.content || "";
    pathEl.textContent = codeEditorState.path;
    if (cm) {
      setCodeEditorValue(cm, codeEditorState.original, { clearHistory: true });
      requestAnimationFrame(() => {
        if (requestId !== codeEditorState.openRequestId) return;
        cm.refresh();
        applyLint(cm);
      });
    }
  } catch (error) {
    setEditorStatus(`Failed to load: ${error.message}`, "error", { sticky: true });
    pathEl.textContent = "";
  }
}

warmCodeEditor();

// ═══════════════════════════════════════════════════════════════════
// Create Module dialog
// ═══════════════════════════════════════════════════════════════════
(function setupCreateModuleDialog() {
  const overlay = document.getElementById("createModuleOverlay");
  const nameInput = document.getElementById("newModuleName");
  const errorEl = document.getElementById("createModuleError");
  const confirmBtn = document.getElementById("createModuleConfirm");
  const cancelBtn = document.getElementById("createModuleCancel");
  const closeBtn = document.getElementById("createModuleClose");
  const openBtn = document.getElementById("createModuleBtn");
  if (!overlay) return;

  function show() {
    overlay.classList.remove("hidden");
    if (nameInput) { nameInput.value = ""; nameInput.focus(); }
    if (errorEl) errorEl.textContent = "";
  }

  function hide() { overlay.classList.add("hidden"); }

  async function create() {
    const name = (nameInput?.value || "").trim();
    if (!name) { errorEl.textContent = "Module name is required."; return; }
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
      errorEl.textContent = "Invalid Verilog identifier.";
      return;
    }
    errorEl.textContent = "";
    confirmBtn.disabled = true;
    try {
      const result = await apiRequest("/api/project/modules", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      hide();
      setStatus(`Module '${name}' created`, "ok");
      await refreshProject();
      // Open the new module in the code editor so the user can start writing.
      if (typeof openModuleCodeEditor === "function") {
        openModuleCodeEditor(name);
      }
    } catch (err) {
      errorEl.textContent = err.message || "Creation failed.";
    } finally {
      confirmBtn.disabled = false;
    }
  }

  openBtn?.addEventListener("click", show);
  confirmBtn?.addEventListener("click", create);
  cancelBtn?.addEventListener("click", hide);
  closeBtn?.addEventListener("click", hide);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) hide(); });
  nameInput?.addEventListener("keydown", (ev) => { if (ev.key === "Enter") create(); });
})();

// ═══════════════════════════════════════════════════════════════════
// Instantiate Module dialog
// ═══════════════════════════════════════════════════════════════════
function openInstantiateDialog(childModule) {
  const overlay = document.getElementById("instantiateOverlay");
  const titleEl = document.getElementById("instantiateTitle");
  const parentSelect = document.getElementById("instantiateParent");
  const nameInput = document.getElementById("instantiateName");
  const errorEl = document.getElementById("instantiateError");
  if (!overlay) return;

  if (state.tops.includes(childModule)) {
    setStatus("Top modules cannot be instantiated", "error");
    return;
  }

  titleEl.textContent = `Instantiate ${childModule}`;
  errorEl.textContent = "";
  if (nameInput) nameInput.value = "";

  // Populate parent module list — all modules except the child itself.
  parentSelect.innerHTML = "";
  for (const mod of state.modules) {
    if (mod === childModule) continue;
    const option = document.createElement("option");
    option.value = mod;
    option.textContent = mod;
    if (mod === state.selectedModule) option.selected = true;
    parentSelect.appendChild(option);
  }

  overlay.classList.remove("hidden");
  overlay.dataset.childModule = childModule;
}

(function setupInstantiateDialog() {
  const overlay = document.getElementById("instantiateOverlay");
  const parentSelect = document.getElementById("instantiateParent");
  const nameInput = document.getElementById("instantiateName");
  const errorEl = document.getElementById("instantiateError");
  const confirmBtn = document.getElementById("instantiateConfirm");
  const cancelBtn = document.getElementById("instantiateCancel");
  const closeBtn = document.getElementById("instantiateClose");
  if (!overlay) return;

  function hide() { overlay.classList.add("hidden"); }

  async function instantiate() {
    const childModule = overlay.dataset.childModule;
    const parentModule = parentSelect?.value;
    const instanceName = (nameInput?.value || "").trim();
    if (!parentModule) { errorEl.textContent = "Select a parent module."; return; }
    errorEl.textContent = "";
    confirmBtn.disabled = true;
    try {
      const result = await apiRequest("/api/project/instantiate", {
        method: "POST",
        body: JSON.stringify({
          child_module: childModule,
          parent_module: parentModule,
          instance_name: instanceName,
        }),
      });
      hide();
      setStatus(`Instantiated ${childModule} in ${parentModule}`, "ok");
      await refreshProject();
      // Reload the parent module graph so the new instance is visible.
      if (state.selectedTop) {
        await loadHierarchy(state.selectedTop);
      }
      if (state.modules.includes(parentModule)) {
        await loadGraph(parentModule, state.breadcrumb.length ? state.breadcrumb : [parentModule]);
      }
    } catch (err) {
      errorEl.textContent = err.message || "Instantiation failed.";
    } finally {
      confirmBtn.disabled = false;
    }
  }

  confirmBtn?.addEventListener("click", instantiate);
  cancelBtn?.addEventListener("click", hide);
  closeBtn?.addEventListener("click", hide);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) hide(); });
})();

// ═══════════════════════════════════════════════════════════════════
// Collapsible side panels (hierarchy + inspector)
// ═══════════════════════════════════════════════════════════════════
(function setupPanelToggles() {
  const workspace = document.getElementById("workspace");
  const leftBtn = document.getElementById("toggleLeftPanel");
  const rightBtn = document.getElementById("toggleRightPanel");
  if (!workspace) return;

  function afterResize() {
    // Cytoscape needs an explicit resize when its container size changes,
    // otherwise the canvas keeps its old dimensions and clips the schematic.
    if (state.cy) {
      // Wait one frame so the grid has reflowed.
      requestAnimationFrame(() => {
        state.cy.resize();
        if (state.cy.elements().length) state.cy.fit(undefined, 30);
      });
    }
  }

  function togglePanel(side) {
    const cls = side === "left" ? "left-collapsed" : "right-collapsed";
    const collapsed = workspace.classList.toggle(cls);
    const btn = side === "left" ? leftBtn : rightBtn;
    if (btn) {
      const labelHide = side === "left" ? "Hide hierarchy" : "Hide inspector";
      const labelShow = side === "left" ? "Show hierarchy" : "Show inspector";
      btn.title = collapsed ? labelShow : labelHide;
      btn.setAttribute("aria-label", collapsed ? labelShow : labelHide);
    }
    afterResize();
  }

  leftBtn?.addEventListener("click", () => togglePanel("left"));
  rightBtn?.addEventListener("click", () => togglePanel("right"));
})();
