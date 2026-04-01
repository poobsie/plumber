const state = {
  approvals: {},
  builds: [],
  choiceRequests: {},
  reviews: [],
  status: null,
  tasks: [],
  tools: [],
  valueRequests: {},
};

let _activeReviewId = null;

const expandedTasks = new Set();
let completedOpen = false;

// Approval mode cache - survives for the page session only
const _approvedKeys = new Set();

function stableStringify(v) {
  if (typeof v !== "object" || v === null) return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

// --- SSE ---

let sse, reconnectTimer;

function notify(title, body) {
  if (Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.ico" });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then((p) => {
      if (p === "granted") new Notification(title, { body, icon: "/favicon.ico" });
    });
  }
}

function connect() {
  if (sse) sse.close();
  sse = new EventSource("/events");
  sse.onopen = () => {
    document.getElementById("conn-dot").className = "connected";
    clearTimeout(reconnectTimer);
  };
  sse.onerror = () => {
    document.getElementById("conn-dot").className = "error";
    sse.close();
    reconnectTimer = setTimeout(connect, 3000);
  };
  sse.onmessage = (e) => handle(JSON.parse(e.data));
}

function handle(msg) {
  switch (msg.type) {
    case "init":
      state.builds = msg.builds || [];
      state.reviews = msg.reviews || [];
      state.tasks = msg.tasks || [];
      state.tools = msg.tools || [];
      if (msg.status_feed && msg.status_feed.length) state.status = msg.status_feed[0];
      (msg.pending_approvals || []).forEach((a) => {
        state.approvals[a.id] = { action: a.action, context: a.context, expiresAt: a.expires_at };
      });
      (msg.pending_value_requests || []).forEach((v) => {
        state.valueRequests[v.id] = { prompt: v.prompt, task_id: v.task_id, expiresAt: v.expires_at };
      });
      (msg.pending_choice_requests || []).forEach((c) => {
        state.choiceRequests[c.id] = { prompt: c.prompt, options: c.options, task_id: c.task_id, expiresAt: c.expires_at };
      });
      renderAll();
      break;
    case "approval_requested": {
      state.approvals[msg.id] = { action: msg.action, context: msg.context, expiresAt: msg.expires_at };
      const _mode = getSettings().approvalMode || "always";
      if (_mode === "allow-all") {
        respond(msg.id, true);
      } else if (_mode === "auto-match" && _approvedKeys.has(msg.action + ":" + stableStringify(msg.context))) {
        respond(msg.id, true);
      } else {
        renderApprovals();
        notify("Approval required", msg.action + (msg.context?.branch ? ` \u2192 ${msg.context.branch}` : ""));
      }
      break;
    }
    case "approval_resolved":
    case "approval_expired":
      delete state.approvals[msg.id];
      renderApprovals();
      break;
    case "value_requested":
      state.valueRequests[msg.id] = { prompt: msg.prompt, task_id: msg.task_id, expiresAt: msg.expires_at };
      renderApprovals();
      notify("Input required", msg.prompt);
      break;
    case "value_resolved":
    case "value_expired":
      delete state.valueRequests[msg.id];
      renderApprovals();
      break;
    case "choice_requested":
      state.choiceRequests[msg.id] = { prompt: msg.prompt, options: msg.options, task_id: msg.task_id, expiresAt: msg.expires_at };
      renderApprovals();
      notify("Choice required", msg.prompt);
      break;
    case "choice_resolved":
    case "choice_expired":
      delete state.choiceRequests[msg.id];
      renderApprovals();
      break;
    case "status_update":
      state.status = { summary: msg.summary, pct: msg.pct, timestamp: msg.timestamp, task_id: msg.task_id };
      renderStatus();
      renderTasks();
      break;
    case "status_cleared":
      state.status = null;
      renderStatus();
      renderTasks();
      break;
    case "build_updated": {
      const i = state.builds.findIndex((b) => b.job === msg.job && b.build_number === msg.build_number);
      if (i >= 0) state.builds[i] = msg;
      else state.builds.unshift(msg);
      state.builds = state.builds.slice(0, 50);
      renderTasks();
      break;
    }
    case "task_updated": {
      const i = state.tasks.findIndex((t) => t.id === msg.id);
      if (i >= 0) state.tasks[i] = msg;
      else state.tasks.unshift(msg);
      renderTasks();
      break;
    }
    case "task_deleted":
      state.tasks = state.tasks.filter((t) => t.id !== msg.id);
      renderTasks();
      break;
    case "tool_updated": {
      const i = state.tools.findIndex((t) => t.id === msg.id);
      if (i >= 0) state.tools[i] = msg;
      else state.tools.push(msg);
      renderTools();
      break;
    }
    case "tool_deleted":
      state.tools = state.tools.filter((t) => t.id !== msg.id);
      renderTools();
      break;
    case "review_updated": {
      const i = state.reviews.findIndex((r) => r.id === msg.id);
      if (i >= 0) state.reviews[i] = msg;
      else state.reviews.unshift(msg);
      renderReviews();
      if (_activeReviewId === msg.id) _renderReviewPanel(msg);
      break;
    }
    case "review_deleted":
      state.reviews = state.reviews.filter((r) => r.id !== msg.id);
      if (_activeReviewId === msg.id) closeReviewPanel();
      renderReviews();
      break;
  }
}

function renderAll() {
  renderApprovals();
  renderStatus();
  renderTasks();
  renderTools();
  renderReviews();
}

// --- Settings ---

const SETTINGS_KEY = "plumber_settings";

function getSettings() {
  try {
    const v = localStorage.getItem(SETTINGS_KEY);
    if (!v) {
      const old = localStorage.getItem("plumber_settings");
      if (old) { localStorage.setItem(SETTINGS_KEY, old); localStorage.removeItem("plumber_settings"); return JSON.parse(old) || {}; }
    }
    return JSON.parse(v) || {};
  } catch { return {}; }
}

function openSettings() {
  const s = getSettings();
  document.getElementById("s-pipeline-repo").value = s.defaultPipelineRepo || "";
  document.getElementById("s-jira-host").value = s.jiraHost || "";
  document.getElementById("s-approval-mode").value = s.approvalMode || "always";
  document.getElementById("s-webex-token").value = s.webexToken || "";
  document.getElementById("s-webex-room").value = s.webexRoom || "";
  document.getElementById("settings-modal").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settings-modal").classList.add("hidden");
}

function saveSettings() {
  const settings = {
    defaultPipelineRepo: document.getElementById("s-pipeline-repo").value.trim(),
    jiraHost: document.getElementById("s-jira-host").value.trim(),
    approvalMode: document.getElementById("s-approval-mode").value,
    webexToken: document.getElementById("s-webex-token").value.trim(),
    webexRoom: document.getElementById("s-webex-room").value.trim(),
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (settings.webexToken && settings.webexRoom) {
    fetch("/webex/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: settings.webexToken, room: settings.webexRoom }),
    }).catch(() => {});
  }
  closeSettings();
}

function clearApprovedKeys() {
  _approvedKeys.clear();
  notify("Cleared", "Remembered approvals cleared.");
}

// --- Edit modal ---

let editModal = null;

function openEditModal(cfg) {
  // cfg: { title, fields, onSave }
  editModal = cfg;
  const modal = document.getElementById("edit-modal");
  document.getElementById("edit-modal-title").textContent = cfg.title;
  const body = document.getElementById("edit-modal-body");
  body.innerHTML = cfg.fields.map((f) => {
    if (f.type === "textarea") {
      return `<div class="field"><label>${esc(f.label)}</label><textarea id="em-${esc(f.id)}" rows="3">${esc(f.value || "")}</textarea></div>`;
    }
    if (f.type === "select") {
      const opts = f.options.map((o) => `<option value="${esc(o.value)}"${o.value === f.value ? " selected" : ""}>${esc(o.label)}</option>`).join("");
      return `<div class="field"><label>${esc(f.label)}</label><select id="em-${esc(f.id)}">${opts}</select></div>`;
    }
    return `<div class="field"><label>${esc(f.label)}</label><input id="em-${esc(f.id)}" type="text" value="${esc(f.value || "")}"></div>`;
  }).join("");
  modal.classList.remove("hidden");
  const first = body.querySelector("input,textarea,select");
  if (first) first.focus();
}

