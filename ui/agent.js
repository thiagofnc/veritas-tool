/*
 * Veritas LLM agent panel.
 *
 * Right-hand drawer that drives an LLM agent session. The agent can read/
 * write Verilog files, run simulations, and iterate on results. The panel
 * polls /api/agent/sessions/<id> for new events and translates "navigate"
 * events into actual UI transitions (open module editors, switch to
 * simulation workspace, refresh the hierarchy tree, etc.).
 *
 * Supports any LLM API configured in settings (OpenAI, Anthropic, Ollama,
 * Together, Groq, or a custom OpenAI-compatible endpoint).
 */

(() => {
  "use strict";

  const POLL_MS = 600;

  const st = {
    sessionId: null,
    pollTimer: null,
    lastSeq: 0,
    running: false,
    settings: null,
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

  // ================================================================
  //  Navigation — drive the UI to match what the agent is doing
  // ================================================================

  async function handleNavigate(target) {
    if (!target) return;

    // "modules" → make sure main workspace hierarchy is visible
    if (target === "modules" || target === "refresh") {
      if (window._veritasSim && window._veritasSim.opened) {
        window._veritasSim.exitMode();
      }
      if (typeof refreshProject === "function") {
        try { await refreshProject(); } catch (_) {}
      }
      return;
    }

    // "module:<name>" → load schematic for that module
    const modMatch = target.match(/^module:(.+)$/);
    if (modMatch) {
      if (window._veritasSim && window._veritasSim.opened) {
        window._veritasSim.exitMode();
      }
      if (typeof loadGraph === "function") {
        try { await loadGraph(modMatch[1]); } catch (_) {}
      }
      return;
    }

    // "editor:<name>" → open module source editor overlay
    const edMatch = target.match(/^editor:(.+)$/);
    if (edMatch) {
      if (window._veritasSim && window._veritasSim.opened) {
        window._veritasSim.exitMode();
      }
      if (typeof refreshProject === "function") {
        try { await refreshProject(); } catch (_) {}
      }
      if (typeof openModuleCodeEditor === "function") {
        try { await openModuleCodeEditor(edMatch[1]); } catch (_) {}
      }
      return;
    }

    // "testbench:<path>" → switch to sim workspace, select the testbench
    const tbMatch = target.match(/^testbench:(.+)$/);
    if (tbMatch) {
      const sim = window._veritasSim;
      if (sim) {
        if (!sim.opened) await sim.enterMode();
        await sim.refreshTestbenches();
      }
      return;
    }

    // "simulate:<path>" → switch to sim workspace
    const simMatch = target.match(/^simulate:(.+)$/);
    if (simMatch) {
      const sim = window._veritasSim;
      if (sim && !sim.opened) await sim.enterMode();
      return;
    }
  }

  // ================================================================
  //  Approval prompt — inline in the log
  // ================================================================

  function renderApprovalPrompt(ev) {
    const d = ev.data || {};
    const row = document.createElement("div");
    row.className = "agent-event agent-event-approval";
    row.dataset.approvalPending = "true";
    const previewHtml = d.preview ? `<pre class="agent-approval-preview">${esc(trunc(d.preview, 500))}</pre>` : "";
    row.innerHTML = `
      <span class="agent-ev-tag agent-ev-tag-warn">approval</span>
      <div class="agent-ev-body">
        <div><strong>${esc(d.action)}</strong> ${esc(d.path)}</div>
        ${previewHtml}
        <div class="agent-approval-actions">
          <button class="agent-approve-btn" type="button">Approve</button>
          <button class="agent-deny-btn" type="button">Deny</button>
        </div>
      </div>`;
    row.querySelector(".agent-approve-btn").addEventListener("click", () => respondApproval(true, row));
    row.querySelector(".agent-deny-btn").addEventListener("click", () => respondApproval(false, row));
    return row;
  }

  async function respondApproval(approved, row) {
    if (!st.sessionId) return;
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
  //  Event rendering
  // ================================================================

  function renderEvent(ev) {
    if (ev.kind === "approval_request") return renderApprovalPrompt(ev);

    const row = document.createElement("div");
    row.className = `agent-event agent-event-${ev.kind}`;
    const time = new Date(ev.ts * 1000).toLocaleTimeString();
    let body = "";
    switch (ev.kind) {
      case "status":
        body = `<span class="agent-ev-tag">status</span><span class="agent-ev-body">${esc(ev.data.message || "")}</span>`;
        break;
      case "message":
        body = `<span class="agent-ev-tag agent-ev-tag-msg">agent</span><div class="agent-ev-body agent-ev-msg">${esc(ev.data.text || "")}</div>`;
        break;
      case "tool_call": {
        const inp = ev.data.input ? trunc(JSON.stringify(ev.data.input), 300) : "";
        body = `<span class="agent-ev-tag agent-ev-tag-tool">→ ${esc(ev.data.name)}</span><code class="agent-ev-body agent-ev-code">${esc(inp)}</code>`;
        break;
      }
      case "tool_result": {
        const cls = ev.data.is_error ? "agent-ev-tag-err" : "agent-ev-tag-ok";
        body = `<span class="agent-ev-tag ${cls}">← ${esc(ev.data.name)}</span><span class="agent-ev-body">${esc(ev.data.summary || "")}</span>`;
        break;
      }
      case "navigate":
        body = `<span class="agent-ev-tag agent-ev-tag-nav">navigate</span><span class="agent-ev-body">${esc(ev.data.target || "")}</span>`;
        break;
      case "approval_resolved": {
        const label = ev.data.approved ? (ev.data.auto ? "auto-approved" : "approved") : "denied";
        body = `<span class="agent-ev-tag">${label}</span>`;
        break;
      }
      case "error":
        body = `<span class="agent-ev-tag agent-ev-tag-err">error</span><span class="agent-ev-body">${esc(ev.data.message || "")}</span>`;
        break;
      case "done":
        body = `<span class="agent-ev-tag">done</span><span class="agent-ev-body">status=${esc(ev.data.status || "")}${ev.data.final_text ? " · " + esc(trunc(ev.data.final_text, 240)) : ""}</span>`;
        break;
      default:
        body = `<span class="agent-ev-tag">${esc(ev.kind)}</span><span class="agent-ev-body">${esc(JSON.stringify(ev.data))}</span>`;
    }
    row.innerHTML = `<span class="agent-ev-time">${esc(time)}</span>${body}`;
    return row;
  }

  function appendEvents(events) {
    const log = $("agentLog");
    if (!log) return;
    for (const ev of events) {
      log.appendChild(renderEvent(ev));
      if (ev.kind === "navigate") {
        handleNavigate(ev.data.target).catch(() => {});
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

  function setRunningUI(running) {
    st.running = running;
    const startBtn = $("agentStartBtn");
    const stopBtn = $("agentStopBtn");
    const goalInput = $("agentGoalInput");
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
    if (goalInput) goalInput.disabled = running;
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
    // Populate provider dropdown
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
    // Auto-fill model from preset if currently blank or default
    const modelInput = $("agentSettingsModel");
    if (modelInput && (!modelInput.value || modelInput.value === (s.model || ""))) {
      modelInput.value = info.default_model || "";
    }
    // Show/hide base URL field for custom
    const urlRow = $("agentSettingsBaseUrlRow");
    if (urlRow) urlRow.style.display = prov === "custom" ? "" : "none";
    // Show/hide format field
    const fmtRow = $("agentSettingsFormatRow");
    if (fmtRow) fmtRow.style.display = (prov === "custom" || prov === "anthropic") ? "" : "none";
    // Show/hide API key field for ollama
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

  async function startSession() {
    const goal = ($("agentGoalInput")?.value || "").trim();
    const maxIter = parseInt($("agentMaxIter")?.value || "15", 10) || 15;
    const autoApprove = $("agentAutoApprove")?.checked || false;
    if (!goal) { setStatusBadge("needs goal", "agent-status-warn"); return; }
    $("agentLog").innerHTML = "";
    st.lastSeq = 0;
    setStatusBadge("starting…", "agent-status-run");
    try {
      const resp = await api("/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify({ goal, max_iterations: maxIter, auto_approve: autoApprove }),
      });
      st.sessionId = resp.id;
      setRunningUI(true);
      setStatusBadge("running", "agent-status-run");
      beginPolling();
    } catch (err) {
      setStatusBadge("error", "agent-status-err");
      appendEvents([{ seq: -1, ts: Date.now() / 1000, kind: "error", data: { message: err.message || String(err) } }]);
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
        setStatusBadge("done", "agent-status-ok");
        endPolling(); setRunningUI(false);
        // Final refresh so the user sees all changes
        if (typeof refreshProject === "function") refreshProject().catch(() => {});
      } else if (snap.status === "failed") {
        setStatusBadge("failed", "agent-status-err");
        endPolling(); setRunningUI(false);
      } else if (snap.status === "stopped") {
        setStatusBadge("stopped", "agent-status-warn");
        endPolling(); setRunningUI(false);
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
    if (!st.running) setStatusBadge("idle", "");
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
    $("agentStartBtn")?.addEventListener("click", startSession);
    $("agentStopBtn")?.addEventListener("click", stopSession);
    $("agentSettingsBtn")?.addEventListener("click", openSettingsModal);
    $("agentSettingsClose")?.addEventListener("click", closeSettingsModal);
    $("agentSettingsCancel")?.addEventListener("click", closeSettingsModal);
    $("agentSettingsSave")?.addEventListener("click", saveSettings);
    $("agentSettingsProvider")?.addEventListener("change", onProviderChange);

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
