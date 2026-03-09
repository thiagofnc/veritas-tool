const state = {
  folder: "",
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
  lastTapNodeId: null,
  lastTapTs: 0,
};

const folderInput = document.getElementById("folderInput");
const parserSelect = document.getElementById("parserSelect");
const loadBtn = document.getElementById("loadBtn");
const refreshBtn = document.getElementById("refreshBtn");
const fitBtn = document.getElementById("fitBtn");
const graphModeSelect = document.getElementById("graphModeSelect");
const aggregateToggle = document.getElementById("aggregateToggle");
const showUnknownToggle = document.getElementById("showUnknownToggle");
const statusBadge = document.getElementById("statusBadge");
const topList = document.getElementById("topList");
const hierarchyTree = document.getElementById("hierarchyTree");
const breadcrumbBar = document.getElementById("breadcrumbBar");
const graphTag = document.getElementById("graphTag");
const graphStats = document.getElementById("graphStats");
const graphPreview = document.getElementById("graphPreview");
const graphCanvas = document.getElementById("graphCanvas");
const graphEmpty = document.getElementById("graphEmpty");
const cyGraph = document.getElementById("cyGraph");
const hoverTooltip = document.getElementById("hoverTooltip");
const inspector = document.getElementById("inspector");

function setStatus(text, kind) {
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

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

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
    { key: "module_io", label: "module I/O nodes" },
    { key: "net", label: "net nodes" },
  ];

  const edgeKinds = [{ key: "connection", label: "connection edges" }];

  const totalNodes = Object.values(nodeCounts).reduce((acc, value) => acc + value, 0);
  const totalEdges = Object.values(edgeCounts).reduce((acc, value) => acc + value, 0);

  const pills = [
    `<span class="stat-pill"><strong>Total nodes</strong>${totalNodes}</span>`,
    `<span class="stat-pill"><strong>Total edges</strong>${totalEdges}</span>`,
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
      {
        selector: "node",
        style: {
          "background-color": "#5f7382",
          width: 18,
          height: 18,
          label: "",
          "border-width": 1,
          "border-color": "#0a0f12",
        },
      },
      {
        selector: 'node[kind = "instance"]',
        style: {
          "background-color": "#ffb347",
          shape: "diamond",
          width: 24,
          height: 24,
        },
      },
      {
        selector: 'node[kind = "module_io"]',
        style: {
          "background-color": "#3ea6ff",
          shape: "round-rectangle",
          width: 30,
          height: 20,
        },
      },
      {
        selector: 'node[kind = "net"]',
        style: {
          "background-color": "#d58cff",
          shape: "ellipse",
          width: 14,
          height: 14,
        },
      },
      {
        selector: "node[is_bus = 1]",
        style: {
          "border-width": 2.5,
          "border-color": "#7ec6ff",
        },
      },
      {
        selector: "node:selected",
        style: {
          "border-width": 3,
          "border-color": "#ffffff",
        },
      },
      {
        selector: "edge",
        style: {
          width: 1.8,
          "line-color": "#42d392",
          "target-arrow-color": "#42d392",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.7,
          "curve-style": "taxi",
          "taxi-direction": "rightward",
          "taxi-turn": 22,
          "taxi-turn-min-distance": 12,
        },
      },
      {
        selector: 'edge[sig_class = "wire"]',
        style: {
          width: 1.8,
          "line-color": "#42d392",
          "target-arrow-color": "#42d392",
        },
      },
      {
        selector: 'edge[sig_class = "bus"]',
        style: {
          width: 3.1,
          "line-color": "#4fb6ff",
          "target-arrow-color": "#4fb6ff",
          "arrow-scale": 0.85,
        },
      },
      {
        selector: 'edge[sig_class = "mixed"]',
        style: {
          width: 2.7,
          "line-color": "#82c8ff",
          "target-arrow-color": "#82c8ff",
          "arrow-scale": 0.8,
        },
      },
      {
        selector: 'edge[flow = "unknown"]',
        style: {
          "line-style": "dashed",
          "line-color": "#98a6b3",
          "target-arrow-color": "#98a6b3",
          "target-arrow-shape": "none",
        },
      },
      {
        selector: "edge:selected",
        style: {
          width: 3.4,
          "line-color": "#ffc857",
          "target-arrow-color": "#ffc857",
        },
      },
    ],
  });

  state.cy.on("tap", "node", async (event) => {
    const data = event.target.data();
    state.selectedNode = data;
    state.selectedEdge = null;
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
  });

  state.cy.on("tap", "edge", (event) => {
    state.selectedEdge = event.target.data();
    state.selectedNode = null;
    renderInspector();
  });

  state.cy.on("tap", (event) => {
    if (event.target === state.cy) {
      state.selectedNode = null;
      state.selectedEdge = null;
      renderInspector();
    }
  });

  state.cy.on("mouseover", "node", (event) => {
    const data = event.target.data();
    const widthHint = data.bit_width && data.bit_width > 1 ? ` | bus [${data.bit_width}]` : data.is_bus ? " | bus" : " | wire";
    const drillHint = data.kind === "instance" ? '<div class="kind">Double-click to drill into module</div>' : "";
    hoverTooltip.innerHTML = `
      <div>${escapeHtml(data.label || data.id)}</div>
      <div class="kind">${escapeHtml(data.kind || "node")} | ${escapeHtml(data.id)}${escapeHtml(widthHint)}</div>
      ${drillHint}
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

    hoverTooltip.innerHTML = `
      <div>${escapeHtml(netSummary)}</div>
      <div class="kind">${escapeHtml(data.source)} -> ${escapeHtml(data.target)}</div>
      <div class="kind">${escapeHtml(classText)} | ${escapeHtml(widthText)}${countText ? ` | ${escapeHtml(countText)}` : ""}</div>
      <div class="kind">${escapeHtml(data.flow || "directed")}</div>
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
  const nodes = (graph.nodes || []).map((node) => ({
    data: {
      ...node,
      is_bus: node.is_bus ? 1 : 0,
    },
  }));

  const edges = (graph.edges || []).map((edge, index) => ({
    data: {
      ...edge,
      is_bus: edge.is_bus ? 1 : 0,
      sig_class: edge.sig_class || "wire",
      id: `${edge.source}->${edge.target}:${edge.kind || "connection"}:${index}`,
    },
  }));

  return [...nodes, ...edges];
}

function getLayoutRoots(graph) {
  const nodes = graph.nodes || [];
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

function renderCyGraph(graph) {
  if (!ensureCytoscape()) {
    return;
  }

  state.cy.elements().remove();
  state.cy.add(buildCyElements(graph));

  const roots = getLayoutRoots(graph);
  const layout = {
    name: "breadthfirst",
    directed: true,
    animate: false,
    padding: 30,
    spacingFactor: graph.nodes.length > 120 ? 1.05 : 1.28,
    avoidOverlap: true,
    transform: (_node, position) => ({ x: position.y, y: position.x }),
  };

  if (roots.length) {
    layout.roots = roots;
  }

  state.cy.layout(layout).run();
  state.cy.fit(undefined, 30);
  graphEmpty.classList.add("hidden");
}

function renderInspector() {
  const summary = state.summary || {};
  const breadcrumbText = state.breadcrumb.length ? state.breadcrumb.join(" > ") : "(none)";

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
      <div><span class="k">Double-click behavior:</span> ${state.selectedNode.kind === "instance" ? "Open instance module graph" : "N/A"}</div>
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
    `;
  }

  inspector.innerHTML = `
    <div><span class="k">Loaded folder:</span><br>${escapeHtml(summary.loaded_folder || "-")}</div>
    <div style="margin-top:10px;"><span class="k">Parser:</span> ${escapeHtml(summary.parser_backend || "-")}</div>
    <div><span class="k">Files:</span> ${summary.file_count ?? 0}</div>
    <div><span class="k">Modules:</span> ${summary.module_count ?? 0}</div>
    <div><span class="k">Top candidates:</span> ${escapeHtml((summary.top_candidates || []).join(", ") || "(none)")}</div>
    <div><span class="k">Selected top:</span> ${escapeHtml(state.selectedTop || "(none)")}</div>
    <div><span class="k">Connectivity focus module:</span> ${escapeHtml(state.selectedModule || "(none)")}</div>
    <div><span class="k">Graph mode:</span> ${escapeHtml(state.graphMode)}</div>
    <div><span class="k">Aggregate edges:</span> ${state.aggregateEdges ? "on" : "off"}</div>
    <div><span class="k">Show unknown:</span> ${state.showUnknownEdges ? "on" : "off"}</div>
    <div><span class="k">Breadcrumb:</span><br>${escapeHtml(breadcrumbText)}</div>
    ${selectionBlock}
  `;
}

function renderGraph(rawGraph) {
  if (!rawGraph) {
    graphTag.textContent = "No graph loaded";
    graphPreview.textContent = "";
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
  graphTag.textContent = `Connectivity: ${focus} | mode: ${graph.mode || state.graphMode} | nodes: ${graph.nodes.length} | edges: ${graph.edges.length}`;
  renderGraphStats(nodeCounts, edgeCounts, edgeSignalCounts);

  const preview = {
    schema_version: graph.schema_version,
    view: graph.view,
    focus_module: focus,
    mode: graph.mode,
    aggregate_edges: state.aggregateEdges,
    show_unknown_edges: state.showUnknownEdges,
    interpretation: {
      note: "This view focuses on module-internal wiring between instances and module I/O.",
      drilldown: "Double-click instance node to open that child module connectivity view.",
    },
    node_kind_counts: nodeCounts,
    edge_kind_counts: edgeCounts,
    edge_signal_class_counts: edgeSignalCounts,
    sample_nodes: (graph.nodes || []).slice(0, 8),
    sample_edges: (graph.edges || []).slice(0, 8),
  };

  graphPreview.textContent = JSON.stringify(preview, null, 2);
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

  const params = new URLSearchParams({
    mode: state.graphMode,
    aggregate_edges: String(state.aggregateEdges),
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
  const folder = folderInput.value.trim();
  if (!folder) {
    setStatus("Need folder path", "error");
    return;
  }

  state.folder = folder;
  state.parser = parserSelect.value;

  try {
    setStatus("Loading...", "busy");
    const summary = await apiRequest("/api/project/load", {
      method: "POST",
      body: JSON.stringify({ folder: state.folder, parser_backend: state.parser }),
    });

    state.summary = summary;
    await refreshProject();
    renderInspector();
    setStatus("Project loaded", "ok");
  } catch (error) {
    setStatus("Load failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    renderGraph(null);
  }
}

loadBtn.addEventListener("click", handleLoad);
refreshBtn.addEventListener("click", async () => {
  try {
    setStatus("Refreshing...", "busy");
    await refreshProject();
    setStatus("Refreshed", "ok");
  } catch (error) {
    setStatus("Refresh failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
});

fitBtn.addEventListener("click", () => {
  if (!state.cy || !state.cy.elements().length) {
    return;
  }
  state.cy.fit(undefined, 30);
});

graphModeSelect.addEventListener("change", async () => {
  state.graphMode = graphModeSelect.value;
  if (!state.selectedModule) {
    return;
  }

  try {
    setStatus("Updating mode...", "busy");
    await loadGraph(state.selectedModule, state.breadcrumb.length ? [...state.breadcrumb] : [state.selectedModule]);
    setStatus("Graph updated", "ok");
  } catch (error) {
    setStatus("Graph update failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
});

aggregateToggle.addEventListener("change", async () => {
  state.aggregateEdges = aggregateToggle.checked;
  if (!state.selectedModule) {
    return;
  }

  try {
    setStatus("Updating edges...", "busy");
    await loadGraph(state.selectedModule, state.breadcrumb.length ? [...state.breadcrumb] : [state.selectedModule]);
    setStatus("Graph updated", "ok");
  } catch (error) {
    setStatus("Graph update failed", "error");
    inspector.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
});

showUnknownToggle.addEventListener("change", () => {
  state.showUnknownEdges = showUnknownToggle.checked;
  if (!state.graph) {
    return;
  }

  renderGraph(state.graph);
  renderInspector();
});

folderInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleLoad();
  }
});

graphModeSelect.value = state.graphMode;
aggregateToggle.checked = state.aggregateEdges;
showUnknownToggle.checked = state.showUnknownEdges;

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