function closeEditModal() {
  document.getElementById("edit-modal").classList.add("hidden");
  editModal = null;
}

async function saveEditModal() {
  if (!editModal) return;
  const values = {};
  editModal.fields.forEach((f) => {
    const el = document.getElementById(`em-${f.id}`);
    if (el) values[f.id] = el.value;
  });
  await editModal.onSave(values);
  closeEditModal();
}

// --- Tab switching ---

let activeTab = "tasks";

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll(".tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((el) => {
    el.classList.toggle("active", el.id === `panel-${name}`);
  });
}

// --- Tools ---

let currentToolInfo = null;
let _allJobs = [];

function openToolModal() {
  loadToolJobs();
  const s = getSettings();
  const field = document.getElementById("tf-pipeline-repo");
  if (s.defaultPipelineRepo && !field.value) field.value = s.defaultPipelineRepo;
  document.getElementById("tool-modal").classList.remove("hidden");
}

function closeToolModal() {
  document.getElementById("tool-modal").classList.add("hidden");
}

// keep old name for legacy calls
function toggleToolForm() { openToolModal(); }

async function loadToolJobs() {
  const input = document.getElementById("tf-job");
  const dl = document.getElementById("tf-job-datalist");
  input.placeholder = "Loading...";
  input.disabled = true;
  try {
    _allJobs = await fetch("/jenkins/jobs").then((r) => r.json());
    dl.innerHTML = _allJobs.map((j) => `<option value="${esc(j)}"></option>`).join("");
    input.placeholder = _allJobs.length ? "Type to search jobs..." : "No jobs found";
    input.disabled = false;
  } catch {
    input.placeholder = "Failed to load jobs";
    input.disabled = false;
  }
}

function onJobInput() {
  const val = document.getElementById("tf-job").value.trim();
  if (_allJobs.includes(val)) {
    onToolJobSelect(val);
  } else {
    currentToolInfo = null;
    const hint = document.getElementById("tf-multibranch-hint");
    if (hint) hint.classList.add("hidden");
  }
}

async function onToolJobSelect(job) {
  currentToolInfo = null;
  try {
    const info = await fetch(`/jenkins/job/${job}/info`).then((r) => r.json());
    currentToolInfo = info;
    const hint = document.getElementById("tf-multibranch-hint");
    if (hint) hint.classList.toggle("hidden", !info.is_multibranch);
  } catch {}
}

function updateToolForm() {
  const loc = document.querySelector('input[name="tf-pipeline-loc"]:checked')?.value;
  const repoField = document.getElementById("tf-pipeline-repo-field");
  const jenkinsFields = document.getElementById("tf-jenkins-fields");
  const jobInput = document.getElementById("tf-job");
  if (repoField) repoField.style.display = loc === "pipeline_repo" ? "" : "none";
  if (jenkinsFields) jenkinsFields.style.display = loc === "none" ? "none" : "";
  if (jobInput) jobInput.required = loc !== "none";
}

async function submitTool(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById("tf-name").value.trim(),
    code_repo: document.getElementById("tf-code-repo").value.trim(),
    jenkins_job: document.getElementById("tf-job").value.trim(),
    pipeline_location: document.querySelector('input[name="tf-pipeline-loc"]:checked')?.value || "pipeline_repo",
    pipeline_repo: document.getElementById("tf-pipeline-repo").value.trim(),
    base_branch: document.getElementById("tf-base-branch").value.trim() || "pre_production",
    is_multibranch: currentToolInfo?.is_multibranch || false,
  };
  await fetch("/tools", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  e.target.reset();
  updateToolForm();
  currentToolInfo = null;
  closeToolModal();
}

async function deleteTool(id) {
  await fetch(`/tools/${id}`, { method: "DELETE" });
}

