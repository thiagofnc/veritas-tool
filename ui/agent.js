/*
 * Veritas LLM agent panel.
 *
 * Lets a user state a goal in plain English, then drives an Anthropic
 * tool-use loop that can read modules, edit them, author testbenches, run
 * simulations, and iterate on the results until the verdict is "pass".
 *
 * The panel lives as a right-hand overlay on top of the simulation
 * workspace (so the user can watch the waveform + results update live). It
 * polls /api/agent/sessions/<id> every 500 ms for new events while the
 * session is running. Each tool call renders as a small expandable card
 * with a header summary — rest of the event stream is text messages.
 */

(() => {
  "use strict";

  const POLL_INTERVAL_MS = 600;

  const state = {
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

  // --------------- rendering ---------------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function truncate(s, n = 240) {
    s = String(s == null ? "" : s);
    if (s.length <= n) return s;
    return s.slice(0, n) + "…";
  }

  function renderEvent(ev) {
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
        const inp = ev.data.input ? truncate(JSON.stringify(ev.data.input), 300) : "";
        body = `<span class="agent-ev-tag agent-ev-tag-tool">→ ${esc(ev.data.name)}</span><code class="agent-ev-body agent-ev-code">${esc(inp)}</code>`;
        break;
      }
      case "tool_result": {
        const cls = ev.data.is_error ? "agent-ev-tag-err" : "agent-ev-tag-ok";
        body = `<span class="agent-ev-tag ${cls}">← ${esc(ev.data.name)}</span><span class="agent-ev-body">${esc(ev.data.summary || "")}</span>`;
        break;
      }
      case "error":
        body = `<span class="agent-ev-tag agent-ev-tag-err">error</span><span class="agent-ev-body">${esc(ev.data.message || "")}</span>`;
        break;
      case "done":
        body = `<span class="agent-ev-tag">done</span><span class="agent-ev-body">status=${esc(ev.data.status || "")}${ev.data.final_text ? " · " + esc(truncate(ev.data.final_text, 240)) : ""}</span>`;
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
    for (const ev of events) log.appendChild(renderEvent(ev));
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
    state.running = running;
    const startBtn = $("agentStartBtn");
    const stopBtn = $("agentStopBtn");
    const goalInput = $("agentGoalInput");
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
    if (goalInput) goalInput.disabled = running;
  }

  // --------------- settings modal ---------------
  async function loadSettings() {
    try {
      state.settings = await api("/api/agent/settings");
    } catch (err) {
      state.settings = { has_api_key: false, source: null };
    }
    updateSettingsHint();
  }

  function updateSettingsHint() {
    const hint = $("agentSettingsHint");
    if (!hint) return;
    const s = state.settings || {};
    if (!s.has_api_key) {
      hint.textContent = "No Anthropic API key configured. Click the key icon to add one.";
      hint.classList.add("agent-hint-warn");
    } else {
      hint.textContent = `API key loaded (${s.source || "unknown"}) · model: ${s.model || "default"}`;
      hint.classList.remove("agent-hint-warn");
    }
  }

  function openSettingsModal() {
    const overlay = $("agentSettingsOverlay");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    $("agentSettingsKey").value = "";
    $("agentSettingsModel").value = (state.settings && state.settings.model) || "";
    $("agentSettingsError").textContent = "";
  }

  function closeSettingsModal() {
    const overlay = $("agentSettingsOverlay");
    if (overlay) overlay.classList.add("hidden");
  }

  async function saveSettings() {
    const key = $("agentSettingsKey").value.trim();
    const model = $("agentSettingsModel").value.trim();
    try {
      await api("/api/agent/settings", {
        method: "POST",
        body: JSON.stringify({
          anthropic_api_key: key || null,
          model: model || null,
        }),
      });
      await loadSettings();
      closeSettingsModal();
    } catch (err) {
      $("agentSettingsError").textContent = err.message || String(err);
    }
  }

  // --------------- session lifecycle ---------------
  async function startSession() {
    const goal = ($("agentGoalInput")?.value || "").trim();
    const maxIter = parseInt($("agentMaxIter")?.value || "15", 10) || 15;
    if (!goal) {
      setStatusBadge("needs goal", "agent-status-warn");
      return;
    }
    $("agentLog").innerHTML = "";
    state.lastSeq = 0;
    setStatusBadge("starting…", "agent-status-run");
    try {
      const resp = await api("/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify({ goal, max_iterations: maxIter }),
      });
      state.sessionId = resp.id;
      setRunningUI(true);
      setStatusBadge("running", "agent-status-run");
      beginPolling();
    } catch (err) {
      setStatusBadge("error", "agent-status-err");
      appendEvents([{
        seq: -1, ts: Date.now() / 1000, kind: "error",
        data: { message: err.message || String(err) },
      }]);
    }
  }

  async function stopSession() {
    if (!state.sessionId) return;
    try {
      await api(`/api/agent/sessions/${state.sessionId}/stop`, { method: "POST" });
    } catch (err) {
      // Stop is best-effort; the poll loop will reflect final state.
    }
  }

  function beginPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }

  function endPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function pollOnce() {
    if (!state.sessionId) return;
    try {
      const snap = await api(`/api/agent/sessions/${state.sessionId}?since_seq=${state.lastSeq}`);
      if (snap.events && snap.events.length) {
        appendEvents(snap.events);
        state.lastSeq = snap.last_seq || state.lastSeq;
      }
      setIterationCounter(snap.iterations, snap.max_iterations);
      if (snap.status === "completed") {
        setStatusBadge("passed ✓", "agent-status-ok");
        endPolling();
        setRunningUI(false);
      } else if (snap.status === "failed") {
        setStatusBadge("failed", "agent-status-err");
        endPolling();
        setRunningUI(false);
      } else if (snap.status === "stopped") {
        setStatusBadge("stopped", "agent-status-warn");
        endPolling();
        setRunningUI(false);
      } else {
        setStatusBadge(snap.status || "running", "agent-status-run");
      }
    } catch (err) {
      // Keep polling; one-off errors shouldn't kill the UI.
      console.warn("agent poll failed:", err);
    }
  }

  // --------------- panel open/close ---------------
  function openPanel() {
    const panel = $("agentPanel");
    if (!panel) return;
    panel.classList.remove("hidden");
    loadSettings();
    // Clear stale "needs goal" badge when user reopens after a previous run.
    if (!state.running) setStatusBadge("idle", "");
  }

  function closePanel() {
    const panel = $("agentPanel");
    if (panel) panel.classList.add("hidden");
  }

  // --------------- wire up ---------------
  function bind() {
    $("agentOpenBtn")?.addEventListener("click", openPanel);
    $("agentCloseBtn")?.addEventListener("click", closePanel);
    $("agentStartBtn")?.addEventListener("click", startSession);
    $("agentStopBtn")?.addEventListener("click", stopSession);
    $("agentSettingsBtn")?.addEventListener("click", openSettingsModal);
    $("agentSettingsClose")?.addEventListener("click", closeSettingsModal);
    $("agentSettingsCancel")?.addEventListener("click", closeSettingsModal);
    $("agentSettingsSave")?.addEventListener("click", saveSettings);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const overlay = $("agentSettingsOverlay");
        if (overlay && !overlay.classList.contains("hidden")) {
          closeSettingsModal();
          e.preventDefault();
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
