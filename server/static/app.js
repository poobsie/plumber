const state = {
  approvals: {},
  builds: [],
  status: null,
  tasks: [],
  tools: [],
};

const expandedTasks = new Set();
let completedOpen = false;

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
      state.tasks = msg.tasks || [];
      state.tools = msg.tools || [];
      if (msg.status_feed && msg.status_feed.length) state.status = msg.status_feed[0];
      (msg.pending_approvals || []).forEach((a) => {
        state.approvals[a.id] = { action: a.action, context: a.context, expiresAt: a.expires_at };
      });
      renderAll();
      break;
    case "approval_requested":
      state.approvals[msg.id] = { action: msg.action, context: msg.context, expiresAt: msg.expires_at };
      renderApprovals();
      notify("Approval required", msg.action + (msg.context?.branch ? ` \u2192 ${msg.context.branch}` : ""));
      break;
    case "approval_resolved":
    case "approval_expired":
      delete state.approvals[msg.id];
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
  }
}

function renderAll() {
  renderApprovals();
  renderStatus();
  renderTasks();
  renderTools();
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
  document.getElementById("settings-modal").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settings-modal").classList.add("hidden");
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    defaultPipelineRepo: document.getElementById("s-pipeline-repo").value.trim(),
    jiraHost: document.getElementById("s-jira-host").value.trim(),
  }));
  closeSettings();
}

// --- Tools ---

let currentToolInfo = null;

function toggleToolForm() {
  const panel = document.getElementById("new-tool-panel");
  const open = panel.classList.toggle("hidden");
  if (!open) {
    loadToolJobs();
    const s = getSettings();
    const field = document.getElementById("tf-pipeline-repo");
    if (s.defaultPipelineRepo && !field.value) field.value = s.defaultPipelineRepo;
  }
}

async function loadToolJobs() {
  const sel = document.getElementById("tf-job");
  sel.innerHTML = '<option value="">Loading...</option>';
  try {
    const jobs = await fetch("/jenkins/jobs").then((r) => r.json());
    if (!jobs.length) { sel.innerHTML = '<option value="">No jobs found</option>'; return; }
    sel.innerHTML = '<option value="">Select job...</option>' +
      jobs.map((j) => `<option value="${esc(j)}">${esc(j)}</option>`).join("");
    sel.onchange = () => { if (sel.value) onToolJobSelect(sel.value); };
  } catch {
    sel.innerHTML = '<option value="">Failed to load</option>';
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
  const field = document.getElementById("tf-pipeline-repo-field");
  if (field) field.style.display = loc === "pipeline_repo" ? "" : "none";
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
  toggleToolForm();
}

async function deleteTool(id) {
  await fetch(`/tools/${id}`, { method: "DELETE" });
}

function pipelineLocationLabel(loc) {
  return { pipeline_repo: "separate repo", tool_repo: "code repo", jenkins: "in Jenkins" }[loc] || loc;
}

function renderTools() {
  const list = document.getElementById("tools-list");
  if (!state.tools.length) {
    list.innerHTML = '<span class="empty">No tools configured</span>';
    return;
  }
  list.innerHTML = state.tools.map((t) => `
    <div class="row">
      <span class="row-indicator" style="background:var(--purple)"></span>
      <span class="row-name">${esc(t.name)}</span>
      <span class="row-meta">${esc(t.jenkins_job)}</span>
      <span class="row-tool">${esc(t.code_repo.replace(/^https?:\/\//, ""))}</span>
      <span style="font-size:10px;color:var(--muted);flex-shrink:0">${pipelineLocationLabel(t.pipeline_location)}</span>
      <span style="font-size:10px;color:var(--muted);flex-shrink:0">base: ${esc(t.base_branch || "pre_production")}</span>
      <div class="row-actions" style="margin-left:auto">
        <button class="btn-row danger" title="Delete" onclick="deleteTool('${esc(t.id)}')">&#10005;</button>
      </div>
    </div>`).join("");
}

// --- Stub task ---

function toggleStubForm() {
  const form = document.getElementById("stub-form");
  form.classList.toggle("hidden");
  if (!form.classList.contains("hidden")) {
    document.getElementById("stub-jira").focus();
  }
}

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
  document.getElementById("stub-form").classList.add("hidden");
}

