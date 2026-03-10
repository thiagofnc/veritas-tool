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
  portView: true,
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
const portViewToggle = document.getElementById("portViewToggle");
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

function enforcePortViewMode() {
  if (state.portView) {
    if (state.graphMode !== "compact") {
      state.graphMode = "compact";
    }
    state.aggregateEdges = true;

    graphModeSelect.value = "compact";
    graphModeSelect.disabled = true;
    graphModeSelect.title = "Port view uses compact mode";

    aggregateToggle.checked = true;
    aggregateToggle.disabled = true;
    aggregateToggle.title = "Port view uses aggregated edges";
    return;
  }

  graphModeSelect.disabled = false;
  graphModeSelect.title = "";
  aggregateToggle.disabled = false;
  aggregateToggle.title = "";
}

function getEffectiveGraphMode() {
  return state.portView ? "compact" : state.graphMode;
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
          label: "",
        },
      },
      {
        selector: 'node[kind = "instance"][port_view = 1]',
        style: {
          shape: "round-rectangle",
          width: "mapData(port_count, 0, 40, 90, 210)",
          height: "mapData(port_count, 0, 40, 56, 220)",
          "background-color": "#1a3a52",
          "border-width": 2,
          "border-color": "#5ea6d6",
          label: "data(label)",
          "font-size": 10,
          color: "#d7e2e8",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": 8,
          "text-wrap": "ellipsis",
          "text-max-width": 150,
        },
      },
      {
        selector: 'node[kind = "instance_port"]',
        style: {
          shape: "ellipse",
          width: 9,
          height: 9,
          "background-color": "#ffd38a",
          "border-width": 1,
          "border-color": "#5b4a2f",
          label: "",
        },
      },
      {
        selector: 'node[kind = "instance_port"][direction = "output"]',
        style: {
          "background-color": "#f0b35f",
        },
      },
      {
        selector: 'node[kind = "instance_port"][direction = "input"]',
        style: {
          "background-color": "#a3c6ff",
        },
      },
      {
        selector: 'node[kind = "module_io"]',
        style: {
          "background-color": "#174868",
          shape: "round-rectangle",
          width: "mapData(bit_width, 1, 64, 94, 148)",
          height: 26,
          label: "data(port_name)",
          color: "#d7e2e8",
          "font-size": 9,
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "ellipsis",
          "text-max-width": 128,
          "border-width": 2,
          "border-color": "#4ea6e2",
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
        selector: 'edge[port_view = 1]',
        style: {
          "curve-style": "straight",
          "arrow-scale": 0.65,
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
      port_view: node.port_view ? 1 : 0,
    },
  }));

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

