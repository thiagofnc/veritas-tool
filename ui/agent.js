/*
 * Veritas LLM agent panel — chat-style UI.
 *
 * Right-hand drawer that drives an LLM agent session. The agent can read /
 * write Verilog files, run simulations, and iterate on results. The panel
 * polls /api/agent/sessions/<id> for new events, renders them as chat
 * bubbles / tool chips, and translates certain events into live UI
 * transitions (open the module editor, run the waveform viewer, navigate
 * the hierarchy). The user can follow up with additional messages while the
 * session stays alive — the agent pauses between turns waiting for input.
 *
 * Supports any LLM API configured in settings (OpenAI, Anthropic, Ollama,
 * Together, Groq, or a custom OpenAI-compatible endpoint).
 */

(() => {
  "use strict";

  const POLL_MS = 600;
  const EDITOR_CLOSE_DELAY_MS = 650;

  const st = {
    sessionId: null,
    pollTimer: null,
    lastSeq: 0,
    status: "idle",          // idle | running | awaiting_input | completed | failed | stopped
    settings: null,
    pendingEditor: null,      // { path, module, opened } — tracks editor open/close across edit tool calls
  };

  // --------------- fetch helper ---------------
  async function api(path, options = {}) {
    const opts = { headers: { "Content-Type": "application/json" }, ...options };
    const resp = await fetch(path, opts);
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(payload.detail || `Request failed: ${resp.status}`);
    return payload;
  }

  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function trunc(s, n = 240) {
    s = String(s == null ? "" : s);
    return s.length <= n ? s : s.slice(0, n) + "…";
  }
  function basename(p) {
    return String(p || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
  }

  // ================================================================
  //  UI-hopping helpers — editor open/close, waveform auto-load
  // ================================================================

  async function openEditorForPath(path) {
    const lower = String(path || "").toLowerCase();
    const isSource = lower.endsWith(".v") || lower.endsWith(".sv");
    if (!isSource) return false;
    try {
      if (window._veritasSim && window._veritasSim.opened) {
        window._veritasSim.exitMode();
      }
      if (typeof openSourceFileEditor === "function") {
        await openSourceFileEditor(path);
        return true;
      }
    } catch (_) { /* ignore — editor is best-effort */ }
    return false;
  }

  function closeEditorOverlay() {
    const overlay = document.getElementById("codeEditorOverlay");
    if (overlay && !overlay.classList.contains("hidden")) {
      overlay.classList.add("hidden");
    }
  }

  async function navigateToModule(moduleName) {
    if (!moduleName) return;
    if (window._veritasSim && window._veritasSim.opened) {
      window._veritasSim.exitMode();
    }
    if (typeof loadGraph === "function") {
      try { await loadGraph(moduleName); } catch (_) {}
    }
  }

  async function showSimulationOutput(navData) {
    const sim = window._veritasSim;
    if (!sim) return;
    closeEditorOverlay();
    if (!sim.opened) {
      try { await sim.enterMode(); } catch (_) { return; }
    }
    const tbPath = navData.testbench_path;
    if (tbPath && sim.selectTestbenchByPath) {
      try { await sim.selectTestbenchByPath(tbPath); } catch (_) {}
    }
    const vcdPath = navData.vcd_path;
    if (vcdPath && sim.loadWaveform) {
      try { await sim.loadWaveform(vcdPath); } catch (_) {}
    }
  }

  async function handleNavigate(navData) {
    const target = navData?.target;
    if (!target) return;

    if (target === "modules" || target === "refresh") {
      if (window._veritasSim && window._veritasSim.opened) window._veritasSim.exitMode();
      if (typeof refreshProject === "function") {
        try { await refreshProject(); } catch (_) {}
      }
      return;
    }

    const modMatch = target.match(/^module:(.+)$/);
    if (modMatch) {
      await navigateToModule(modMatch[1]);
      return;
    }

    // editor:<name> fires after an edit_file completes. The editor was already
    // opened during the tool_call — here we navigate to the updated diagram.
    const edMatch = target.match(/^editor:(.+)$/);
    if (edMatch) {
      if (typeof refreshProject === "function") {
        try { await refreshProject(); } catch (_) {}
      }
      // Give the user a moment to see the new file content, then close the
      // editor and show the updated module diagram.
      await new Promise((r) => setTimeout(r, EDITOR_CLOSE_DELAY_MS));
      closeEditorOverlay();
      await navigateToModule(edMatch[1]);
      return;
    }

    const tbMatch = target.match(/^testbench:(.+)$/);
    if (tbMatch) {
      closeEditorOverlay();
      const sim = window._veritasSim;
      if (sim) {
        if (!sim.opened) await sim.enterMode();
        if (sim.selectTestbenchByPath) {
          try { await sim.selectTestbenchByPath(tbMatch[1]); } catch (_) {}
        }
      }
      return;
    }

    if (target.startsWith("simulate:")) {
      await showSimulationOutput(navData);
      return;
    }

    const waveMatch = target.match(/^waveform:(.+)$/);
    if (waveMatch) {
      await showWaveformForAgent(navData);
      return;
    }
  }

  async function showWaveformForAgent(navData) {
    const sim = window._veritasSim;
    if (!sim) return;
    closeEditorOverlay();
    if (!sim.opened) {
      try { await sim.enterMode(); } catch (_) { return; }
    }
    const vcdPath = navData.vcd_path;
    if (vcdPath && sim.loadWaveform) {
      try { await sim.loadWaveform(vcdPath); } catch (_) {}
    }
    const jumpTime = navData.jump_time;
    if (jumpTime != null && sim.jumpToWaveformTime) {
      try { sim.jumpToWaveformTime(Number(jumpTime)); } catch (_) {}
    }
  }

  // Tool-call-driven editor open: show the file that's about to be modified.
  async function onEditingToolCall(toolName, input) {
    const path = input?.path;
    if (!path) return;
    st.pendingEditor = { path, opened: false };
    if (toolName === "create_file") {
      // File doesn't exist yet — we'll let the post-write navigate handler
      // open the editor with the newly-written content.
      return;
    }
    const opened = await openEditorForPath(path);
    st.pendingEditor.opened = opened;
  }

  async function onEditingToolResult(_toolName, detail, input) {
    const path = detail?.path || input?.path;
    if (!path) { st.pendingEditor = null; return; }
    // Reload the editor with the post-write content so the user sees the
    // agent's changes, then close it after a short pause.
    const opened = await openEditorForPath(path);
    st.pendingEditor = { path, opened };
    // Editor close + diagram refresh is handled by the subsequent
    // navigate:editor:<name> event.
  }

  // ================================================================
  //  Patch-file editor integration — highlight old/new lines
  // ================================================================

  // Track CodeMirror line-class marks so we can clear them later.
  let patchMarks = [];

  function clearPatchMarks() {
    const cm = typeof codeEditorState !== "undefined" && codeEditorState.cm;
    if (cm) {
      for (const m of patchMarks) {
        try { cm.removeLineClass(m.line, "background", m.cls); } catch (_) {}
      }
    }
    patchMarks = [];
  }

  function highlightRange(cm, fromLine, toLine, className) {
    const marks = [];
    for (let i = fromLine; i < toLine; i++) {
      cm.addLineClass(i, "background", className);
      marks.push({ line: i, cls: className });
    }
    return marks;
  }

  function findTextInEditor(cm, needle) {
    if (!needle) return null;
    const content = cm.getValue();
    const idx = content.indexOf(needle);
    if (idx === -1) return null;
    const before = content.slice(0, idx);
    const fromLine = before.split("\n").length - 1;
    const needleLines = needle.split("\n").length;
    return { fromLine, toLine: fromLine + needleLines };
  }

  async function onPatchToolCall(input) {
    const path = input?.path;
    if (!path) return;
    st.pendingEditor = { path, opened: false, isPatch: true, patchInput: input };
    const opened = await openEditorForPath(path);
    st.pendingEditor.opened = opened;
    if (!opened) return;

    // Wait briefly for the editor to load content, then highlight the old_string.
    await new Promise((r) => setTimeout(r, 200));
    const cm = typeof codeEditorState !== "undefined" && codeEditorState.cm;
    if (!cm) return;
    const oldStr = input.old_string;
    if (!oldStr) return;
    const range = findTextInEditor(cm, oldStr);
    if (!range) return;
    clearPatchMarks();
    patchMarks = highlightRange(cm, range.fromLine, range.toLine, "agent-patch-old");
    cm.scrollIntoView({ line: range.fromLine, ch: 0 }, 100);
  }

  async function onPatchToolResult(detail, input) {
    const path = detail?.path || input?.path;
    if (!path) { st.pendingEditor = null; return; }

    // Reload the file to show the patched content.
    const opened = await openEditorForPath(path);
    st.pendingEditor = { path, opened };
    if (!opened) return;

    // Wait for content load, then highlight the new_string.
    await new Promise((r) => setTimeout(r, 200));
    const cm = typeof codeEditorState !== "undefined" && codeEditorState.cm;
    if (!cm) return;
    clearPatchMarks();

    // Find the new_string (from the original tool call input).
    const pending = st.pendingEditor;
    const newStr = input?.new_string || (pending?.patchInput?.new_string);
    if (!newStr) return;
    const range = findTextInEditor(cm, newStr);
    if (!range) return;
    patchMarks = highlightRange(cm, range.fromLine, range.toLine, "agent-patch-new");
    cm.scrollIntoView({ line: range.fromLine, ch: 0 }, 100);

    // Fade out the highlight after a few seconds.
    setTimeout(() => {
      clearPatchMarks();
    }, 4000);
  }

  // ================================================================
  //  Approval prompt — inline in the chat stream
  // ================================================================

  function renderApprovalCard(ev) {
    const d = ev.data || {};
    const row = document.createElement("div");
    row.className = "agent-msg agent-msg-approval";
    row.dataset.approvalPending = "true";
    const previewHtml = d.preview
      ? `<pre class="agent-approval-preview">${esc(trunc(d.preview, 600))}</pre>` : "";
    row.innerHTML = `
      <div class="agent-approval-head">
        <span class="agent-approval-tag">needs approval</span>
        <strong>${esc(d.action)}</strong>
        <code>${esc(basename(d.path))}</code>
      </div>
      ${previewHtml}
      <div class="agent-approval-actions">
        <button class="agent-deny-btn" type="button">Deny</button>
        <button class="agent-approve-btn" type="button">Approve</button>
      </div>`;
    row.querySelector(".agent-approve-btn").addEventListener("click", () => respondApproval(true, row));
    row.querySelector(".agent-deny-btn").addEventListener("click", () => respondApproval(false, row));
    return row;
  }

  async function respondApproval(approved, row) {
    if (!st.sessionId) return;
    // Clear any patch highlights immediately on approval/denial.
    clearPatchMarks();
    if (!approved) {
      // On deny, close the editor since the patch won't be applied.
      closeEditorOverlay();
    }
    try {
      await api(`/api/agent/sessions/${st.sessionId}/approve`, {
        method: "POST",
        body: JSON.stringify({ approved }),
      });
    } catch (err) {
      console.warn("approval response failed:", err);
    }
    const actions = row.querySelector(".agent-approval-actions");
    if (actions) {
      actions.innerHTML = `<span class="agent-approval-resolved">${approved ? "✓ Approved" : "✗ Denied"}</span>`;
    }
    row.dataset.approvalPending = "false";
  }

  // ================================================================
  //  Chat rendering
  // ================================================================

  function toolDetailText(name, detail) {
    if (!detail) return "";
    if (detail.error) return `error: ${trunc(detail.error, 180)}`;
    switch (name) {
      case "run_simulation": {
        const v = (detail.verdict || "unknown").toString().toUpperCase();
        const parts = [`${v}`];
        if (detail.pass_count != null) parts.push(`${detail.pass_count} pass`);
        if (detail.fail_count != null) parts.push(`${detail.fail_count} fail`);
        if (detail.error_count) parts.push(`${detail.error_count} err`);
        if (detail.vcd_path) parts.push("waveform ready");
        return parts.join(" · ");
      }
      case "list_modules":
        if (!detail.count) return "no modules";
        return `${detail.count} module${detail.count === 1 ? "" : "s"}` +
          (detail.preview?.length ? ` — ${detail.preview.slice(0, 5).join(", ")}${detail.count > 5 ? ", …" : ""}` : "");
      case "list_testbenches":
        if (!detail.count) return "no testbenches";
        return `${detail.count} testbench${detail.count === 1 ? "" : "es"}` +
          (detail.preview?.length ? ` — ${detail.preview.slice(0, 4).join(", ")}${detail.count > 4 ? ", …" : ""}` : "");
      case "read_file":
        return `${basename(detail.path)} · ${detail.lines || 0} lines, ${detail.chars || 0} chars`;
      case "edit_file":
      case "create_file":
      case "create_testbench":
        return basename(detail.path);
      case "patch_file":
        return basename(detail.path);
      case "get_module_info": {
        const parts = [detail.module || "?"];
        if (detail.port_count != null) parts.push(`${detail.port_count} ports`);
        if (detail.instance_count) parts.push(`${detail.instance_count} instances`);
        if (detail.ports_preview?.length) parts.push(detail.ports_preview.slice(0, 4).join(", "));
        return parts.join(" · ");
      }
      case "search_files":
        return `"${trunc(detail.pattern || "", 40)}" — ${detail.match_count || 0} match${detail.match_count === 1 ? "" : "es"}`;
      case "note_to_self":
        return `${detail.note_count || 0} note${(detail.note_count || 0) === 1 ? "" : "s"} saved`;
      case "finish":
        return detail.success ? `complete — ${trunc(detail.summary, 160)}` : `blocked — ${trunc(detail.summary, 160)}`;
      default:
        return "";
    }
  }

  function renderUserMessage(ev) {
    const row = document.createElement("div");
    row.className = "agent-msg agent-msg-user";
    row.innerHTML = `<div class="agent-bubble agent-bubble-user">${esc(ev.data.text || "")}</div>`;
    return row;
  }

  function renderAssistantMessage(ev) {
    const row = document.createElement("div");
    row.className = "agent-msg agent-msg-assistant";
    row.innerHTML = `<div class="agent-bubble agent-bubble-assistant">${esc(ev.data.text || "")}</div>`;
    return row;
  }

  function renderToolChip(kind, name, text, isError) {
    const row = document.createElement("div");
    row.className = `agent-msg agent-tool-line agent-tool-${kind}${isError ? " agent-tool-err" : ""}`;
    const arrow = kind === "call" ? "→" : "←";
    row.innerHTML = `
      <span class="agent-tool-arrow">${arrow}</span>
      <span class="agent-tool-name">${esc(name)}</span>
      ${text ? `<span class="agent-tool-detail">${esc(text)}</span>` : ""}`;
    return row;
  }

  function renderStatusLine(text, cls) {
    const row = document.createElement("div");
    row.className = `agent-msg agent-status-line ${cls || ""}`.trim();
    row.textContent = text;
    return row;
  }

  function renderEvent(ev) {
    switch (ev.kind) {
      case "user_message":
        return renderUserMessage(ev);
      case "message":
        return renderAssistantMessage(ev);
      case "tool_call": {
        const args = ev.data.input || {};
        const name = ev.data.name;
        let hint = "";
        if (name === "get_module_info") hint = args.module_name || "";
        else if (name === "search_files") hint = `"${(args.pattern || "").slice(0, 50)}"`;
        else if (name === "note_to_self") hint = trunc(args.note || "", 60);
        else if (name === "patch_file") hint = basename(args.path);
        else if (args.path) hint = basename(args.path);
        else if (args.testbench_path) hint = basename(args.testbench_path);
        else if (args.name) hint = String(args.name);
        return renderToolChip("call", name, hint, false);
      }
      case "tool_result": {
        const text = toolDetailText(ev.data.name, ev.data.detail) || ev.data.summary || "";
        return renderToolChip("result", ev.data.name, text, !!ev.data.is_error);
      }
      case "approval_request":
        return renderApprovalCard(ev);
      case "approval_resolved":
        return null; // handled inline on the approval card
      case "navigate":
        return null; // no chat entry for navigation; side-effect only
      case "awaiting_input":
        return renderStatusLine("Your turn — send a follow-up message, or leave it as complete.", "agent-status-awaiting");
      case "error":
        return renderStatusLine(`error: ${ev.data.message || ""}`, "agent-status-error");
      case "done":
        return renderStatusLine(`Session ${ev.data.status}.`, "agent-status-done");
      case "status": {
        // Only show iteration markers faintly; skip the rest to avoid noise.
        if (ev.data && ev.data.iteration) {
          return renderStatusLine(`· iteration ${ev.data.iteration} ·`, "agent-status-iter");
        }
        return null;
      }
      default:
        return null;
    }
  }

  function appendEvents(events) {
    const log = $("agentMessages");
    if (!log) return;
    const empty = $("agentEmptyHint");
    if (events.length && empty) empty.remove();

    for (const ev of events) {
      const el = renderEvent(ev);
      if (el) log.appendChild(el);

      // Side-effects — UI hopping
      const isEditTool = ev.data.name === "edit_file" || ev.data.name === "create_file";
      if (ev.kind === "tool_call" && isEditTool) {
        onEditingToolCall(ev.data.name, ev.data.input).catch(() => {});
      }
      if (ev.kind === "tool_call" && ev.data.name === "patch_file") {
        onPatchToolCall(ev.data.input).catch(() => {});
      }
      if (ev.kind === "tool_result" && isEditTool && !ev.data.is_error) {
        const orig = events.find((e) => e.kind === "tool_call" && e.data.id === ev.data.id);
        onEditingToolResult(ev.data.name, ev.data.detail, orig?.data?.input || {}).catch(() => {});
      }
      if (ev.kind === "tool_result" && ev.data.name === "patch_file" && !ev.data.is_error) {
        const orig = events.find((e) => e.kind === "tool_call" && e.data.id === ev.data.id);
        onPatchToolResult(ev.data.detail, orig?.data?.input || {}).catch(() => {});
      }
      if (ev.kind === "navigate") {
        handleNavigate(ev.data).catch(() => {});
      }
    }
    log.scrollTop = log.scrollHeight;
  }

  function setStatusBadge(text, cls) {
    const el = $("agentStatusBadge");
    if (!el) return;
    el.textContent = text;
    el.className = `agent-status-badge ${cls || ""}`.trim();
  }

  function setIterationCounter(cur, max) {
    const el = $("agentIterCount");
    if (el) el.textContent = cur != null ? `${cur} / ${max}` : "—";
  }

  // -- Cooking indicator (animated dots: . → .. → ... → .) --
  let cookingTimer = null;
  function setCookingVisible(visible) {
    const bar = $("agentCooking");
    if (!bar) return;
    if (visible) {
      bar.classList.remove("hidden");
      if (!cookingTimer) {
        const textEl = bar.querySelector(".agent-cooking-text");
        let dotCount = 0;
        cookingTimer = setInterval(() => {
          dotCount = (dotCount % 3) + 1;
          textEl.textContent = "Agent is cooking" + ".".repeat(dotCount);
        }, 500);
      }
    } else {
      bar.classList.add("hidden");
      if (cookingTimer) { clearInterval(cookingTimer); cookingTimer = null; }
    }
  }

  function setUIForStatus(status) {
    st.status = status;
    const sendBtn = $("agentSendBtn");
    const stopBtn = $("agentStopBtn");
    const input = $("agentInput");

    const isTerminal = (status === "completed" || status === "failed" || status === "stopped" || status === "idle");
    if (stopBtn) stopBtn.disabled = (status !== "running" && status !== "awaiting_input");
    if (sendBtn) {
      sendBtn.disabled = (status === "running");
      sendBtn.textContent = isTerminal ? "Send" : (status === "awaiting_input" ? "Send" : "Sending…");
    }
    if (input) input.disabled = (status === "running");

    setCookingVisible(status === "running");

    switch (status) {
      case "running": setStatusBadge("running", "agent-status-run"); break;
      case "awaiting_input": setStatusBadge("your turn", "agent-status-warn"); break;
      case "completed": setStatusBadge("done", "agent-status-ok"); break;
      case "failed": setStatusBadge("failed", "agent-status-err"); break;
      case "stopped": setStatusBadge("stopped", "agent-status-warn"); break;
      case "idle":
      default: setStatusBadge("idle", ""); break;
    }
  }

  // ================================================================
  //  Settings modal — multi-provider
  // ================================================================

  async function loadSettings() {
    try { st.settings = await api("/api/agent/settings"); } catch (_) { st.settings = { has_api_key: false }; }
    updateSettingsHint();
  }

  function updateSettingsHint() {
    const hint = $("agentSettingsHint");
    if (!hint) return;
    const s = st.settings || {};
    if (!s.has_api_key && s.provider !== "ollama") {
      hint.textContent = "No API key configured — click the key icon.";
      hint.classList.add("agent-hint-warn");
    } else {
      const source = s.key_source ? ` · key from ${s.key_source}` : "";
      hint.textContent = `${s.provider_label || s.provider || "?"} · ${s.model || "default model"}${source}`;
      hint.classList.remove("agent-hint-warn");
    }
  }

  function openSettingsModal() {
    const ov = $("agentSettingsOverlay");
    if (!ov) return;
    ov.classList.remove("hidden");
    $("agentSettingsKey").value = "";
    const s = st.settings || {};
    const provSel = $("agentSettingsProvider");
    if (provSel && s.providers) {
      provSel.innerHTML = "";
      for (const [key, info] of Object.entries(s.providers)) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = info.label;
        if (key === s.provider) opt.selected = true;
        provSel.appendChild(opt);
      }
    }
    $("agentSettingsBaseUrl").value = s.base_url || "";
    $("agentSettingsModel").value = s.model || "";
    $("agentSettingsFormat").value = s.format || "openai";
    $("agentSettingsAutoApprove").checked = !!s.auto_approve;
    $("agentSettingsClearKey").checked = false;
    $("agentSettingsError").textContent = "";
    const keyHint = $("agentSettingsKeyHint");
    if (keyHint) {
      const source = s.key_source ? ` Active key source: ${s.key_source}.` : "";
      const saved = s.has_saved_api_key ? " A saved key exists." : " No saved key.";
      keyHint.innerHTML = `Stored locally at <code>~/.veritas/settings.json</code>. Enter a new key to replace it.${source}${saved}`;
    }
    onProviderChange();
  }

  function onProviderChange() {
    const provSel = $("agentSettingsProvider");
    const s = st.settings || {};
    if (!provSel || !s.providers) return;
    const prov = provSel.value;
    const info = s.providers[prov];
    if (!info) return;
    const modelInput = $("agentSettingsModel");
    if (modelInput && (!modelInput.value || modelInput.value === (s.model || ""))) {
      modelInput.value = info.default_model || "";
    }
    const baseUrlInput = $("agentSettingsBaseUrl");
    if (baseUrlInput && prov !== "custom") {
      baseUrlInput.value = info.base_url || "";
    }
    const formatInput = $("agentSettingsFormat");
    if (formatInput && prov !== "custom") {
      formatInput.value = info.format || "openai";
    }
    const urlRow = $("agentSettingsBaseUrlRow");
    if (urlRow) urlRow.style.display = prov === "custom" ? "" : "none";
    const fmtRow = $("agentSettingsFormatRow");
    if (fmtRow) fmtRow.style.display = (prov === "custom" || prov === "anthropic") ? "" : "none";
    const keyRow = $("agentSettingsKeyRow");
    if (keyRow) keyRow.style.display = prov === "ollama" ? "none" : "";
  }

  function closeSettingsModal() {
    const ov = $("agentSettingsOverlay");
    if (ov) ov.classList.add("hidden");
  }

  async function saveSettings() {
    const key = ($("agentSettingsKey")?.value || "").trim();
    const clearKey = $("agentSettingsClearKey")?.checked || false;
    const provider = ($("agentSettingsProvider")?.value || "").trim();
    const base_url = ($("agentSettingsBaseUrl")?.value || "").trim();
    const model = ($("agentSettingsModel")?.value || "").trim();
    const format = ($("agentSettingsFormat")?.value || "").trim();
    const auto_approve = $("agentSettingsAutoApprove")?.checked || false;
    try {
      await api("/api/agent/settings", {
        method: "POST",
        body: JSON.stringify({
          api_key: key || null,
          clear_api_key: clearKey,
          provider: provider || null,
          base_url: base_url || null,
          model: model || null,
          format: format || null,
          auto_approve,
        }),
      });
      await loadSettings();
      closeSettingsModal();
    } catch (err) {
      const errEl = $("agentSettingsError");
      if (errEl) errEl.textContent = err.message || String(err);
    }
  }

  // ================================================================
  //  Session lifecycle
  // ================================================================

  function resetChat() {
    const log = $("agentMessages");
    if (log) log.innerHTML = `
      <div class="agent-empty-hint" id="agentEmptyHint">
        <p>Start a chat by describing a goal — “add a testbench for uart_rx”, “find why tb_fifo fails”, …</p>
        <p class="agent-empty-sub">The agent can read files, edit code, and run simulations. It will follow up with you when it has questions or finishes a turn.</p>
      </div>`;
    st.sessionId = null;
    st.lastSeq = 0;
    setIterationCounter(null, null);
  }

  async function startSession(goal) {
    const maxIter = parseInt($("agentMaxIter")?.value || "15", 10) || 15;
    const autoApprove = $("agentAutoApprove")?.checked || false;
    setStatusBadge("starting…", "agent-status-run");
    try {
      const resp = await api("/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify({ goal, max_iterations: maxIter, auto_approve: autoApprove }),
      });
      st.sessionId = resp.id;
      setUIForStatus("running");
      beginPolling();
    } catch (err) {
      setUIForStatus("idle");
      appendEvents([{ seq: -1, ts: Date.now() / 1000, kind: "error", data: { message: err.message || String(err) } }]);
    }
  }

  async function sendFollowUp(text) {
    if (!st.sessionId) return;
    try {
      await api(`/api/agent/sessions/${st.sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setUIForStatus("running");
    } catch (err) {
      appendEvents([{ seq: -1, ts: Date.now() / 1000, kind: "error", data: { message: err.message || String(err) } }]);
    }
  }

  async function onSend() {
    const input = $("agentInput");
    const text = (input?.value || "").trim();
    if (!text) return;

    const terminal = (st.status === "completed" || st.status === "failed" || st.status === "stopped" || st.status === "idle" || !st.sessionId);
    if (terminal) {
      resetChat();
      if (input) input.value = "";
      await startSession(text);
    } else if (st.status === "awaiting_input") {
      if (input) input.value = "";
      await sendFollowUp(text);
    } else {
      // running — button should be disabled, but guard anyway
    }
  }

  async function stopSession() {
    if (!st.sessionId) return;
    try { await api(`/api/agent/sessions/${st.sessionId}/stop`, { method: "POST" }); } catch (_) {}
  }

  function beginPolling() {
    if (st.pollTimer) clearInterval(st.pollTimer);
    st.pollTimer = setInterval(pollOnce, POLL_MS);
  }

  function endPolling() {
    if (st.pollTimer) clearInterval(st.pollTimer);
    st.pollTimer = null;
  }

  async function pollOnce() {
    if (!st.sessionId) return;
    try {
      const snap = await api(`/api/agent/sessions/${st.sessionId}?since_seq=${st.lastSeq}`);
      if (snap.events?.length) {
        appendEvents(snap.events);
        st.lastSeq = snap.last_seq || st.lastSeq;
      }
      setIterationCounter(snap.iterations, snap.max_iterations);
      if (snap.status === "completed") {
        setUIForStatus("completed");
        endPolling();
        if (typeof refreshProject === "function") refreshProject().catch(() => {});
      } else if (snap.status === "failed") {
        setUIForStatus("failed");
        endPolling();
      } else if (snap.status === "stopped") {
        setUIForStatus("stopped");
        endPolling();
      } else if (snap.status === "awaiting_input") {
        setUIForStatus("awaiting_input");
      } else if (snap.status === "running" || snap.status === "pending") {
        if (st.status !== "running") setUIForStatus("running");
      }
    } catch (err) {
      console.warn("agent poll failed:", err);
    }
  }

  // ================================================================
  //  Panel open/close
  // ================================================================

  function openPanel() {
    const p = $("agentPanel");
    if (!p) return;
    p.classList.remove("hidden");
    loadSettings();
    if (!st.sessionId) setUIForStatus("idle");
  }

  function closePanel() {
    const p = $("agentPanel");
    if (p) p.classList.add("hidden");
  }

  // ================================================================
  //  Boot
  // ================================================================

  function bind() {
    $("agentOpenBtn")?.addEventListener("click", openPanel);
    $("agentCloseBtn")?.addEventListener("click", closePanel);
    $("agentSendBtn")?.addEventListener("click", () => { onSend().catch(() => {}); });
    $("agentStopBtn")?.addEventListener("click", stopSession);
    $("agentSettingsBtn")?.addEventListener("click", openSettingsModal);
    $("agentSettingsClose")?.addEventListener("click", closeSettingsModal);
    $("agentSettingsCancel")?.addEventListener("click", closeSettingsModal);
    $("agentSettingsSave")?.addEventListener("click", saveSettings);
    $("agentSettingsProvider")?.addEventListener("change", onProviderChange);

    const input = $("agentInput");
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSend().catch(() => {});
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const ov = $("agentSettingsOverlay");
        if (ov && !ov.classList.contains("hidden")) { closeSettingsModal(); e.preventDefault(); }
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