// --- Full task form ---

let paramCount = 0;
let currentJobInfo = null;

function toggleForm() {
  document.getElementById("new-task-panel").classList.toggle("hidden");
  if (!document.getElementById("new-task-panel").classList.contains("hidden")) {
    populateToolSelect();
  }
}

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
  if (tool.is_multibranch) document.getElementById("multibranch-hint").classList.remove("hidden");
  document.getElementById("params-label-extra").textContent = "(loading...)";
  try {
    const info = await fetch(`/jenkins/job/${tool.jenkins_job}/info`).then((r) => r.json());
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

  e.target.reset();
  document.getElementById("params-list").innerHTML = "";
  document.getElementById("multibranch-hint").classList.add("hidden");
  document.getElementById("params-label-extra").textContent = "";
  currentJobInfo = null;
  toggleForm();
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
  const active = state.tasks.filter((t) => !t.completed);
  const completed = state.tasks.filter((t) => t.completed);

  const countEl = document.getElementById("task-count");
  countEl.textContent = active.length;
  countEl.className = active.length ? "badge badge-muted" : "badge badge-muted zero";

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
    : `${!isStub ? `<button class="btn-row primary" title="Start" onclick="event.stopPropagation();showPromptById('${esc(t.id)}')">&#9654;</button>` : ""}
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

  const pipelineLines = {
    pipeline_repo: `Pipeline repo: ${task.pipeline_repo}`,
    tool_repo:     `Pipeline:      Jenkinsfile in code repo`,
    jenkins:       `Pipeline:      Stored in Jenkins`,
  };
  const pipelineLine = pipelineLines[task.pipeline_location] || `Pipeline repo: ${task.pipeline_repo}`;
  const baseBranch = task.base_branch || "pre_production";
  const multibranch = task.is_multibranch
    ? `\nMultibranch pipeline: branch '${task.branch}' determines which pipeline branch runs (job path: ${task.jenkins_job})\n`
    : "";
  const needsPipelineClone = task.pipeline_location === "pipeline_repo";
  const cloneSteps = needsPipelineClone
    ? `- git_clone('${task.id}', 'code') - clones code repo, checks out ${baseBranch}\n- git_clone('${task.id}', 'pipeline') - clones pipeline repo, checks out ${baseBranch}`
    : `- git_clone('${task.id}', 'code') - clones code repo, checks out ${baseBranch}`;
  const gitNote = needsPipelineClone
    ? `- Use git_create_branch on both cloned paths before editing anything.\n- Use git_push (not raw git) to push each branch - approval required.`
    : `- Use git_create_branch on the cloned code repo path before editing anything.\n- Use git_push (not raw git) to push the branch - approval required.`;

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
- For multibranch pipelines: after pushing, call jenkins_scan('${task.jenkins_job}') first,
  wait 15s, then trigger the branch job. The branch job won't exist until Jenkins scans.
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

document.getElementById("prompt-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closePrompt();
});
document.getElementById("settings-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeSettings();
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
  await fetch(`/approval/${id}/${approved ? "approve" : "reject"}`, { method: "POST" });
}

function renderApprovals() {
  const section = document.getElementById("approvals-section");
  const list = document.getElementById("approvals-list");
  const count = document.getElementById("approval-count");
  const entries = Object.entries(state.approvals);

  count.textContent = entries.length;
  count.className = entries.length ? "badge" : "badge zero";

  if (!entries.length) {
    section.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  section.classList.remove("hidden");
  list.innerHTML = entries.map(([id, a]) => {
    if (a.action === "open_pr") return renderPrApproval(id, a);
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
}

// --- Status (orphaned - not linked to a task) ---

function renderStatus() {
  const section = document.getElementById("status-section");
  if (!state.status || state.status.task_id) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  const { summary, pct, timestamp } = state.status;
  document.getElementById("status-summary").textContent = summary;
  document.getElementById("status-pct").textContent = `${pct}%`;
  document.getElementById("progress-fill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  document.getElementById("status-time").textContent = relTime(timestamp);
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

connect();