function getLayoutRoots(graph) {
  const nodes = (graph.nodes || []).filter((node) => node.kind !== "instance_port");
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
  if (kind === "instance") {
    return node.id();
  }

  if (kind === "instance_port") {
    return node.data("instance_node_id") || null;
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

  // Cycles are legal in RTL (feedback paths). Keep those nodes visible by assigning
  // them to a near-neighbor level instead of collapsing the entire layout.
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

function placeInstancePortNodes() {
  if (!state.cy) {
    return;
  }

  const portNodes = state.cy.nodes('[kind = "instance_port"]');
  if (!portNodes.length) {
    return;
  }

  const grouped = new Map();
  portNodes.forEach((portNode) => {
    const parentId = portNode.data("instance_node_id");
    if (!parentId) {
      return;
    }

    if (!grouped.has(parentId)) {
      grouped.set(parentId, []);
    }
    grouped.get(parentId).push(portNode);
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

    const placeSide = (sidePorts, xOffset) => {
      if (!sidePorts.length) {
        return;
      }

      const step = (halfHeight * 1.8) / (sidePorts.length + 1);
      sidePorts
        .sort((a, b) => String(a.data("port_name")).localeCompare(String(b.data("port_name"))))
        .forEach((node, idx) => {
          node.position({
            x: center.x + xOffset,
            y: center.y - halfHeight * 0.9 + step * (idx + 1),
          });
        });
    };

    placeSide(leftPorts, -halfWidth - 9);
    placeSide(rightPorts, halfWidth + 9);
  });
}

function placeModuleIoNodes(leftX, rightX) {
  if (!state.cy) {
    return;
  }

  const ioNodes = state.cy.nodes('[kind = "module_io"]');
  if (!ioNodes.length) {
    return;
  }

  const averageConnectedInstanceY = (ioNode) => {
    const ys = [];
    ioNode.connectedEdges().forEach((edge) => {
      const sourceId = edge.source().id();
      const targetId = edge.target().id();
      const otherId = sourceId === ioNode.id() ? targetId : sourceId;
      const instanceId = endpointToInstanceId(otherId);
      if (!instanceId) {
        return;
      }

      const instanceNode = state.cy.getElementById(instanceId);
      if (instanceNode && !instanceNode.empty()) {
        ys.push(instanceNode.position("y"));
      }
    });

    if (!ys.length) {
      return null;
    }

    return ys.reduce((sum, value) => sum + value, 0) / ys.length;
  };

  const placeList = (nodes, x, fallbackStartY) => {
    const enriched = nodes
      .map((node) => ({
        node,
        y: averageConnectedInstanceY(node),
        name: String(node.data("port_name") || node.data("label") || node.id()),
      }))
      .sort((a, b) => {
        if (a.y !== null && b.y !== null) {
          return a.y - b.y;
        }
        if (a.y !== null) {
          return -1;
        }
        if (b.y !== null) {
          return 1;
        }
        return a.name.localeCompare(b.name);
      });

    const minGap = 28;
    let nextY = fallbackStartY;
    for (const item of enriched) {
      let y = item.y === null ? nextY : item.y;
      if (y < nextY) {
        y = nextY;
      }

      item.node.position({ x, y });
      nextY = y + minGap;
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

  placeList(inputNodes, leftX, 110);
  placeList(outputNodes, rightX, 110);
  placeList(unknownNodes, leftX, 110 + inputNodes.length * 30 + 18);
}

function applyPortViewBlockLayout(graph) {
  const instanceNodes = state.cy.nodes('[kind = "instance"]');
  if (!instanceNodes.length) {
    placeModuleIoNodes(120, 420);
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

  const levels = Array.from(groupedByLevel.keys()).sort((a, b) => a - b);
  const canvasHeight = cyGraph.clientHeight || 760;
  const centerY = canvasHeight / 2;
  const levelXStart = 360;
  const levelXStep = 310;

  for (const level of levels) {
    const group = groupedByLevel
      .get(level)
      .sort((a, b) => String(a.data("instance_name") || a.data("label") || a.id()).localeCompare(
        String(b.data("instance_name") || b.data("label") || b.id())
      ));

    const rowGap = group.length > 10 ? 156 : 186;
    const totalHeight = Math.max(0, (group.length - 1) * rowGap);
    const startY = centerY - totalHeight / 2;

    group.forEach((node, idx) => {
      node.position({
        x: levelXStart + level * levelXStep,
        y: startY + idx * rowGap,
      });
    });
  }

  placeInstancePortNodes();

  const xs = instanceNodes.map((node) => node.position("x"));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  placeModuleIoNodes(minX - 240, maxX + 240);
}

function renderCyGraph(graph) {
  if (!ensureCytoscape()) {
    return;
  }

  state.cy.elements().remove();
  state.cy.add(buildCyElements(graph));

  if (state.portView) {
    applyPortViewBlockLayout(graph);
  } else {
    const roots = getLayoutRoots(graph);
    const layout = {
      name: "breadthfirst",
      eles: state.cy.elements().not("node[kind = \"instance_port\"]"),
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
  }

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
    <div><span class="k">Graph mode:</span> ${escapeHtml(getEffectiveGraphMode())}</div>
    <div><span class="k">Aggregate edges:</span> ${getEffectiveAggregateEdges() ? "on" : "off"}</div>
    <div><span class="k">Show unknown:</span> ${state.showUnknownEdges ? "on" : "off"}</div>
    <div><span class="k">Port view (requested):</span> ${state.portView ? "on" : "off"}</div>
    <div><span class="k">Port view (backend):</span> ${state.graph && typeof state.graph.port_view === "boolean" ? (state.graph.port_view ? "on" : "off") : "unknown"}</div>
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
  graphTag.textContent = `Connectivity: ${focus} | mode: ${graph.mode || getEffectiveGraphMode()} | ports(req/backend): ${state.portView ? "on" : "off"}/${graph.port_view ? "on" : "off"} | nodes: ${graph.nodes.length} | edges: ${graph.edges.length}`;
  renderGraphStats(nodeCounts, edgeCounts, edgeSignalCounts);

  const preview = {
    schema_version: graph.schema_version,
    view: graph.view,
    focus_module: focus,
    mode: graph.mode,
    aggregate_edges: getEffectiveAggregateEdges(),
    show_unknown_edges: state.showUnknownEdges,
    port_view: state.portView,
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
  enforcePortViewMode();

  const params = new URLSearchParams({
    mode: getEffectiveGraphMode(),
    aggregate_edges: String(getEffectiveAggregateEdges()),
    port_view: String(state.portView),
  });

  const graph = await apiRequest(`/api/project/connectivity/${encodeURIComponent(moduleName)}?${params.toString()}`);
  const instancePortCount = (graph.nodes || []).filter((node) => node.kind === "instance_port").length;
  if (state.portView && !graph.port_view) {
    setStatus("Backend ignored port view (restart API)", "error");
  } else if (state.portView && instancePortCount === 0) {
    setStatus("No instance pin data available", "busy");
  }

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
  const beforeMode = state.graphMode;
  enforcePortViewMode();
  if (state.portView && beforeMode !== "compact") {
    setStatus("Port view uses compact mode", "busy");
  }

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

portViewToggle.addEventListener("change", async () => {
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
folderInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleLoad();
  }
});

enforcePortViewMode();
graphModeSelect.value = getEffectiveGraphMode();
aggregateToggle.checked = getEffectiveAggregateEdges();
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



