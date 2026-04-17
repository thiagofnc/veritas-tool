/*
 * Veritas simulation workspace.
 *
 * Built as a self-contained overlay so it can be opened on top of the
 * existing hierarchy/schematic workspace without disturbing any of that
 * state. Talks to the FastAPI `/api/sim/*` endpoints, reuses CodeMirror 5
 * (same version already loaded by index.html) to provide a Verilog-aware
 * testbench editor that visually matches the module editor, and renders
 * waveforms on a canvas tuned to the instrument-grade palette.
 *
 * The waveform viewer is intentionally custom-built: the existing JS
 * waveform libraries are either declarative (WaveDrom, no VCD replay) or
 * framework-coupled, and a canvas of a few hundred lines lets us match the
 * oscilloscope aesthetic (phosphor cyan traces on a fine graticule).
 */

(() => {
  "use strict";

  const API_BASE = "";

  // ---------------- shared state ----------------
  const sim = {
    opened: false,
    testbenches: [],
    activeTb: null,
    editorDirty: false,
    cm: null,
    cmInitPromise: null,
    tools: null,
    lastResult: null,
    // waveform
    waveform: null,           // raw parsed VCD payload
    selectedIds: [],          // ordered list of selected signal ids
    radix: "hex",
    viewStart: 0,
    viewEnd: 1,
    cursorTime: null,
    cursorTimeB: null,         // secondary measurement marker (right-click / Alt+click)
    draggingCursor: false,
    draggingCursorB: false,
    panning: false,
    panAnchor: null,
    canvas: null,
    ctx: null,
    dpr: 1,
    filter: "",
  };

  // ---------------- tiny fetch helper ----------------
  async function api(path, options = {}) {
    const resp = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(payload.detail || `Request failed: ${resp.status}`);
    }
    return payload;
  }

  // ---------------- DOM lookup ----------------
  const $ = (id) => document.getElementById(id);

  // ---------------- screen mode toggle ----------------
  //
  // The Simulate button in the topbar morphs into a Home button when the
  // sim screen is visible. Clicking it toggles back to the main workspace.
  // The sim screen is a sibling of .workspace inside .app-shell; the
  // `body.sim-mode` class swaps which one is shown.
  function bindOpenButton() {
    const toggleBtn = $("openSimBtn");
    if (toggleBtn) toggleBtn.addEventListener("click", toggleMode);

    document.addEventListener("keydown", (e) => {
      if (!sim.opened) return;
      if (e.key === "Escape") {
        // Modal takes priority so Escape closes it first.
        const modal = $("simNewTbOverlay");
        if (modal && !modal.classList.contains("hidden")) {
          closeNewTbModal();
          e.preventDefault();
          return;
        }
        exitMode();
        e.preventDefault();
      }
    });
  }

  function toggleMode() {
    if (sim.opened) exitMode();
    else enterMode();
  }

  async function enterMode() {
    const screen = $("simScreen");
    if (!screen) return;
    screen.classList.remove("hidden");
    document.body.classList.add("sim-mode");
    sim.opened = true;
    updateToggleBtnTooltip();

    try {
      const ctx = await api("/api/project/context");
      const projectEl = $("simProjectPath");
      if (projectEl) {
        projectEl.textContent = ctx.loaded_folder || "No project loaded";
        projectEl.classList.toggle("sim-project-missing", !ctx.loaded_folder);
      }
      if (!ctx.loaded_folder) {
        showRunDisabled("Load a project before running simulations.");
      }
    } catch (err) {
      console.warn("Failed to fetch project context:", err);
    }

    await Promise.all([refreshToolStatus(), refreshTestbenches()]);
    await ensureEditorReady();
  }

  function exitMode() {
    const screen = $("simScreen");
    if (!screen) return;
    screen.classList.add("hidden");
    document.body.classList.remove("sim-mode");
    sim.opened = false;
    updateToggleBtnTooltip();
  }

  function updateToggleBtnTooltip() {
    const btn = $("openSimBtn");
    if (!btn) return;
    btn.title = sim.opened
      ? "Return to the main workspace"
      : "Open simulation workspace";
  }

  // ---------------- tool status badge ----------------
  function showRunDisabled(reason) {
    const btn = $("simRunBtn");
    if (!btn) return;
    btn.disabled = true;
    btn.title = reason || "Run simulation";
  }

  async function refreshToolStatus() {
    const status = $("simToolStatus");
    const dot = status?.querySelector(".sim-tool-dot");
    const label = status?.querySelector(".sim-tool-label");
    const runBtn = $("simRunBtn");

    try {
      const tools = await api("/api/sim/tools");
      sim.tools = tools;
      if (tools.available) {
        status?.classList.remove("error", "warning");
        status?.classList.add("ok");
        if (label) label.textContent = "Icarus Verilog ready";
        if (runBtn) {
          runBtn.disabled = false;
          runBtn.title = "Run simulation (Ctrl+Enter)";
        }
      } else {
        status?.classList.remove("ok");
        status?.classList.add("warning");
        if (label) label.textContent = "Icarus Verilog not found on PATH";
        showRunDisabled("Install Icarus Verilog (iverilog + vvp) and reload.");
      }
    } catch (err) {
      status?.classList.add("error");
      if (label) label.textContent = `Tool check failed: ${err.message}`;
      showRunDisabled(err.message);
    }
  }

  // ---------------- testbench list ----------------
  function bindSidebar() {
    $("simNewTbBtn")?.addEventListener("click", openNewTbModal);
    $("simRefreshTbBtn")?.addEventListener("click", refreshTestbenches);
    $("simNewTbClose")?.addEventListener("click", closeNewTbModal);
    $("simNewTbCancel")?.addEventListener("click", closeNewTbModal);
    $("simNewTbConfirm")?.addEventListener("click", confirmNewTb);
    $("simNewTbName")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmNewTb();
    });
    $("simSaveTbBtn")?.addEventListener("click", saveActiveTb);
    $("simDeleteTbBtn")?.addEventListener("click", deleteActiveTb);
    $("simRunBtn")?.addEventListener("click", runSimulation);
    $("simSignalFilter")?.addEventListener("input", (e) => {
      sim.filter = e.target.value.toLowerCase();
      renderSignalTree();
    });

    // Tabs in the bottom pane.
    document.querySelectorAll(".sim-tab").forEach((btn) => {
      btn.addEventListener("click", () => selectBottomTab(btn.dataset.tab));
    });

    // Waveform controls.
    $("simWaveZoomIn")?.addEventListener("click", () => zoomWaveform(0.6));
    $("simWaveZoomOut")?.addEventListener("click", () => zoomWaveform(1.666));
    $("simWaveZoomFit")?.addEventListener("click", fitWaveform);
    $("simWaveRadix")?.addEventListener("change", (e) => {
      sim.radix = e.target.value;
      drawWaveform();
    });
    $("simWaveClearAll")?.addEventListener("click", () => {
      sim.selectedIds = [];
      renderSignalTree();
      drawWaveform();
    });
    $("simWaveClearB")?.addEventListener("click", () => {
      sim.cursorTimeB = null;
      drawWaveform();
    });

    // Clamp timeout input — browsers don't always enforce min/max on number
    // inputs, and sending a negative timeout would be annoying for the user.
    $("simTimeoutInput")?.addEventListener("change", (e) => {
      const n = Number(e.target.value);
      if (!Number.isFinite(n) || n < 1) e.target.value = 1;
      else if (n > 600) e.target.value = 600;
      else e.target.value = Math.round(n);
    });
  }

  function currentTimeoutSec() {
    const el = $("simTimeoutInput");
    if (!el) return 30;
    const n = Number(el.value);
    if (!Number.isFinite(n) || n < 1) return 1;
    if (n > 600) return 600;
    return Math.round(n);
  }

  async function refreshTestbenches() {
    const list = $("simTbList");
    if (!list) return;
    try {
      const data = await api("/api/sim/testbenches");
      sim.testbenches = data.testbenches || [];
    } catch (err) {
      sim.testbenches = [];
      list.innerHTML = `<li class="sim-empty-hint">${escapeHtml(err.message)}</li>`;
      return;
    }
    renderTestbenchList();
  }

  function renderTestbenchList() {
    const list = $("simTbList");
    if (!list) return;
    list.innerHTML = "";
    if (!sim.testbenches.length) {
      const empty = document.createElement("li");
      empty.className = "sim-empty-hint";
      empty.textContent = "No testbenches yet. Click + to create one, or add a file matching tb_*, *_tb, or containing $dumpvars anywhere in the project.";
      list.appendChild(empty);
      return;
    }

    const managed = sim.testbenches.filter((t) => t.source === "managed");
    const discovered = sim.testbenches.filter((t) => t.source === "discovered");
    appendGroup(list, "Managed", managed);
    appendGroup(list, "Discovered in project", discovered);
  }

  function appendGroup(list, title, items) {
    if (!items.length) return;
    const label = document.createElement("li");
    label.className = "sim-tb-section-label";
    label.textContent = title;
    list.appendChild(label);
    for (const tb of items) {
      const li = document.createElement("li");
      li.className = `sim-tb-item ${tb.source}`;
      if (sim.activeTb?.path === tb.path) li.classList.add("active");
      const sub = tb.relative_path && tb.relative_path !== tb.name
        ? `<span class="sim-tb-sub">${escapeHtml(tb.relative_path)}</span>`
        : "";
      li.innerHTML = `
        <span class="sim-tb-icon">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
        </span>
        <span class="sim-tb-body">
          <span class="sim-tb-name">${escapeHtml(tb.name)}</span>
          ${sub}
        </span>
      `;
      li.addEventListener("click", () => selectTestbench(tb));
      list.appendChild(li);
    }
  }

  async function selectTestbench(tb) {
    if (sim.editorDirty && sim.activeTb && sim.activeTb.path !== tb.path) {
      const proceed = confirm(
        `Discard unsaved changes in ${sim.activeTb.name}?`
      );
      if (!proceed) return;
    }
    try {
      const data = await api(
        `/api/sim/testbench?path=${encodeURIComponent(tb.path)}`
      );
      sim.activeTb = data;
      sim.editorDirty = false;
      renderTestbenchList();
      $("simActiveTbName").textContent = data.name;
      const badge = $("simActiveTbBadge");
      if (badge) {
        badge.textContent = data.source === "discovered" ? "discovered" : "managed";
        badge.className = `sim-active-tb-badge ${data.source}`;
      }
      $("simEditorDirty").classList.add("hidden");
      $("simSaveTbBtn").disabled = false;
      $("simDeleteTbBtn").disabled = data.source === "discovered";
      $("simDeleteTbBtn").title = data.source === "discovered"
        ? "Discovered testbenches can only be removed from the filesystem directly."
        : "Delete this testbench";
      $("simEditorPlaceholder").classList.add("hidden");

      const cm = await ensureEditorReady();
      if (cm) {
        cm.setValue(data.content || "");
        cm.clearHistory();
        cm.refresh();
      }
    } catch (err) {
      alert(`Failed to open testbench: ${err.message}`);
    }
  }

  // ---------------- CodeMirror editor (reuses the same mode/theme as module editor) ----------------
  async function ensureEditorReady() {
    if (sim.cm) return sim.cm;
    if (sim.cmInitPromise) return sim.cmInitPromise;

    sim.cmInitPromise = new Promise((resolve) => {
      // Let the overlay paint before measuring.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const ta = $("simEditorTextarea");
        if (!ta || typeof CodeMirror === "undefined") {
          resolve(null);
          return;
        }
        const cm = CodeMirror.fromTextArea(ta, {
          mode: "verilog",
          theme: "material-darker",
          lineNumbers: true,
          indentUnit: 2,
          tabSize: 2,
          matchBrackets: true,
          lineWrapping: false,
          extraKeys: {
            "Ctrl-S": saveActiveTb,
            "Cmd-S": saveActiveTb,
            "Ctrl-Enter": runSimulation,
            "Cmd-Enter": runSimulation,
          },
        });
        cm.on("change", () => {
          if (!sim.activeTb) return;
          sim.editorDirty = true;
          $("simEditorDirty").classList.remove("hidden");
        });
        sim.cm = cm;
        resolve(cm);
      }));
    });
    return sim.cmInitPromise;
  }

  async function saveActiveTb() {
    if (!sim.activeTb) return;
    const cm = sim.cm;
    if (!cm) return;
    const content = cm.getValue();
    try {
      const data = await api(
        `/api/sim/testbench?path=${encodeURIComponent(sim.activeTb.path)}`,
        { method: "PUT", body: JSON.stringify({ content }) }
      );
      sim.activeTb = data;
      sim.editorDirty = false;
      $("simEditorDirty").classList.add("hidden");
      flashStatus("Saved", "ok");
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  }

  async function deleteActiveTb() {
    if (!sim.activeTb) return;
    const name = sim.activeTb.name;
    const path = sim.activeTb.path;
    if (!confirm(`Delete testbench "${name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/sim/testbench?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      sim.activeTb = null;
      sim.editorDirty = false;
      const cm = sim.cm;
      if (cm) cm.setValue("");
      $("simActiveTbName").textContent = "No testbench selected";
      $("simActiveTbBadge")?.classList.add("hidden");
      $("simSaveTbBtn").disabled = true;
      $("simDeleteTbBtn").disabled = true;
      $("simEditorPlaceholder").classList.remove("hidden");
      $("simEditorDirty").classList.add("hidden");
      await refreshTestbenches();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }

  // ---------------- new testbench modal ----------------
  function openNewTbModal() {
    const modal = $("simNewTbOverlay");
    const input = $("simNewTbName");
    const err = $("simNewTbError");
    if (!modal || !input) return;
    input.value = "";
    if (err) err.textContent = "";
    modal.classList.remove("hidden");
    setTimeout(() => input.focus(), 50);
  }

  function closeNewTbModal() {
    $("simNewTbOverlay")?.classList.add("hidden");
  }

  async function confirmNewTb() {
    const input = $("simNewTbName");
    const err = $("simNewTbError");
    const rawName = (input?.value || "").trim();
    if (!rawName) {
      if (err) err.textContent = "Name is required.";
      return;
    }
    try {
      const tb = await api("/api/sim/testbenches", {
        method: "POST",
        body: JSON.stringify({ name: rawName }),
      });
      closeNewTbModal();
      await refreshTestbenches();
      await selectTestbench(tb);
    } catch (e) {
      if (err) err.textContent = e.message;
    }
  }

  // ---------------- running ----------------
  async function runSimulation() {
    if (!sim.activeTb) {
      alert("Select or create a testbench first.");
      return;
    }
    // Persist any unsaved edits before running.
    if (sim.editorDirty) {
      await saveActiveTb();
    }

    const runBtn = $("simRunBtn");
    const originalLabel = runBtn.innerHTML;
    runBtn.disabled = true;
    runBtn.innerHTML = `<span class="sim-spin"></span> Running...`;
    selectBottomTab("console");
    setConsoleText("Compiling...");

    try {
      const result = await api("/api/sim/run", {
        method: "POST",
        body: JSON.stringify({
          path: sim.activeTb.path,
          timeout_sec: currentTimeoutSec(),
        }),
      });
      sim.lastResult = result;
      renderRunResult(result);
    } catch (err) {
      setConsoleText(`Run failed: ${err.message}`, "error");
      setVerdictBadge(null);
    } finally {
      runBtn.disabled = false;
      runBtn.innerHTML = originalLabel;
    }
  }

  function renderRunResult(result) {
    const parts = [];
    parts.push(
      dimLine(`[compile] ${formatCommand(result)} exit=${result.exit_code ?? "-"} (${result.duration_ms}ms)`)
    );
    if (result.compile_stdout) parts.push(result.compile_stdout);
    if (result.compile_stderr) parts.push(paintStderr(result.compile_stderr));
    if (result.status === "compile_error") {
      parts.push(dimLine("[compile] failed. Fix the issues above and retry."));
    } else if (result.status === "tool_missing") {
      parts.push(dimLine("[compile] Icarus Verilog is not available."));
    } else {
      parts.push(dimLine(`[run] ${result.vvp_path || ""}`));
      if (result.run_stdout) parts.push(result.run_stdout);
      if (result.run_stderr) parts.push(paintStderr(result.run_stderr));
      parts.push(
        dimLine(
          result.status === "ok"
            ? "[run] finished cleanly."
            : `[run] finished with exit=${result.exit_code}`
        )
      );
    }

    $("simConsoleOut").innerHTML = parts.join("\n");
    renderMessages(result.messages || []);
    setVerdictBadge(result);
    renderResultsPanel(result);

    if (result.status === "ok" && result.vcd_path) {
      loadWaveform(result.vcd_path);
    } else if (result.verdict === "fail") {
      // Surface the reason straight away when the run failed.
      selectBottomTab("results");
    } else if (result.status !== "ok") {
      selectBottomTab(result.messages?.length ? "messages" : "console");
    }
  }

  // ---------------- verdict + counters ----------------
  function setVerdictBadge(result) {
    const badge = $("simVerdictBadge");
    const tabBadge = $("simResultsBadge");
    if (!badge) return;
    badge.className = "sim-verdict-badge";
    if (!result) {
      badge.classList.add("hidden");
      if (tabBadge) tabBadge.classList.add("hidden");
      return;
    }
    const verdict = result.verdict || "unknown";
    badge.classList.remove("hidden");
    badge.classList.add(`verdict-${verdict}`);
    badge.textContent = verdict === "pass" ? "PASS"
      : verdict === "fail" ? "FAIL"
      : "NO VERDICT";
    badge.title = result.verdict_reason || "";
    if (tabBadge) {
      tabBadge.classList.remove("hidden", "has-errors", "has-warnings");
      tabBadge.textContent = badge.textContent;
      if (verdict === "fail") tabBadge.classList.add("has-errors");
      else if (verdict === "unknown") tabBadge.classList.add("has-warnings");
    }
  }

  function renderResultsPanel(result) {
    const panel = $("simResultsPanel");
    if (!panel) return;
    const verdict = result.verdict || "unknown";
    const verdictLabel = verdict === "pass" ? "PASS"
      : verdict === "fail" ? "FAIL"
      : "NO VERDICT";
    const events = Array.isArray(result.test_events) ? result.test_events : [];
    const eventPass = events.filter((e) => e.verdict === "pass").length;
    const eventFail = events.filter((e) => e.verdict === "fail").length;
    const counters = [
      { label: "checks passed",     value: eventPass,              kind: eventPass ? "ok" : "dim" },
      { label: "checks failed",     value: eventFail,              kind: eventFail ? "err" : "dim" },
      { label: "errors",            value: result.error_count,     kind: result.error_count ? "err" : "dim" },
      { label: "fatal",             value: result.fatal_count,     kind: result.fatal_count ? "err" : "dim" },
      { label: "assertions failed", value: result.assertion_count, kind: result.assertion_count ? "err" : "dim" },
      { label: "warnings",          value: result.warning_count,   kind: result.warning_count ? "warn" : "dim" },
    ];
    const counterHtml = counters.map((c) => `
      <div class="sim-counter sim-counter-${c.kind}">
        <span class="sim-counter-value">${c.value ?? 0}</span>
        <span class="sim-counter-label">${escapeHtml(c.label)}</span>
      </div>`).join("");

    const testsHtml = renderTestsSection(events);

    let expectedHtml = "";
    if (result.expected_path) {
      const matched = result.expected_matched === true;
      expectedHtml = `
        <section class="sim-results-section">
          <h4>Expected output</h4>
          <div class="sim-expected-head">
            <span class="sim-expected-path">${escapeHtml(shortPath(result.expected_path))}</span>
            <span class="sim-expected-state ${matched ? "ok" : "fail"}">
              ${matched ? "matches run stdout" : "differs from run stdout"}
            </span>
          </div>
          ${result.diff
            ? `<pre class="sim-diff">${renderDiff(result.diff)}</pre>`
            : matched
              ? `<p class="sim-empty-hint">No differences.</p>`
              : ""}
        </section>`;
    } else {
      expectedHtml = `
        <section class="sim-results-section">
          <h4>Expected output</h4>
          <p class="sim-empty-hint">
            No golden file found. Drop a file named
            <code>${escapeHtml(result.testbench?.replace(/\.(sv|v)$/i, "") || "tb_name")}.expected.txt</code>
            next to the testbench to enable automatic diffing.
          </p>
        </section>`;
    }

    panel.innerHTML = `
      <div class="sim-results-header verdict-${verdict}">
        <div class="sim-results-verdict">
          <span class="sim-verdict-chip verdict-${verdict}">${verdictLabel}</span>
          <div class="sim-verdict-reason">${escapeHtml(result.verdict_reason || "")}</div>
        </div>
        <div class="sim-results-meta">
          <span>${escapeHtml(result.testbench || "")}</span>
          <span>${result.duration_ms ?? 0} ms</span>
          ${result.timed_out ? `<span class="sim-results-timeout">timed out</span>` : ""}
        </div>
      </div>
      <div class="sim-counter-grid">${counterHtml}</div>
      ${testsHtml}
      ${expectedHtml}
    `;

    // Wire clickable test rows: left side of a passing/failing test jumps
    // the primary waveform cursor to that test's time.
    panel.querySelectorAll(".sim-test-row[data-time]").forEach((row) => {
      row.addEventListener("click", () => {
        const t = Number(row.getAttribute("data-time"));
        if (!Number.isFinite(t)) return;
        jumpToWaveformTime(t);
      });
    });
  }

  function renderTestsSection(events) {
    if (!events.length) {
      return `
        <section class="sim-results-section">
          <h4>Tests</h4>
          <p class="sim-empty-hint">
            No PASS/FAIL lines detected. Emit one per check, e.g.
            <code>$display("PASS [t=%0t] my_check", $time);</code>
            — the <code>[t=...]</code> tag lets the tool pin each result on the waveform.
          </p>
        </section>`;
    }
    const rows = events.map((e, idx) => {
      const hasTime = Number.isFinite(e.time);
      const timeCell = hasTime
        ? `<span class="sim-test-time">${escapeHtml(formatTime(e.time))}</span>`
        : `<span class="sim-test-time sim-test-time-missing" title="No [t=...] marker on this line">&mdash;</span>`;
      const detail = e.detail && e.detail !== e.name
        ? `<span class="sim-test-detail">${escapeHtml(e.detail)}</span>`
        : "";
      const dataAttr = hasTime ? ` data-time="${escapeAttr(String(e.time))}"` : "";
      const clickable = hasTime ? " sim-test-clickable" : "";
      return `
        <li class="sim-test-row sim-test-${e.verdict}${clickable}"${dataAttr} data-idx="${idx}"
            title="${hasTime ? "Click to jump the A cursor here" : ""}">
          <span class="sim-test-chip sim-test-${e.verdict}">${e.verdict.toUpperCase()}</span>
          ${timeCell}
          <span class="sim-test-name">${escapeHtml(e.name || "(unnamed)")}</span>
          ${detail}
        </li>`;
    }).join("");
    return `
      <section class="sim-results-section">
        <h4>Tests <span class="sim-results-section-hint">click a row with a timestamp to jump the waveform cursor</span></h4>
        <ul class="sim-test-list">${rows}</ul>
      </section>`;
  }

  function jumpToWaveformTime(t) {
    if (!sim.waveform) {
      selectBottomTab("waveform");
      return;
    }
    const total = sim.waveform.end_time || 1;
    const clamped = Math.max(0, Math.min(total, t));
    // If the target is off-screen, center the view on it so the cursor is
    // actually visible after we place it.
    const span = sim.viewEnd - sim.viewStart;
    if (clamped < sim.viewStart || clamped > sim.viewEnd) {
      let start = clamped - span / 2;
      let end = start + span;
      if (start < 0) { end -= start; start = 0; }
      if (end > total) { start -= (end - total); end = total; }
      sim.viewStart = Math.max(0, start);
      sim.viewEnd = Math.max(sim.viewStart + 1, end);
    }
    sim.cursorTime = clamped;
    selectBottomTab("waveform");
    requestAnimationFrame(drawWaveform);
  }

  function renderDiff(diff) {
    return diff.split("\n").map((line) => {
      let cls = "";
      if (line.startsWith("+++") || line.startsWith("---")) cls = "sim-diff-file";
      else if (line.startsWith("@@")) cls = "sim-diff-hunk";
      else if (line.startsWith("+")) cls = "sim-diff-add";
      else if (line.startsWith("-")) cls = "sim-diff-del";
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    }).join("\n");
  }

  function formatCommand(result) {
    return `iverilog -g2012 -s ${result.top_module || "?"} ...`;
  }

  function dimLine(s) {
    return `<span class="sim-console-dim">${escapeHtml(s)}</span>`;
  }

  function paintStderr(s) {
    return s
      .split("\n")
      .map((line) => {
        const lower = line.toLowerCase();
        if (lower.includes("error")) {
          return `<span class="sim-console-err">${escapeHtml(line)}</span>`;
        }
        if (lower.includes("warning")) {
          return `<span class="sim-console-warn">${escapeHtml(line)}</span>`;
        }
        return escapeHtml(line);
      })
      .join("\n");
  }

  function setConsoleText(text, kind = "") {
    const el = $("simConsoleOut");
    if (!el) return;
    const cls = kind === "error" ? "sim-console-err" : "sim-console-dim";
    el.innerHTML = `<span class="${cls}">${escapeHtml(text)}</span>`;
  }

  function renderMessages(messages) {
    const list = $("simMessagesList");
    const badge = $("simMsgBadge");
    if (!list) return;
    list.innerHTML = "";
    const errorCount = messages.filter((m) => m.severity === "error").length;
    const warnCount = messages.filter((m) => m.severity === "warning").length;
    if (badge) {
      badge.classList.toggle("hidden", !messages.length);
      badge.textContent = errorCount || messages.length;
      badge.classList.toggle("has-errors", errorCount > 0);
      badge.classList.toggle("has-warnings", !errorCount && warnCount > 0);
    }
    if (!messages.length) {
      const li = document.createElement("li");
      li.className = "sim-empty-hint";
      li.textContent = "No messages yet.";
      list.appendChild(li);
      return;
    }
    for (const m of messages) {
      const li = document.createElement("li");
      li.className = `sim-msg-item sim-msg-${m.severity}`;
      const location = m.file
        ? `<span class="sim-msg-loc">${escapeHtml(shortPath(m.file))}${m.line ? `:${m.line}` : ""}</span>`
        : "";
      li.innerHTML = `
        <span class="sim-msg-sev">${m.severity}</span>
        ${location}
        <span class="sim-msg-text">${escapeHtml(m.message)}</span>
      `;
      if (m.line && m.file && sim.activeTb && (
          m.file === sim.activeTb.path || m.file.endsWith(sim.activeTb.name))) {
        li.classList.add("sim-msg-clickable");
        li.addEventListener("click", () => {
          const cm = sim.cm;
          if (!cm) return;
          cm.setCursor({ line: Math.max(0, (m.line || 1) - 1), ch: 0 });
          cm.focus();
        });
      }
      list.appendChild(li);
    }
  }

  function shortPath(p) {
    if (!p) return "";
    const parts = p.replace(/\\/g, "/").split("/");
    return parts.slice(-2).join("/");
  }

  // ---------------- tabs ----------------
  function selectBottomTab(name) {
    document.querySelectorAll(".sim-tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.tab === name);
    });
    document.querySelectorAll(".sim-tab-panel").forEach((el) => {
      el.classList.toggle("active", el.dataset.tab === name);
    });
    if (name === "waveform") {
      // Canvas may need a resize after first becoming visible.
      requestAnimationFrame(resizeCanvas);
    }
  }

  // ---------------- waveform: load + render ----------------
  async function loadWaveform(vcdPath) {
    try {
      const data = await api(
        `/api/sim/waveform?path=${encodeURIComponent(vcdPath)}`
      );
      sim.waveform = data;
      sim.viewStart = 0;
      sim.viewEnd = Math.max(1, data.end_time || 1);
      sim.cursorTime = null;
      sim.cursorTimeB = null;
      // Default: auto-pick the first handful of signals so the user sees
      // something useful immediately. Prefer clock-like names first.
      const ranked = [...data.signals].sort((a, b) => {
        const ac = /clk|clock|rst|reset/i.test(a.name) ? 0 : 1;
        const bc = /clk|clock|rst|reset/i.test(b.name) ? 0 : 1;
        return ac - bc;
      });
      sim.selectedIds = ranked.slice(0, 8).map((s) => s.id);
      renderSignalTree();
      selectBottomTab("waveform");
      requestAnimationFrame(drawWaveform);
    } catch (err) {
      setConsoleText(`Failed to load waveform: ${err.message}`, "error");
    }
  }

  function renderSignalTree() {
    const container = $("simSignalTree");
    if (!container) return;
    if (!sim.waveform || !sim.waveform.signals.length) {
      container.innerHTML = `<p class="sim-empty-hint">Run a simulation to populate signals.</p>`;
      return;
    }

    // Group signals by scope for a tidy tree.
    const groups = new Map();
    for (const s of sim.waveform.signals) {
      if (sim.filter && !s.name.toLowerCase().includes(sim.filter)
          && !s.scope.toLowerCase().includes(sim.filter)) {
        continue;
      }
      const key = s.scope || "(top)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    const pieces = [];
    for (const [scope, signals] of [...groups.entries()].sort()) {
      pieces.push(`<div class="sim-sig-group">
        <div class="sim-sig-scope">${escapeHtml(scope)}</div>
        <ul class="sim-sig-list">`);
      for (const s of signals) {
        const checked = sim.selectedIds.includes(s.id) ? "checked" : "";
        const widthLabel = s.width > 1 ? `<span class="sim-sig-width">[${s.width - 1}:0]</span>` : "";
        pieces.push(`
          <li class="sim-sig-row">
            <label>
              <input type="checkbox" data-id="${escapeAttr(s.id)}" ${checked} />
              <span class="sim-sig-name">${escapeHtml(s.name)}</span>
              ${widthLabel}
            </label>
          </li>
        `);
      }
      pieces.push(`</ul></div>`);
    }
    container.innerHTML = pieces.join("");

    container.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = e.target.getAttribute("data-id");
        if (e.target.checked) {
          if (!sim.selectedIds.includes(id)) sim.selectedIds.push(id);
        } else {
          sim.selectedIds = sim.selectedIds.filter((x) => x !== id);
        }
        drawWaveform();
      });
    });
  }

  function zoomWaveform(factor) {
    if (!sim.waveform) return;
    const span = sim.viewEnd - sim.viewStart;
    const focus = sim.cursorTime != null ? sim.cursorTime : sim.viewStart + span / 2;
    const newSpan = Math.max(1, span * factor);
    const ratio = (focus - sim.viewStart) / span;
    let start = focus - newSpan * ratio;
    let end = start + newSpan;
    const total = sim.waveform.end_time || 1;
    if (start < 0) { end -= start; start = 0; }
    if (end > total) { start -= (end - total); end = total; }
    sim.viewStart = Math.max(0, start);
    sim.viewEnd = Math.max(sim.viewStart + 1, end);
    drawWaveform();
  }

  function fitWaveform() {
    if (!sim.waveform) return;
    sim.viewStart = 0;
    sim.viewEnd = Math.max(1, sim.waveform.end_time);
    drawWaveform();
  }

  // ---------------- waveform canvas rendering ----------------
  const LANE_HEIGHT = 26;
  const LANE_PAD = 4;
  const AXIS_HEIGHT = 24;

  function ensureCanvas() {
    if (sim.canvas) return sim.canvas;
    const canvas = $("simWaveCanvas");
    if (!canvas) return null;
    sim.canvas = canvas;
    sim.ctx = canvas.getContext("2d");
    bindCanvasEvents(canvas);
    return canvas;
  }

  function resizeCanvas() {
    const canvas = ensureCanvas();
    const wrap = $("simWaveCanvasWrap");
    if (!canvas || !wrap) return;
    sim.dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.max(1, Math.floor(w * sim.dpr));
    canvas.height = Math.max(1, Math.floor(h * sim.dpr));
    drawWaveform();
  }

  function drawWaveform() {
    const canvas = ensureCanvas();
    if (!canvas) return;
    const wave = sim.waveform;

    const hasSignals = wave && sim.selectedIds.length > 0;
    $("simWaveEmpty").classList.toggle("hidden", !!hasSignals);
    $("simWaveSurface").classList.toggle("hidden", !hasSignals);
    if (!hasSignals) return;

    renderNameColumn();
    updateRangeReadout();

    const ctx = sim.ctx;
    const dpr = sim.dpr;
    ctx.save();
    ctx.scale(dpr, dpr);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#0e0f12";
    ctx.fillRect(0, 0, w, h);

    // Time axis + graticule
    drawTimeAxis(ctx, w);
    drawTestEventMarkers(ctx, w, h);

    const lanes = sim.selectedIds
      .map((id) => wave.signals.find((s) => s.id === id))
      .filter(Boolean);

    for (let i = 0; i < lanes.length; i++) {
      const y = AXIS_HEIGHT + i * LANE_HEIGHT;
      // zebra
      if (i % 2 === 1) {
        ctx.fillStyle = "rgba(255,255,255,0.015)";
        ctx.fillRect(0, y, w, LANE_HEIGHT);
      }
      drawSignalLane(ctx, lanes[i], y, w);
      // lane separator
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + LANE_HEIGHT + 0.5);
      ctx.lineTo(w, y + LANE_HEIGHT + 0.5);
      ctx.stroke();
    }

    // Primary cursor (A) — amber, dashed.
    if (sim.cursorTime != null) {
      const x = timeToX(sim.cursorTime, w);
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
      drawCursorHandle(ctx, x, "A", "#f59e0b");
    }

    // Secondary marker (B) — magenta, dashed. Measurement band between A and B.
    if (sim.cursorTimeB != null) {
      const xb = timeToX(sim.cursorTimeB, w);
      if (sim.cursorTime != null) {
        const xa = timeToX(sim.cursorTime, w);
        const x0 = Math.min(xa, xb);
        const x1 = Math.max(xa, xb);
        ctx.fillStyle = "rgba(217, 70, 239, 0.07)";
        ctx.fillRect(x0, 0, x1 - x0, h);
      }
      ctx.strokeStyle = "#d946ef";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(xb + 0.5, 0);
      ctx.lineTo(xb + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
      drawCursorHandle(ctx, xb, "B", "#d946ef");
    }

    updateCursorReadouts();
    ctx.restore();
  }

  function drawCursorHandle(ctx, x, label, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    const w = 14;
    const h = 12;
    // Small triangular flag so markers are identifiable even without labels.
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + w, 0);
    ctx.lineTo(x + w, h - 4);
    ctx.lineTo(x, h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#0b0c0e";
    ctx.font = "bold 9px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(label, x + w / 2, h / 2 - 1);
    ctx.restore();
  }

  function updateCursorReadouts() {
    const aEl = $("simWaveCursor");
    const bEl = $("simWaveCursorB");
    const dEl = $("simWaveDelta");
    const clearBtn = $("simWaveClearB");
    if (aEl) {
      aEl.innerHTML = sim.cursorTime != null
        ? `A: ${escapeHtml(formatTime(sim.cursorTime))}`
        : "A: &mdash;";
    }
    if (bEl) {
      bEl.innerHTML = sim.cursorTimeB != null
        ? `B: ${escapeHtml(formatTime(sim.cursorTimeB))}`
        : "B: &mdash;";
    }
    if (dEl) {
      if (sim.cursorTime != null && sim.cursorTimeB != null) {
        const delta = Math.abs(sim.cursorTimeB - sim.cursorTime);
        dEl.innerHTML = `&#916;: ${escapeHtml(formatTime(delta))}`;
        dEl.classList.add("active");
      } else {
        dEl.innerHTML = "&#916;: &mdash;";
        dEl.classList.remove("active");
      }
    }
    if (clearBtn) clearBtn.classList.toggle("hidden", sim.cursorTimeB == null);
  }

  function drawTimeAxis(ctx, w) {
    ctx.fillStyle = "#16171b";
    ctx.fillRect(0, 0, w, AXIS_HEIGHT);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(0, AXIS_HEIGHT + 0.5);
    ctx.lineTo(w, AXIS_HEIGHT + 0.5);
    ctx.stroke();

    const span = sim.viewEnd - sim.viewStart;
    const targetTicks = Math.max(4, Math.floor(w / 120));
    const step = niceStep(span / targetTicks);

    ctx.fillStyle = "#71717a";
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "middle";

    const start = Math.ceil(sim.viewStart / step) * step;
    ctx.strokeStyle = "rgba(255,255,255,0.035)";
    for (let t = start; t <= sim.viewEnd; t += step) {
      const x = timeToX(t, w);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, AXIS_HEIGHT);
      ctx.stroke();
      ctx.fillText(formatTime(t), x + 4, AXIS_HEIGHT / 2);
      // graticule extending into the lane area
      ctx.save();
      ctx.strokeStyle = "rgba(34, 211, 238, 0.04)";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, AXIS_HEIGHT);
      ctx.lineTo(x + 0.5, 100000);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Draw small PASS/FAIL flags at the top of the timeline for every test
  // event that carried a [t=...] timestamp. Full-height tinted stems for
  // failures so they're impossible to miss; just the flag for passes.
  function drawTestEventMarkers(ctx, w, h) {
    const events = sim.lastResult?.test_events;
    if (!Array.isArray(events) || !events.length) return;
    const visible = [];
    for (const e of events) {
      if (!Number.isFinite(e.time)) continue;
      if (e.time < sim.viewStart || e.time > sim.viewEnd) continue;
      visible.push(e);
    }
    if (!visible.length) return;

    ctx.save();
    for (const e of visible) {
      const x = timeToX(e.time, w);
      const isFail = e.verdict === "fail";
      const color = isFail ? "#ef4444" : "#4ade80";

      // Full-height translucent stem for failures so the user sees them
      // from across the canvas; passes only draw within the axis band.
      if (isFail) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, AXIS_HEIGHT);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // Flag on the axis itself.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 4, AXIS_HEIGHT - 10);
      ctx.lineTo(x + 4, AXIS_HEIGHT - 10);
      ctx.lineTo(x + 4, AXIS_HEIGHT - 4);
      ctx.lineTo(x, AXIS_HEIGHT);
      ctx.lineTo(x - 4, AXIS_HEIGHT - 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function niceStep(rough) {
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const n = rough / pow;
    let nice;
    if (n < 1.5) nice = 1;
    else if (n < 3) nice = 2;
    else if (n < 7) nice = 5;
    else nice = 10;
    return Math.max(1, nice * pow);
  }

  function timeToX(t, w) {
    const span = sim.viewEnd - sim.viewStart;
    return ((t - sim.viewStart) / span) * w;
  }

  function xToTime(x, w) {
    const span = sim.viewEnd - sim.viewStart;
    return sim.viewStart + (x / w) * span;
  }

  function drawSignalLane(ctx, signal, y, w) {
    const mid = y + LANE_HEIGHT / 2;
    const hiY = y + LANE_PAD;
    const loY = y + LANE_HEIGHT - LANE_PAD;
    const isBus = signal.width > 1;

    const changes = signal.changes || [];
    // Find the value at viewStart (last change at or before it).
    let idx = 0;
    for (let i = 0; i < changes.length; i++) {
      if (changes[i][0] <= sim.viewStart) idx = i;
      else break;
    }

    let value = idx < changes.length ? changes[idx][1] : (signal.width > 1 ? "b0" : "0");
    let t = sim.viewStart;

    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 1.25;
    ctx.beginPath();

    const step = (t0, val0, t1) => {
      const x0 = timeToX(t0, w);
      const x1 = timeToX(t1, w);
      if (isBus) {
        // bus rendered as hex box + label between transitions
        drawBusSegment(ctx, x0, x1, y, val0, signal.width);
      } else {
        const yLevel = scalarLevel(val0, hiY, loY, mid);
        if (val0 === "x" || val0 === "X") {
          drawXZ(ctx, x0, x1, hiY, loY, "x");
        } else if (val0 === "z" || val0 === "Z") {
          drawXZ(ctx, x0, x1, hiY, loY, "z");
        } else {
          ctx.moveTo(x0, yLevel);
          ctx.lineTo(x1, yLevel);
        }
      }
    };

    // Iterate across visible range.
    for (let i = idx; i < changes.length; i++) {
      const [ct, cval] = changes[i];
      if (ct <= t) {
        value = cval;
        continue;
      }
      if (ct >= sim.viewEnd) {
        step(t, value, sim.viewEnd);
        t = sim.viewEnd;
        break;
      }
      step(t, value, ct);
      // transition edge
      if (!isBus && (value === "0" || value === "1") && (cval === "0" || cval === "1") && value !== cval) {
        const x = timeToX(ct, w);
        ctx.moveTo(x, hiY);
        ctx.lineTo(x, loY);
      }
      t = ct;
      value = cval;
    }
    if (t < sim.viewEnd) {
      step(t, value, sim.viewEnd);
    }
    ctx.stroke();
  }

  function scalarLevel(val, hiY, loY, mid) {
    if (val === "1") return hiY;
    if (val === "0") return loY;
    return mid;
  }

  function drawXZ(ctx, x0, x1, hiY, loY, kind) {
    // Hatched band for x/z.
    const color = kind === "x" ? "#ef4444" : "#a1a1aa";
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(x0, hiY, x1 - x0, loY - hiY);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x0, hiY);
    ctx.lineTo(x1, loY);
    ctx.moveTo(x0, loY);
    ctx.lineTo(x1, hiY);
    ctx.stroke();
    ctx.restore();
    // Continue caller's path at the midpoint so we don't leave it in a bad state.
    ctx.moveTo(x1, (hiY + loY) / 2);
  }

  function drawBusSegment(ctx, x0, x1, y, val, width) {
    const hiY = y + LANE_PAD;
    const loY = y + LANE_HEIGHT - LANE_PAD;
    const mid = y + LANE_HEIGHT / 2;
    const isX = /[xX]/.test(val);
    const isZ = /[zZ]/.test(val);
    const color = isX ? "#ef4444" : isZ ? "#a1a1aa" : "#22d3ee";

    // Draw the "<===>" bus shape.
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = "rgba(34, 211, 238, 0.07)";
    if (isX) ctx.fillStyle = "rgba(239, 68, 68, 0.12)";
    if (isZ) ctx.fillStyle = "rgba(161, 161, 170, 0.10)";
    ctx.beginPath();
    ctx.moveTo(x0 + 2, mid);
    ctx.lineTo(x0 + 4, hiY);
    ctx.lineTo(x1 - 4, hiY);
    ctx.lineTo(x1 - 2, mid);
    ctx.lineTo(x1 - 4, loY);
    ctx.lineTo(x0 + 4, loY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Label if the segment is wide enough.
    const segW = x1 - x0;
    if (segW > 40) {
      const text = formatBusValue(val, width, sim.radix);
      ctx.save();
      ctx.fillStyle = "#e4e4e7";
      ctx.font = "11px 'IBM Plex Mono', monospace";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const padded = ctx.measureText(text).width < segW - 12;
      if (padded) {
        ctx.fillText(text, x0 + 8, mid);
      }
      ctx.restore();
    }
  }

  function formatBusValue(raw, width, radix) {
    if (/[xX]/.test(raw)) return "x".repeat(Math.ceil(width / (radix === "hex" ? 4 : 1)));
    if (/[zZ]/.test(raw)) return "z".repeat(Math.ceil(width / (radix === "hex" ? 4 : 1)));
    // raw may be e.g. "0101" or a floating-point "r..." value (we leave reals alone).
    if (/^-?\d+\.\d+/.test(raw)) return raw;
    const bin = raw.padStart(width, raw[0] === "1" ? "0" : raw[0]);
    if (radix === "bin") return `b${bin}`;
    if (radix === "hex") {
      const nibbles = [];
      for (let i = 0; i < bin.length; i += 4) {
        const chunk = bin.slice(i, i + 4).padStart(4, "0");
        if (/[xX]/.test(chunk)) { nibbles.push("x"); continue; }
        if (/[zZ]/.test(chunk)) { nibbles.push("z"); continue; }
        nibbles.push(parseInt(chunk, 2).toString(16));
      }
      return `h${nibbles.join("").toUpperCase()}`;
    }
    if (radix === "dec") {
      if (/[xz]/i.test(bin)) return "?";
      return parseInt(bin, 2).toString(10);
    }
    if (radix === "sdec") {
      if (/[xz]/i.test(bin)) return "?";
      const n = parseInt(bin, 2);
      const signBit = 1 << (width - 1);
      const signed = bin.length >= width && (n & signBit) ? n - (1 << width) : n;
      return String(signed);
    }
    return raw;
  }

  function renderNameColumn() {
    const wave = sim.waveform;
    const col = $("simWaveNames");
    if (!col) return;
    col.innerHTML = "";
    const header = document.createElement("div");
    header.className = "sim-wave-name-header";
    header.textContent = "signal";
    col.appendChild(header);

    for (const id of sim.selectedIds) {
      const sig = wave.signals.find((s) => s.id === id);
      if (!sig) continue;
      const row = document.createElement("div");
      row.className = "sim-wave-name-row";
      const value = sampleAt(sig, sim.cursorTime ?? sim.viewEnd);
      row.innerHTML = `
        <div class="sim-wave-name-top">
          <span class="sim-wave-name-text">${escapeHtml(sig.name)}</span>
          <button class="sim-wave-name-remove" data-id="${escapeAttr(id)}" title="Remove from waveform">&times;</button>
        </div>
        <div class="sim-wave-name-sub">
          <span class="sim-wave-name-scope">${escapeHtml(sig.scope)}</span>
          <span class="sim-wave-name-value">${escapeHtml(
            sig.width > 1 ? formatBusValue(value, sig.width, sim.radix) : value
          )}</span>
        </div>
      `;
      col.appendChild(row);
    }
    col.querySelectorAll(".sim-wave-name-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        sim.selectedIds = sim.selectedIds.filter((x) => x !== id);
        renderSignalTree();
        drawWaveform();
      });
    });
  }

  function sampleAt(signal, t) {
    const changes = signal.changes || [];
    let val = signal.width > 1 ? "b0" : "0";
    for (const [ct, cv] of changes) {
      if (ct <= t) val = cv;
      else break;
    }
    // Strip the "b"/"r" prefix-less form used in VCD body (we stored raw).
    return val;
  }

  function updateRangeReadout() {
    const el = $("simWaveRange");
    if (!el || !sim.waveform) return;
    el.textContent = `${formatTime(sim.viewStart)} — ${formatTime(sim.viewEnd)} / ${formatTime(sim.waveform.end_time)}`;
  }

  function formatTime(t) {
    if (t >= 1e9) return `${(t / 1e9).toFixed(2)}G`;
    if (t >= 1e6) return `${(t / 1e6).toFixed(2)}M`;
    if (t >= 1e3) return `${(t / 1e3).toFixed(2)}k`;
    return `${Math.round(t)}`;
  }

  function bindCanvasEvents(canvas) {
    canvas.addEventListener("wheel", (e) => {
      if (!sim.waveform) return;
      e.preventDefault();
      const w = canvas.clientWidth;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const focus = xToTime(x, w);
      const factor = e.deltaY > 0 ? 1.18 : 0.85;
      const span = sim.viewEnd - sim.viewStart;
      const newSpan = Math.max(1, span * factor);
      const ratio = (focus - sim.viewStart) / span;
      let start = focus - newSpan * ratio;
      let end = start + newSpan;
      const total = sim.waveform.end_time || 1;
      if (start < 0) { end -= start; start = 0; }
      if (end > total) { start -= (end - total); end = total; }
      sim.viewStart = Math.max(0, start);
      sim.viewEnd = Math.max(sim.viewStart + 1, end);
      drawWaveform();
    }, { passive: false });

    canvas.addEventListener("contextmenu", (e) => {
      // Right-click places/moves the secondary marker and suppresses the
      // browser context menu so the user can drag it with the right button.
      if (!sim.waveform) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      sim.cursorTimeB = clampToView(xToTime(x, canvas.clientWidth));
      drawWaveform();
    });

    canvas.addEventListener("mousedown", (e) => {
      if (!sim.waveform) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (e.shiftKey || e.button === 1) {
        sim.panning = true;
        sim.panAnchor = { x, start: sim.viewStart, end: sim.viewEnd };
      } else if (e.button === 2 || e.altKey) {
        // Secondary marker: right mouse button or Alt+left.
        sim.draggingCursorB = true;
        sim.cursorTimeB = clampToView(xToTime(x, canvas.clientWidth));
        drawWaveform();
      } else if (e.button === 0) {
        sim.draggingCursor = true;
        sim.cursorTime = clampToView(xToTime(x, canvas.clientWidth));
        drawWaveform();
      }
    });

    window.addEventListener("mousemove", (e) => {
      if (!sim.waveform) return;
      if (sim.draggingCursor) {
        const rect = canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(canvas.clientWidth, e.clientX - rect.left));
        sim.cursorTime = xToTime(x, canvas.clientWidth);
        drawWaveform();
      } else if (sim.draggingCursorB) {
        const rect = canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(canvas.clientWidth, e.clientX - rect.left));
        sim.cursorTimeB = xToTime(x, canvas.clientWidth);
        drawWaveform();
      } else if (sim.panning && sim.panAnchor) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const w = canvas.clientWidth;
        const span = sim.panAnchor.end - sim.panAnchor.start;
        const dt = ((sim.panAnchor.x - x) / w) * span;
        let start = sim.panAnchor.start + dt;
        let end = sim.panAnchor.end + dt;
        const total = sim.waveform.end_time || 1;
        if (start < 0) { end -= start; start = 0; }
        if (end > total) { start -= (end - total); end = total; }
        sim.viewStart = Math.max(0, start);
        sim.viewEnd = Math.max(sim.viewStart + 1, end);
        drawWaveform();
      }
    });

    window.addEventListener("mouseup", () => {
      sim.draggingCursor = false;
      sim.draggingCursorB = false;
      sim.panning = false;
      sim.panAnchor = null;
    });
  }

  function clampToView(t) {
    return Math.max(sim.viewStart, Math.min(sim.viewEnd, t));
  }

  window.addEventListener("resize", () => {
    if (sim.opened) resizeCanvas();
  });

  // ---------------- tiny helpers ----------------
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function flashStatus(msg, kind) {
    const el = $("simEditorDirty");
    if (!el) return;
    el.classList.remove("hidden");
    el.textContent = msg;
    el.dataset.kind = kind || "";
    setTimeout(() => {
      if (!sim.editorDirty) el.classList.add("hidden");
      else { el.textContent = "unsaved"; el.dataset.kind = ""; }
    }, 1200);
  }

  // ---------------- boot ----------------
  document.addEventListener("DOMContentLoaded", () => {
    bindOpenButton();
    bindSidebar();
  });

  // Expose key functions for agent integration
  async function selectTestbenchByPath(path) {
    if (!path) return false;
    const target = String(path).replace(/\\/g, "/");
    await refreshTestbenches();
    const tb = sim.testbenches.find((t) => {
      const p = String(t.path || "").replace(/\\/g, "/");
      return p === target || p.endsWith(target) || target.endsWith(p);
    });
    if (!tb) return false;
    await selectTestbench(tb);
    return true;
  }

  window._veritasSim = {
    enterMode,
    exitMode,
    refreshTestbenches,
    selectTestbench,
    selectTestbenchByPath,
    loadWaveform,
    jumpToWaveformTime,
    get activeTb() { return sim.activeTb; },
    get opened() { return sim.opened; },
  };
})();