function editTool(id) {
  const t = state.tools.find((t) => t.id === id);
  if (!t) return;
  openEditModal({
    title: "Edit tool",
    fields: [
      { id: "name",       label: "Tool name",       value: t.name },
      { id: "code_repo",  label: "Code repo URL",   value: t.code_repo },
      { id: "pipeline_location", label: "Pipeline location", type: "select", value: t.pipeline_location,
        options: [
          { value: "pipeline_repo", label: "Separate pipeline repo" },
          { value: "tool_repo",     label: "Jenkinsfile in code repo" },
          { value: "jenkins",       label: "Stored in Jenkins" },
          { value: "none",          label: "None (local testing)" },
        ]
      },
      { id: "pipeline_repo", label: "Pipeline repo URL", value: t.pipeline_repo },
      { id: "jenkins_job",  label: "Jenkins job",    value: t.jenkins_job },
      { id: "base_branch",  label: "Base branch",    value: t.base_branch || "pre_production" },
    ],
    onSave: async (v) => {
      await fetch(`/tools/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
    },
  });
}

function pipelineLocationLabel(loc) {
  return { pipeline_repo: "separate repo", tool_repo: "code repo", jenkins: "in Jenkins", none: "local testing" }[loc] || loc;
}

function renderTools() {
  const grid = document.getElementById("tools-grid");
  const countEl = document.getElementById("tools-count");
  countEl.textContent = state.tools.length;
  countEl.className = state.tools.length ? "badge badge-muted" : "badge badge-muted zero";
  if (!state.tools.length) {
    grid.innerHTML = '<span class="empty">No tools configured. Click "+ Add tool" to get started.</span>';
    return;
  }
  grid.innerHTML = state.tools.map((t) => `
    <div class="tool-card">
      <div class="tool-card-hdr">
        <span class="tool-card-dot"></span>
        <span class="tool-card-name" title="${esc(t.name)}">${esc(t.name)}</span>
      </div>
      <div class="tool-card-body">
        ${t.jenkins_job ? `<div class="tool-card-row"><span class="tool-card-key">job</span><span class="tool-card-val" title="${esc(t.jenkins_job)}">${esc(t.jenkins_job)}</span></div>` : ""}
        <div class="tool-card-row"><span class="tool-card-key">code</span><span class="tool-card-val" title="${esc(t.code_repo)}">${esc(t.code_repo.replace(/^https?:\/\//, ""))}</span></div>
        <div class="tool-card-row"><span class="tool-card-key">pipeline</span><span class="tool-card-val">${pipelineLocationLabel(t.pipeline_location)}</span></div>
        <div class="tool-card-row"><span class="tool-card-key">base</span><span class="tool-card-val">${esc(t.base_branch || "pre_production")}</span></div>
      </div>
      <div class="tool-card-footer">
        <button class="btn-row" title="Edit" onclick="editTool('${esc(t.id)}')">&#9998;</button>
        <button class="btn-row danger" title="Delete" onclick="deleteTool('${esc(t.id)}')">&#10005;</button>
      </div>
    </div>`).join("");
}

// --- Expand stub into full task ---

function expandStub(id) {
  const t = state.tasks.find((t) => t.id === id);
  if (!t) return;
  openTaskModal();
  if (t.name) document.getElementById("f-name").value = t.name;
  if (t.jira_us) document.getElementById("f-jira").value = t.jira_us;
  const modal = document.getElementById("task-modal");
  modal.dataset.stubId = id;
  document.getElementById("f-name").focus();
}

function editStub(id) {
  const t = state.tasks.find((t) => t.id === id);
  if (!t) return;
  openEditModal({
    title: "Edit stub",
    fields: [
      { id: "name",    label: "Name",    value: t.name },
      { id: "jira_us", label: "Jira US", value: t.jira_us },
    ],
    onSave: async (v) => {
      await fetch(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: v.name, jira_us: v.jira_us }),
      });
    },
  });
}

function editTask(id) {
  const t = state.tasks.find((t) => t.id === id);
  if (!t) return;
  const toolOpts = [{ value: "", label: "(keep current)" }].concat(
    state.tools.map((tl) => ({ value: tl.id, label: tl.name }))
  );
  openEditModal({
    title: "Edit task",
    fields: [
      { id: "name",        label: "Name",        value: t.name },
      { id: "branch",      label: "Branch",      value: t.branch },
      { id: "jira_us",     label: "Jira US",     value: t.jira_us },
      { id: "description", label: "Description", type: "textarea", value: t.description },
    ],
    onSave: async (v) => {
      await fetch(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
    },
  });
}

// --- Stub modal ---

function openStubModal() {
  document.getElementById("stub-modal").classList.remove("hidden");
  setTimeout(() => document.getElementById("stub-jira").focus(), 50);
}

function closeStubModal() {
  document.getElementById("stub-modal").classList.add("hidden");
}

// keep old name for legacy calls
function toggleStubForm() { openStubModal(); }

async function submitStub() {
  const jira = document.getElementById("stub-jira").value.trim();
  const name = document.getElementById("stub-name").value.trim() || jira;
  if (!jira && !name) return;
  await fetch("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, jira_us: jira }),
  });
  document.getElementById("stub-jira").value = "";
  document.getElementById("stub-name").value = "";
  closeStubModal();
}

// --- Full task modal ---

let paramCount = 0;
let currentJobInfo = null;

function openTaskModal() {
  populateToolSelect();
  document.getElementById("task-modal").classList.remove("hidden");
  document.getElementById("task-modal-title").textContent = "New task";
  setTimeout(() => document.getElementById("f-name").focus(), 50);
}

function closeTaskModal() {
  const modal = document.getElementById("task-modal");
  modal.classList.add("hidden");
  delete modal.dataset.stubId;
}

// keep old name for legacy calls
function toggleForm() { openTaskModal(); }

function populateToolSelect() {
  const sel = document.getElementById("f-tool");
  if (!state.tools.length) {
    sel.innerHTML = '<option value="">No tools configured</option>';
    return;
  }
  const current = sel.value;
  sel.innerHTML = '<option value="">Select tool...</option>' +
    state.tools.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  if (current) sel.value = current;
}

async function onToolSelect() {
  const sel = document.getElementById("f-tool");
  const tool = state.tools.find((t) => t.id === sel.value);
  currentJobInfo = null;
  document.getElementById("multibranch-hint").classList.add("hidden");
  document.getElementById("params-label-extra").textContent = "";
  document.getElementById("params-list").innerHTML = "";
  if (!tool) return;
  if (tool.pipeline_location === "none") {
    document.getElementById("params-label-extra").textContent = "(local testing - no pipeline)";
    return;
  }
  if (tool.is_multibranch) document.getElementById("multibranch-hint").classList.remove("hidden");
  document.getElementById("params-label-extra").textContent = "(loading...)";
  // For multibranch pipelines, the parent job has no param definitions - they live on branch jobs.
  // Query the base branch to get the real param set.
  const jobPath = tool.is_multibranch
    ? `${tool.jenkins_job}/${tool.base_branch || "pre_production"}`
    : tool.jenkins_job;
  try {
    const info = await fetch(`/jenkins/job/${jobPath}/info`).then((r) => r.json());
    currentJobInfo = info;
    document.getElementById("params-label-extra").textContent = info.params.length ? `(${info.params.length} from Jenkins)` : "";
    populateParams(info.params);
  } catch {
    document.getElementById("params-label-extra").textContent = "(could not load)";
  }
}

function populateParams(params) {
  const list = document.getElementById("params-list");
  list.innerHTML = "";
  params.forEach((p) => {
    const row = document.createElement("div");
    row.className = "param-row";
    row.innerHTML = `
      <input type="text" class="param-key" value="${esc(p.name)}" readonly title="${esc(p.description)}">
      <input type="text" class="param-val" value="${esc(p.default)}" placeholder="value">
      <button type="button" class="rm-btn" onclick="this.closest('.param-row').remove()">&#10005;</button>`;
    list.appendChild(row);
  });
}

function addParam() {
  const list = document.getElementById("params-list");
  const row = document.createElement("div");
  row.className = "param-row";
  row.innerHTML = `
    <input type="text" placeholder="key" class="param-key">
    <input type="text" placeholder="value" class="param-val">
    <button type="button" class="rm-btn" onclick="this.closest('.param-row').remove()">&#10005;</button>`;
  list.appendChild(row);
  paramCount++;
}

function getParams() {
  const params = {};
  document.querySelectorAll("#params-list .param-row").forEach((row) => {
    const k = row.querySelector(".param-key").value.trim();
    const v = row.querySelector(".param-val").value.trim();
    if (k) params[k] = v;
  });
  return params;
}

async function submitTask(e) {
  e.preventDefault();
  const name = document.getElementById("f-name").value.trim();
  const body = {
    name,
    branch: name,
    tool_id: document.getElementById("f-tool").value,
    description: document.getElementById("f-desc").value.trim(),
    jira_us: document.getElementById("f-jira").value.trim(),
    static_params: getParams(),
  };
  const task = await fetch("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  // If expanding a stub, delete it
  const modal = document.getElementById("task-modal");
  const stubId = modal.dataset.stubId;
  if (stubId) {
    delete modal.dataset.stubId;
    await fetch(`/tasks/${stubId}`, { method: "DELETE" });
  }

  e.target.reset();
  document.getElementById("params-list").innerHTML = "";
  document.getElementById("multibranch-hint").classList.add("hidden");
  document.getElementById("params-label-extra").textContent = "";
  currentJobInfo = null;
  closeTaskModal();
  showPrompt(task);
}

// --- Task list ---

function toggleTaskExpand(id) {
  if (expandedTasks.has(id)) expandedTasks.delete(id);
  else expandedTasks.add(id);
  renderTasks();
}

async function completeTask(id) {
  await fetch(`/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
}

function toggleCompleted() {
  completedOpen = !completedOpen;
  const list = document.getElementById("completed-list");
  const chevron = document.getElementById("completed-chevron");
  list.classList.toggle("hidden", !completedOpen);
  chevron.classList.toggle("open", completedOpen);
}

function renderTasks() {
  const filterEl = document.getElementById("task-filter");
  const filter = filterEl ? filterEl.value.toLowerCase().trim() : "";

  const allActive = state.tasks.filter((t) => !t.completed);
  const completed = state.tasks.filter((t) => t.completed);

  const active = filter
    ? allActive.filter((t) =>
        (t.name || "").toLowerCase().includes(filter) ||
        (t.jira_us || "").toLowerCase().includes(filter) ||
        (t.description || "").toLowerCase().includes(filter)
      )
    : allActive;

  const countEl = document.getElementById("task-count");
  countEl.textContent = allActive.length;
  countEl.className = allActive.length ? "badge badge-muted" : "badge badge-muted zero";

  const list = document.getElementById("tasks-list");
  list.innerHTML = active.length
    ? active.map((t) => renderTaskRow(t, false)).join("")
    : '<span class="empty">No active tasks</span>';

  const completedSection = document.getElementById("completed-section");
  const completedCount = document.getElementById("completed-count");
  completedCount.textContent = completed.length;
  if (!completed.length) {
    completedSection.classList.add("hidden");
  } else {
    completedSection.classList.remove("hidden");
    document.getElementById("completed-list").innerHTML = completed.map((t) => renderTaskRow(t, true)).join("");
  }
}

function renderTaskRow(t, inCompleted) {
  const s = state.status;
  const active = s && s.task_id === t.id;
  const isStub = !t.tool_id;
  const tool = state.tools.find((tl) => tl.id === t.tool_id);
  const expanded = expandedTasks.has(t.id);

  let indicatorColor = "var(--muted)";
  if (active) indicatorColor = "var(--orange)";
  else if (t.pr_url) indicatorColor = "var(--green)";
  else if (!isStub) indicatorColor = "var(--blue)";

  const cfg = getSettings();
  const jiraHost = (cfg.jiraHost || "").replace(/\/$/, "");
  const jiraHtml = t.jira_us
    ? (jiraHost
        ? `<a href="${jiraHost}/browse/${encodeURIComponent(t.jira_us)}" target="_blank" rel="noopener" class="tag tag-jira">${esc(t.jira_us)}</a>`
        : `<span class="tag tag-jira">${esc(t.jira_us)}</span>`)
    : "";
  const prHtml = t.pr_url
    ? `<a href="${esc(t.pr_url)}" target="_blank" rel="noopener" class="tag tag-pr">PR #${esc(String(t.pr_number || "?"))}</a>`
    : "";

  // Last build status for this task
  let rightStatus = "";
  if (active) {
    rightStatus = `<span class="status-pill pill-running">${s.pct}%</span>`;
  } else if (t.jenkins_job) {
    const b = state.builds.find((b) => b.job === t.jenkins_job);
    if (b) {
      const bs = (b.status || "unknown").toLowerCase();
      rightStatus = `<span class="status-pill pill-${esc(bs)}">#${b.build_number}</span>`;
    }
  }

  const toolLabel = tool
    ? `<span class="row-tool">${esc(tool.name)}</span>`
    : (isStub ? '<span class="row-tool" style="font-style:italic">no tool</span>' : `<span class="row-tool">${esc(t.jenkins_job || "")}</span>`);

  const branchLabel = !isStub && t.branch && t.branch !== t.name
    ? `<span class="row-meta">${esc(t.branch)}</span>`
    : "";

  // Expand chevron (only when there's expandable content)
  const hasExpand = !isStub && (t.jenkins_job || t.description);
  const chevronHtml = hasExpand
    ? `<span class="chevron ${expanded ? "open" : ""}" style="margin-left:4px;font-size:9px">&#8964;</span>`
    : "";

  const actions = inCompleted
    ? `<button class="btn-row danger" title="Delete" onclick="event.stopPropagation();deleteTask('${esc(t.id)}')">&#10005;</button>`
    : `${isStub
        ? `<button class="btn-row primary" title="Expand to full task" onclick="event.stopPropagation();expandStub('${esc(t.id)}')" style="font-size:14px;font-weight:700">&#8599;</button>
           <button class="btn-row" title="Edit stub" onclick="event.stopPropagation();editStub('${esc(t.id)}')" style="font-size:13px">&#9998;</button>`
        : `<button class="btn-row primary" title="Start" onclick="event.stopPropagation();showPromptById('${esc(t.id)}')">&#9654;</button>
           <button class="btn-row" title="Edit task" onclick="event.stopPropagation();editTask('${esc(t.id)}')" style="font-size:13px">&#9998;</button>`
      }
       <button class="btn-row success" title="Mark complete" onclick="event.stopPropagation();completeTask('${esc(t.id)}')">&#10003;</button>
       <button class="btn-row danger" title="Delete" onclick="event.stopPropagation();deleteTask('${esc(t.id)}')">&#10005;</button>`;

  const rowHtml = `
    <div class="row${hasExpand ? " clickable" : ""}" onclick="${hasExpand ? `toggleTaskExpand('${esc(t.id)}')` : ""}">
      <span class="row-indicator" style="background:${indicatorColor}"></span>
      <span class="row-name${isStub ? " stub" : ""}">${esc(t.name || t.jira_us || "Unnamed")}${chevronHtml}</span>
      ${jiraHtml}${prHtml}
      ${toolLabel}
      ${branchLabel}
      <div style="flex:1"></div>
      ${rightStatus}
      <div class="row-actions">${actions}</div>
    </div>`;

  const inlineStatusHtml = active ? `
    <div class="task-inline-status">
      <span class="is-summary">${esc(s.summary)}</span>
      <div class="is-track"><div class="is-fill" style="width:${Math.max(0, Math.min(100, s.pct))}%"></div></div>
      <span class="is-pct">${s.pct}%</span>
      <button class="btn-row danger" style="width:22px;height:22px;font-size:10px" title="Kill" onclick="killStatus()">&#9632;</button>
    </div>` : "";

  let expandContent = "";
  if (expanded) {
    if (t.description) {
      expandContent += `<div class="task-desc">${esc(t.description)}</div>`;
    }
    if (t.jenkins_job) {
      const taskBuilds = state.builds.filter((b) => b.job === t.jenkins_job).slice(0, 5);
      if (taskBuilds.length) {
        expandContent += `<div class="sub-rows">${taskBuilds.map((b) => {
          const bs = (b.status || "unknown").toLowerCase();
          return `<div class="sub-row" data-build="${b.build_number}">
            <span class="status-pill pill-${esc(bs)}">${bs.toUpperCase()}</span>
            <span style="font-family:monospace">#${b.build_number}</span>
            <span>${relTime(b.timestamp)}</span>
            <button class="sub-row-logs-btn" onclick="toggleBuildLog(event,'${esc(b.job)}',${b.build_number},this)">logs</button>
          </div>
          <div class="log-block hidden">
            <pre class="log-pre"></pre>
          </div>`;
        }).join("")}</div>`;
      }
    }
  }

  return rowHtml + inlineStatusHtml + expandContent;
}

// --- Build logs ---

function toggleBuildLog(e, job, buildNumber, btn) {
  e.stopPropagation();
  const subRow = btn.closest(".sub-row");
  const logBlock = subRow.nextElementSibling;
  if (!logBlock || !logBlock.classList.contains("log-block")) return;
  const hidden = logBlock.classList.toggle("hidden");
  if (!hidden && !logBlock.querySelector(".log-pre").textContent) {
    loadBuildLogs(job, buildNumber, logBlock.querySelector(".log-pre"), btn);
  }
}

async function loadBuildLogs(job, buildNumber, pre, btn) {
  const orig = btn.textContent;
  btn.textContent = "loading...";
  btn.disabled = true;
  try {
    const r = await fetch(`/proxy/logs/${encodeURIComponent(job)}/${buildNumber}`);
    const d = await r.json();
    pre.textContent = d.logs;
  } catch {
    pre.textContent = "Failed to load logs";
  }
  btn.textContent = orig;
  btn.disabled = false;
}

// --- Prompt modal ---

function showPromptById(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (task) showPrompt(task);
}

function showPrompt(taskOrId) {
  const task = typeof taskOrId === "string"
    ? state.tasks.find((t) => t.id === taskOrId)
    : taskOrId;
  if (!task) return;

  const params = Object.entries(task.static_params || {})
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n") || "  (none)";

  const baseBranch = task.base_branch || "pre_production";
  const branchNote = `- After cloning, immediately check whether branch '${task.branch}' already exists on the remote: run \`git fetch origin\` then \`git branch -r\` and look for origin/${task.branch}. If it exists, check it out with \`git checkout ${task.branch}\` (do NOT call git_create_branch - the branch is already there). If it does not exist, then call git_create_branch. Never start investigating the codebase until you are on the correct branch.`;

  if (task.pipeline_location === "none") {
    const prompt = `Task: ${task.name}

Code repo:   ${task.code_repo}
Branch:      ${task.branch}
Base branch: ${baseBranch}

Problem:
${task.description}

Pipeline params:
${params}

Instructions:
- Call post_status('${task.id}', 'your summary', percent) with your initial plan before making any changes.
- Clone the repo: git_clone('${task.id}', 'code') - returns the local path, checks out ${baseBranch}
${branchNote}
- Make the required changes.
- Run tests locally to verify. Check the repo for the test framework and run commands (e.g. pytest, npm test, cargo test). If you cannot determine the test command, call request_value('${task.id}', 'what command should be used to run the tests?') to ask via the dashboard.
- If a secret or credential is needed, call request_value('${task.id}', 'description of what is needed') to prompt via the dashboard.
- Use git_push (not raw git) to push the branch - approval required.
- NEVER push or merge into ${baseBranch}. Once verified, use open_pr to create a draft PR.${task.jira_us ? `\n- PR title must be "${task.jira_us}: Brief description" - the jira number prefix is required.` : ""}
- open_pr(task_id, repo, base, head, title, body): repo in "owner/repo" format, base="${baseBranch}".
- Call post_status('${task.id}', 'summary', percent) after each significant step with an honest % estimate.
- If a push is rejected, stop and explain what you intended and why.`;
    document.getElementById("prompt-text").textContent = prompt;
    document.getElementById("prompt-modal").classList.remove("hidden");
    return;
  }

  const pipelineLines = {
    pipeline_repo: `Pipeline repo: ${task.pipeline_repo}`,
    tool_repo:     `Pipeline:      Jenkinsfile in code repo`,
    jenkins:       `Pipeline:      Stored in Jenkins`,
  };
  const pipelineLine = pipelineLines[task.pipeline_location] || `Pipeline repo: ${task.pipeline_repo}`;
  const multibranch = task.is_multibranch
    ? `\nMultibranch pipeline: branch '${task.branch}' determines which pipeline branch runs (job path: ${task.jenkins_job})\n`
    : "";
  const needsPipelineClone = task.pipeline_location === "pipeline_repo";
  const cloneSteps = needsPipelineClone
    ? `- git_clone('${task.id}', 'code') - clones code repo, checks out ${baseBranch}\n- git_clone('${task.id}', 'pipeline') - clones pipeline repo, checks out ${baseBranch}`
    : `- git_clone('${task.id}', 'code') - clones code repo, checks out ${baseBranch}`;
  const gitNote = needsPipelineClone
    ? `${branchNote}\n- Both repos need a branch pushed before you trigger Jenkins - Jenkins reads the Jenkinsfile from the pipeline repo branch, so pushing only the code branch will run the old pipeline.\n- Push order: pipeline repo first, then code repo, then trigger.\n- Use git_push (not raw git) to push each branch - approval required for each.`
    : `${branchNote}\n- Use git_push (not raw git) to push the branch - approval required.`;

  const prompt = `Task: ${task.name}

Code repo:     ${task.code_repo}
${pipelineLine}
Jenkins job:   ${task.jenkins_job}
Branch:        ${task.branch}
Base branch:   ${baseBranch}
${multibranch}
Problem:
${task.description}

Pipeline params:
${params}

Instructions:
- Call post_status('${task.id}', 'your summary', percent) with your initial plan before making any changes.
- Clone repos first (git_clone returns the local path to pass to other tools):
${cloneSteps}
${gitNote}
- NEVER push or merge into ${baseBranch}. When the fix is verified by logs, use open_pr to create a draft PR.${task.jira_us ? `\n- PR title must be "${task.jira_us}: Brief description" - the jira number prefix is required.` : ""}
- open_pr(task_id, repo, base, head, title, body): repo in "owner/repo" format, base="${baseBranch}".
- Use jenkins_trigger (not curl/HTTP) to run the pipeline - approval required.
- BEFORE calling jenkins_trigger you MUST call jenkins_get_params on the job to retrieve the full
  parameter list. Go through each parameter, determine the correct value, request any credentials
  via request_value, and assemble the complete params dict. Never trigger with an incomplete or
  assumed parameter set.
- When setting pipeline parameters, do NOT enable any parameter that publishes, archives, or uploads build artifacts. If unsure what a parameter does, leave it at its default value.
- If a pipeline parameter requires a secret or credential (token, password, key), do NOT guess or hardcode it. Call request_value('${task.id}', 'description of what is needed') to prompt the user for it via the dashboard - the return value is the secret to use.
- For multibranch pipelines: attempt jenkins_trigger directly. Only call jenkins_scan if the
  trigger fails because the branch job does not exist - then wait 15s and retry. Do NOT scan
  proactively after every push.
- After jenkins_trigger, immediately call jenkins_wait - this blocks until the build finishes.
  Do NOT call anything else between jenkins_trigger and jenkins_wait.
- After jenkins_wait returns, call jenkins_logs and verify the output shows the fix worked.
  A SUCCESS result is not enough - read the logs.
- Read logs tail-first. Use jenkins_logs_range only if the error is not in the tail.
- Call post_status('${task.id}', 'summary', percent) after each significant step with an honest % estimate.
- If a push or trigger is rejected, stop and explain what you intended and why.`;

  document.getElementById("prompt-text").textContent = prompt;
  document.getElementById("prompt-modal").classList.remove("hidden");
}

function closePrompt() {
  document.getElementById("prompt-modal").classList.add("hidden");
}

async function copyPrompt() {
  const text = document.getElementById("prompt-text").textContent;
  await navigator.clipboard.writeText(text);
  const flash = document.getElementById("copied-flash");
  flash.classList.add("show");
  setTimeout(() => flash.classList.remove("show"), 1800);
}

async function deleteTask(id) {
  await fetch(`/tasks/${id}`, { method: "DELETE" });
}

["prompt-modal", "settings-modal", "edit-modal", "stub-modal", "task-modal", "tool-modal", "add-pr-modal"].forEach((id) => {
  document.getElementById(id).addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      if (id === "prompt-modal") closePrompt();
      else if (id === "settings-modal") closeSettings();
      else if (id === "edit-modal") closeEditModal();
      else if (id === "stub-modal") closeStubModal();
      else if (id === "task-modal") closeTaskModal();
      else if (id === "tool-modal") closeToolModal();
      else if (id === "add-pr-modal") closeAddPrModal();
    }
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!document.getElementById("add-pr-modal").classList.contains("hidden")) { closeAddPrModal(); return; }
  if (!document.getElementById("review-panel").classList.contains("hidden")) { closeReviewPanel(); return; }
  if (!document.getElementById("prompt-modal").classList.contains("hidden")) { closePrompt(); return; }
  if (!document.getElementById("settings-modal").classList.contains("hidden")) { closeSettings(); return; }
  if (!document.getElementById("edit-modal").classList.contains("hidden")) { closeEditModal(); return; }
  if (!document.getElementById("stub-modal").classList.contains("hidden")) { closeStubModal(); return; }
  if (!document.getElementById("task-modal").classList.contains("hidden")) { closeTaskModal(); return; }
  if (!document.getElementById("tool-modal").classList.contains("hidden")) { closeToolModal(); return; }
});

// --- Approvals ---

function renderPrApproval(id, a) {
  const body = a.context.body || "";
  const rendered = typeof marked !== "undefined" ? marked.parse(body) : `<pre>${esc(body)}</pre>`;
  return `
    <div class="approval-card pr" data-id="${id}">
      <div class="approval-top">
        <span class="action-badge pr">open PR (draft)</span>
        <span class="countdown" data-expires="${a.expiresAt}"></span>
      </div>
      <div class="pr-preview-title">${esc(a.context.title || "")}</div>
      <div class="pr-preview-meta">${esc(a.context.repo)}&nbsp;&nbsp;${esc(a.context.head)} &#8594; ${esc(a.context.base)}</div>
      <div class="pr-preview-body">${rendered}</div>
      <div class="approval-btns">
        <button class="btn btn-approve" onclick="respond('${id}', true)">Approve &amp; Create PR</button>
        <button class="btn btn-reject" onclick="respond('${id}', false)">Reject</button>
      </div>
    </div>`;
}

async function respond(id, approved) {
  document.querySelectorAll(`.approval-card[data-id="${id}"] .btn`).forEach((b) => (b.disabled = true));
  if (approved && (getSettings().approvalMode || "always") === "auto-match") {
    const a = state.approvals[id];
    if (a) _approvedKeys.add(a.action + ":" + stableStringify(a.context));
  }
  await fetch(`/approval/${id}/${approved ? "approve" : "reject"}`, { method: "POST" });
}

function renderApprovals() {
  const drawer = document.getElementById("approvals-drawer");
  const list = document.getElementById("approvals-list");
  const count = document.getElementById("approval-count");
  const label = document.getElementById("approval-label");
  const drawerCount = document.getElementById("drawer-count");
  const approvalEntries = Object.entries(state.approvals);
  const valueEntries = Object.entries(state.valueRequests);
  const choiceEntries = Object.entries(state.choiceRequests);
  const total = approvalEntries.length + valueEntries.length + choiceEntries.length;

  count.textContent = total;
  count.className = total ? "badge" : "badge zero";
  label.classList.toggle("hidden", !total);
  drawerCount.textContent = total;

  if (!total) {
    drawer.classList.add("empty");
    list.innerHTML = "";
    return;
  }

  drawer.classList.remove("empty");
  const approvalHtml = approvalEntries.map(([id, a]) => {
    if (a.action === "open_pr") return renderPrApproval(id, a);
    if (a.action === "jenkins_trigger") return renderJenkinsTriggerApproval(id, a);
    const cls = a.action.startsWith("git") ? "git" : "jenkins";
    const ctxRows = Object.entries(a.context)
      .map(([k, v]) => {
        const val = typeof v === "object" ? JSON.stringify(v) : String(v);
        return `<span class="ctx-key">${esc(k)}</span><span class="ctx-val">${esc(val)}</span>`;
      }).join("");
    return `
      <div class="approval-card ${cls}" data-id="${id}">
        <div class="approval-top">
          <span class="action-badge ${cls}">${esc(a.action.replace(/_/g, " "))}</span>
          <span class="countdown" data-expires="${a.expiresAt}"></span>
        </div>
        <div class="ctx-table">${ctxRows}</div>
        <div class="approval-btns">
          <button class="btn btn-approve" onclick="respond('${id}', true)">Approve</button>
          <button class="btn btn-reject" onclick="respond('${id}', false)">Reject</button>
        </div>
      </div>`;
  }).join("");
  const valueHtml = valueEntries.map(([id, v]) => renderValueRequest(id, v)).join("");
  const choiceHtml = choiceEntries.map(([id, c]) => renderChoiceRequest(id, c)).join("");
  list.innerHTML = approvalHtml + valueHtml + choiceHtml;
}

function renderValueRequest(id, v) {
  return `
    <div class="approval-card git" data-value-id="${id}">
      <div class="approval-top">
        <span class="action-badge git">input required</span>
        <span class="countdown" data-expires="${v.expiresAt}"></span>
      </div>
      <div style="padding:4px 14px 10px;font-size:12px;color:var(--text)">${esc(v.prompt)}</div>
      <div style="padding:0 14px 10px;display:flex;gap:8px;align-items:center">
        <input id="vr-input-${id}" type="password" placeholder="Enter value..." style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;padding:6px 9px;font-family:inherit" onkeydown="if(event.key==='Enter')submitValue('${id}')">
        <button class="btn btn-sm" style="background:none;border:1px solid var(--border);color:var(--muted);cursor:pointer;border-radius:4px;padding:3px 8px;font-size:11px" onclick="toggleValueVisibility('${id}')" title="Show/hide">&#128065;</button>
      </div>
      <div class="approval-btns">
        <button class="btn btn-approve" onclick="submitValue('${id}')">Submit</button>
        <button class="btn btn-reject" onclick="cancelValue('${id}')">Cancel</button>
      </div>
    </div>`;
}

function toggleValueVisibility(id) {
  const inp = document.getElementById(`vr-input-${id}`);
  if (inp) inp.type = inp.type === "password" ? "text" : "password";
}

async function submitValue(id) {
  const inp = document.getElementById(`vr-input-${id}`);
  if (!inp) return;
  const value = inp.value;
  inp.disabled = true;
  await fetch(`/value/${id}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

async function cancelValue(id) {
  await fetch(`/value/${id}/cancel`, { method: "POST" });
}

function renderChoiceRequest(id, c) {
  const btns = c.options.map((opt) =>
    `<button class="btn btn-ghost btn-sm" style="text-align:left" onclick="submitChoice('${id}', ${JSON.stringify(esc(opt))})">${ esc(opt)}</button>`
  ).join("");
  return `
    <div class="approval-card git" data-choice-id="${id}">
      <div class="approval-top">
        <span class="action-badge git">choice required</span>
        <span class="countdown" data-expires="${c.expiresAt}"></span>
      </div>
      <div style="padding:4px 14px 10px;font-size:12px;color:var(--text)">${esc(c.prompt)}</div>
      <div style="padding:0 14px 12px;display:flex;flex-direction:column;gap:6px">${btns}</div>
      <div class="approval-btns">
        <button class="btn btn-reject" onclick="cancelChoice('${id}')">Cancel</button>
      </div>
    </div>`;
}

async function submitChoice(id, value) {
  document.querySelectorAll(`[data-choice-id="${id}"] button`).forEach((b) => (b.disabled = true));
  await fetch(`/choice/${id}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

async function cancelChoice(id) {
  await fetch(`/choice/${id}/cancel`, { method: "POST" });
}

function renderJenkinsTriggerApproval(id, a) {
  const params = a.context.params || {};
  const paramRows = Object.entries(params).length
    ? Object.entries(params).map(([k, v]) =>
        `<span class="ctx-key">${esc(k)}</span><span class="ctx-val">${esc(String(v))}</span>`
      ).join("")
    : `<span class="ctx-key" style="grid-column:1/-1;color:var(--muted)">(no parameters)</span>`;
  return `
    <div class="approval-card jenkins" data-id="${id}">
      <div class="approval-top">
        <span class="action-badge jenkins">jenkins trigger</span>
        <span class="countdown" data-expires="${a.expiresAt}"></span>
      </div>
      <div class="ctx-table">
        <span class="ctx-key">job</span><span class="ctx-val">${esc(a.context.job || "")}</span>
      </div>
      <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;padding:6px 14px 2px">Parameters</div>
      <div class="ctx-table" style="padding:0 14px 10px">${paramRows}</div>
      <div class="approval-btns" style="padding:0 14px 12px">
        <button class="btn btn-approve" onclick="respond('${id}', true)">Approve</button>
        <button class="btn btn-reject" onclick="respond('${id}', false)">Reject</button>
      </div>
    </div>`;
}

// --- Status (header pill) ---

function renderStatus() {
  const pill = document.getElementById("hdr-status");
  if (!state.status || state.status.task_id) {
    pill.classList.remove("visible");
    return;
  }
  const { summary, pct } = state.status;
  pill.classList.add("visible");
  document.getElementById("hdr-status-text").textContent = summary;
  document.getElementById("hdr-status-pct").textContent = `${pct}%`;
}

async function killStatus() {
  await fetch("/status", { method: "DELETE" });
}

// --- Countdown ticks ---

setInterval(() => {
  document.querySelectorAll(".countdown[data-expires]").forEach((el) => {
    const ms = Number(el.dataset.expires) - Date.now();
    if (ms <= 0) { el.textContent = "expired"; el.className = "countdown urgent"; return; }
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    el.textContent = `${m}:${s.toString().padStart(2, "0")}`;
    el.className = ms < 60000 ? "countdown urgent" : "countdown";
  });
}, 1000);

// --- Helpers ---

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function relTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// --- Reviews ---

const STATUS_DOT = { pending: "var(--muted)", reviewing: "var(--orange)", reviewed: "var(--green)" };

function renderReviews() {
  const list = document.getElementById("reviews-list");
  const countEl = document.getElementById("reviews-count");
  countEl.textContent = state.reviews.length;
  countEl.className = state.reviews.length ? "badge badge-muted" : "badge badge-muted zero";
  if (!state.reviews.length) {
    list.innerHTML = '<span class="empty">No reviews. Click "\u271a Add PR" or configure a tool with a code repo to auto-ingest your open PRs.</span>';
    return;
  }
  list.innerHTML = state.reviews.map((r) => {
    const annCount = (r.annotations || []).length;
    const fileCount = (r.changed_files || []).length;
    const tool = state.tools.find((t) => t.id === r.tool_id);
    const dotColor = STATUS_DOT[r.status] || "var(--muted)";

    const tags = [
      r.authored_by_me ? '<span class="tag tag-mine">mine</span>' : '<span class="tag tag-other">theirs</span>',
      r.draft ? '<span class="tag tag-draft">draft</span>' : "",
    ].filter(Boolean).join("");

    // Sub-line: repo#num · tool · N files [· N annotations]
    const subParts = [
      `<span style="font-family:monospace">${esc(r.repo)} <span style="opacity:.6">#${r.pr_number}</span></span>`,
      tool ? `<span>${esc(tool.name)}</span>` : null,
      fileCount ? `<span>${fileCount} file${fileCount !== 1 ? "s" : ""}</span>` : null,
      annCount ? `<span style="color:var(--orange)">${annCount} note${annCount !== 1 ? "s" : ""}</span>` : null,
    ].filter(Boolean).join('<span class="sep">\xb7</span>');

    return `
      <div class="review-card" onclick="openReviewPanel('${esc(r.id)}')">
        <span class="row-indicator" style="background:${dotColor}"></span>
        <div class="review-card-body">
          <div class="review-card-title-row">
            <span class="review-card-title" title="${esc(r.title)}">${esc(r.title)}</span>
            ${tags}
          </div>
          <div class="review-card-sub">${subParts}</div>
        </div>
        <div class="review-card-actions" onclick="event.stopPropagation()">
          <button class="btn-row danger" title="Remove" onclick="deleteReview('${esc(r.id)}')">&#10005;</button>
        </div>
      </div>`;
  }).join("");
}

function openReviewPanel(id) {
  const review = state.reviews.find((r) => r.id === id);
  if (!review) return;
  _activeReviewId = id;
  _activeReviewItem = null; // reset so first item is chosen
  _renderReviewPanel(review);
  document.getElementById("review-panel").classList.remove("hidden");
}

function closeReviewPanel() {
  _activeReviewId = null;
  document.getElementById("review-panel").classList.add("hidden");
}

let _activeReviewItem = null; // "description" | "conversation" | file-index (number)

function _renderReviewPanel(review) {
  document.getElementById("review-panel-title").textContent = review.title;
  document.getElementById("review-panel-meta").textContent = `${review.repo} #${review.pr_number}`;
  document.getElementById("review-panel-status-dot").style.background = STATUS_DOT[review.status] || "var(--muted)";
  document.getElementById("review-panel-gh-link").href = review.pr_url || "#";

  const convertBtn = document.getElementById("review-panel-convert-btn");
  convertBtn.classList.toggle("hidden", !review.authored_by_me || review.status === "pending");

  const annCount = (review.annotations || []).length;
  document.getElementById("review-panel-ann-count").textContent = annCount ? `${annCount} note${annCount !== 1 ? "s" : ""}` : "";

  const files = review.changed_files || [];
  const hasDesc = !!(review.pr_body && review.pr_body.trim());
  const ghReviews = (review.github_reviews || []).filter((rv) => rv.body && rv.body.trim());
  const ghComments = (review.github_comments || []);
  const hasConv = ghReviews.length > 0 || ghComments.length > 0;

  // Build ordered sidebar items
  const items = [];
  if (hasDesc) items.push({ key: "description", label: "Description", icon: "≡" });
  if (hasConv) {
    const convCount = ghReviews.length + ghComments.length;
    items.push({ key: "conversation", label: `Conversation (${convCount})`, icon: "❶".replace("❶", String(convCount)) });
  }
  files.forEach((f, i) => items.push({ key: i, file: f }));

  // Default selection: keep current if still valid, else first item
  const validKeys = items.map((it) => it.key);
  if (!validKeys.includes(_activeReviewItem)) {
    _activeReviewItem = items[0]?.key ?? 0;
  }

  const sidebar = document.getElementById("review-files-list");
  sidebar.innerHTML = items.map((it) => {
    const active = it.key === _activeReviewItem;
    if (it.key === "description" || it.key === "conversation") {
      return `<div class="review-file-item${active ? " active" : ""}" data-ikey="${esc(String(it.key))}" onclick="_showItem('${it.key}')">
        <span class="review-file-status" style="font-style:normal">${it.key === "description" ? "&#9776;" : "&#128172;"}</span>
        <span class="review-file-name" style="font-family:inherit;font-size:11px">${esc(it.label)}</span>
      </div>`;
    }
    const f = it.file;
    const sc = (f.status || "M").charAt(0).toUpperCase();
    const scColor = { A: "var(--green)", D: "var(--red)", R: "var(--purple)" }[sc] || "var(--orange)";
    return `<div class="review-file-item${active ? " active" : ""}" data-ikey="${it.key}" onclick="_showItem(${it.key})" title="${esc(f.filename)}">
      <span class="review-file-status" style="color:${scColor}">${sc}</span>
      <span class="review-file-name">${esc(f.filename)}</span>
    </div>`;
  }).join("") || '<span class="empty" style="padding:12px">No files.</span>';

  _showItem(_activeReviewItem, review);
}

function _showItem(key, reviewOverride) {
  const review = reviewOverride || state.reviews.find((r) => r.id === _activeReviewId);
  if (!review) return;
  _activeReviewItem = key;

  document.querySelectorAll(".review-file-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.ikey === String(key));
  });

  const diffArea = document.getElementById("review-diff-area");

  if (key === "description") {
    const body = review.pr_body || "";
    const rendered = typeof marked !== "undefined" ? marked.parse(body) : `<pre>${esc(body)}</pre>`;
    diffArea.innerHTML = `<div class="pr-prose">${rendered}</div>`;
    return;
  }

  if (key === "conversation") {
    const ghReviews = (review.github_reviews || []).filter((rv) => rv.body && rv.body.trim());
    const ghComments = (review.github_comments || []);
    if (!ghReviews.length && !ghComments.length) {
      diffArea.innerHTML = '<span class="empty">No conversation yet.</span>';
      return;
    }
    const stateLabel = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented", DISMISSED: "Dismissed" };
    const stateColor = { APPROVED: "var(--green)", CHANGES_REQUESTED: "var(--red)", COMMENTED: "var(--muted)", DISMISSED: "var(--muted)" };
    let html = '<div class="pr-prose">';
    ghReviews.forEach((rv) => {
      const label = stateLabel[rv.state] || rv.state;
      const color = stateColor[rv.state] || "var(--muted)";
      const rendered = typeof marked !== "undefined" ? marked.parse(rv.body) : `<pre>${esc(rv.body)}</pre>`;
      html += `<div class="conv-block">
        <div class="conv-hdr"><strong>${esc(rv.user)}</strong><span class="conv-state" style="color:${color}">${esc(label)}</span></div>
        <div class="conv-body">${rendered}</div>
      </div>`;
    });
    // Inline comments grouped by file
    if (ghComments.length) {
      const byFile = {};
      ghComments.forEach((c) => { (byFile[c.path] = byFile[c.path] || []).push(c); });
      Object.entries(byFile).forEach(([path, cs]) => {
        html += `<div class="conv-block">`;
        html += `<div class="conv-hdr" style="font-family:monospace;font-size:11px">${esc(path)}</div>`;
        cs.forEach((c) => {
          html += `<div class="conv-inline"><span class="conv-inline-who">${esc(c.user)}</span>${c.line ? `<span class="conv-inline-line">line ${c.line}</span>` : ""}<div class="conv-inline-body">${esc(c.body)}</div></div>`;
        });
        html += `</div>`;
      });
    }
    html += "</div>";
    diffArea.innerHTML = html;
    return;
  }

  // File diff
  const files = review.changed_files || [];
  const file = files[key];
  if (!file || !file.patch) {
    diffArea.innerHTML = '<span class="empty">No diff available for this file.</span>';
    return;
  }
  const fileAnnotations = (review.annotations || []).filter((a) => a.file_path === file.filename);
  const fileGhComments = (review.github_comments || []).filter((c) => c.path === file.filename);
  diffArea.innerHTML = _renderPatch(file.patch, fileAnnotations, fileGhComments);
}

function _renderPatch(patch, annotations, ghComments) {
  // Build newLine -> callout list map
  const callouts = {};
  (annotations || []).forEach((a) => {
    (callouts[a.line] = callouts[a.line] || []).push({ type: "ann", data: a });
  });
  (ghComments || []).forEach((c) => {
    const ln = c.line || c.original_line;
    if (!ln) return;
    (callouts[ln] = callouts[ln] || []).push({ type: "gh", data: c });
  });

  const rows = [];
  let oldLine = 0, newLine = 0;

  for (const raw of patch.split("\n")) {
    if (!raw) continue;

    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLine = parseInt(m[1]); newLine = parseInt(m[2]); }
      rows.push(`<tr class="diff-hunk-hdr"><td colspan="3">${esc(raw)}</td></tr>`);
      continue;
    }

    const pfx = raw[0];
    const content = raw.slice(1);

    if (pfx === "+") {
      rows.push(`<tr class="diff-add"><td class="diff-ln"></td><td class="diff-ln">${newLine}</td><td class="diff-code"><span class="diff-pfx">+</span>${esc(content)}</td></tr>`);
      (callouts[newLine] || []).forEach((c) => rows.push(_calloutRow(c)));
      newLine++;
    } else if (pfx === "-") {
      rows.push(`<tr class="diff-del"><td class="diff-ln">${oldLine}</td><td class="diff-ln"></td><td class="diff-code"><span class="diff-pfx">-</span>${esc(content)}</td></tr>`);
      oldLine++;
    } else {
      // context line (space or bare)
      rows.push(`<tr class="diff-ctx"><td class="diff-ln">${oldLine}</td><td class="diff-ln">${newLine}</td><td class="diff-code"><span class="diff-pfx"> </span>${esc(content)}</td></tr>`);
      (callouts[newLine] || []).forEach((c) => rows.push(_calloutRow(c)));
      oldLine++;
      newLine++;
    }
  }

  return `<table class="diff-table"><tbody>${rows.join("")}</tbody></table>`;
}

function _calloutRow(c) {
  if (c.type === "ann") {
    const a = c.data;
    const sev = a.severity || "info";
    const who = a.author === "agent" ? "&#129302; Agent" : "&#128100; User";
    return `<tr class="diff-callout"><td colspan="3"><div class="annotation-block ${esc(sev)}"><span class="ann-meta">${who} &middot; ${esc(sev)}</span><div class="ann-body">${esc(a.comment)}</div></div></td></tr>`;
  }
  const d = c.data;
  const who = d.user || "GitHub";
  return `<tr class="diff-callout"><td colspan="3"><div class="gh-comment-block"><span class="ann-meta">&#128279; ${esc(who)}</span><div class="ann-body">${esc(d.body || "")}</div></div></td></tr>`;
}

async function syncReviews() {
  const btn = document.getElementById("reviews-sync-btn");
  btn.disabled = true;
  btn.textContent = "Syncing...";
  try {
    await fetch("/reviews/sync", { method: "POST" });
  } finally {
    btn.disabled = false;
    btn.textContent = "\u21bb Sync";
  }
}

function openAddPrModal() {
  document.getElementById("add-pr-url").value = "";
  document.getElementById("add-pr-error").style.display = "none";
  document.getElementById("add-pr-modal").classList.remove("hidden");
  setTimeout(() => document.getElementById("add-pr-url").focus(), 50);
}

function closeAddPrModal() {
  document.getElementById("add-pr-modal").classList.add("hidden");
}

async function submitAddPr() {
  const url = document.getElementById("add-pr-url").value.trim();
  const errEl = document.getElementById("add-pr-error");
  const btn = document.getElementById("add-pr-submit");
  errEl.style.display = "none";
  if (!url) return;
  btn.disabled = true;
  try {
    const r = await fetch("/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pr_url: url }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      errEl.textContent = d.detail || "Failed to add PR.";
      errEl.style.display = "block";
      return;
    }
    const review = await r.json();
    closeAddPrModal();
    openReviewPanel(review.id);
  } catch (err) {
    errEl.textContent = String(err);
    errEl.style.display = "block";
  } finally {
    btn.disabled = false;
  }
}

async function deleteReview(id) {
  if (!confirm("Remove this review?")) return;
  await fetch(`/reviews/${id}`, { method: "DELETE" });
}

async function convertReviewToTask(id) {
  const rid = id || _activeReviewId;
  if (!rid) return;
  const r = await fetch(`/reviews/${rid}/convert-to-task`, { method: "POST" });
  if (!r.ok) { alert("Failed to convert review to task."); return; }
  const task = await r.json();
  closeReviewPanel();
  switchTab("tasks");
  showPrompt(task);
}

function showReviewPrompt() {
  const review = state.reviews.find((r) => r.id === _activeReviewId);
  if (!review) return;
  const tool = state.tools.find((t) => t.id === review.tool_id);
  const files = (review.changed_files || []).map((f) => `  - ${f.filename} (${f.status || "modified"}, +${f.additions || 0}/-${f.deletions || 0})`).join("\n") || "  (none)";
  const annotations = (review.annotations || []).map((a) => `  [${a.severity}] ${a.file_path}:${a.line} - ${a.comment}`).join("\n") || "  (none so far)";

  const descSection = (review.pr_body && review.pr_body.trim())
    ? `\nDescription:\n${review.pr_body.trim().split("\n").map((l) => `  ${l}`).join("\n")}\n`
    : "";

  const ghReviews = (review.github_reviews || []).filter((rv) => rv.body && rv.body.trim());
  const ghInline = (review.github_comments || []);
  let convSection = "";
  if (ghReviews.length || ghInline.length) {
    const stateLabel = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented", DISMISSED: "Dismissed" };
    const lines = ghReviews.map((rv) => `  ${rv.user} [${stateLabel[rv.state] || rv.state}]: ${rv.body.trim()}`);
    ghInline.forEach((c) => lines.push(`  ${c.user} on ${c.path}${c.line ? `:${c.line}` : ""}: ${c.body.trim()}`));
    convSection = `\nConversation:\n${lines.join("\n")}\n`;
  }

  const prompt = `PR Review: ${review.title}

Repo:        ${review.repo}
PR:          ${review.pr_url}
Branch:      ${review.head_branch} -> ${review.base_branch}
Status:      ${review.status}${tool ? `\nTool:        ${tool.name}` : ""}
${descSection}${convSection}
Changed files:
${files}

Existing annotations:
${annotations}

Instructions:
- Use review_clone('${review.id}') to clone the repo and check out the head branch for local inspection.
- Use review_get_files('${review.id}') to get the list of changed files with their patches.
- Review each changed file carefully. For any issue found, call review_annotate('${review.id}', file_path, line_number, comment, severity) where severity is 'error', 'warning', or 'info'.
- Pay attention to the description and any existing conversation above - use them as context.
- When you have reviewed all files, call review_complete('${review.id}', summary) with a brief summary of your findings.
- Do NOT push any commits or create any GitHub comments. This is a local review only.
- Focus on: correctness, security (OWASP Top 10), edge cases, test coverage gaps.`;

  document.getElementById("prompt-text").textContent = prompt;
  document.getElementById("prompt-modal").classList.remove("hidden");
}

connect();
