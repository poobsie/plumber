from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import uuid
import webbrowser
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import state
import webex
import github as gh

load_dotenv(Path(__file__).parent.parent / ".env")

PORT = int(os.getenv("DASHBOARD_PORT", "8755"))
REVIEW_SYNC_INTERVAL = int(os.getenv("REVIEW_SYNC_INTERVAL_MINUTES", "10")) * 60

# SSE: each connected client gets its own queue
_subscribers: list[asyncio.Queue] = []

# Approval slots: id -> { event, result, action, context, expires_at }
_pending: dict[str, dict] = {}

# Value request slots: id -> { event, result, prompt, task_id, expires_at }
_value_pending: dict[str, dict] = {}

# Choice request slots: id -> { event, result, prompt, options, task_id, expires_at }
_choice_pending: dict[str, dict] = {}


def _push(event_type: str, data: dict):
    msg = json.dumps({"type": event_type, **data})
    for q in _subscribers:
        q.put_nowait(msg)


async def _sync_tool_prs(tool: dict):
    """Fetch open user-authored PRs for a tool's repo and upsert into reviews state."""
    try:
        repo_url = tool.get("code_repo", "")
        if not repo_url:
            return
        repo = gh.repo_from_url(repo_url)
        user = gh.get_authed_user()
        username = user["login"]
        open_prs = gh.get_open_prs_by_user(username, repo)
        kept_ids = set()
        for item in open_prs:
            pr_number = item["number"]
            try:
                pr = gh.get_pr(repo, pr_number)
                files = gh.get_pr_files(repo, pr_number)
                comments = gh.get_pr_comments(repo, pr_number)
                reviews = gh.get_pr_reviews(repo, pr_number)
            except Exception:
                continue
            existing = next(
                (r for r in state.get_reviews() if r.get("repo") == repo and r.get("pr_number") == pr_number),
                None,
            )
            review_id = existing["id"] if existing else str(uuid.uuid4())
            kept_ids.add(review_id)
            review = {
                "id": review_id,
                "tool_id": tool["id"],
                "pr_number": pr_number,
                "repo": repo,
                "title": pr.get("title", ""),
                "head_branch": pr["head"]["ref"],
                "base_branch": pr["base"]["ref"],
                "author": pr["user"]["login"],
                "authored_by_me": True,
                "draft": pr.get("draft", False),
                "pr_body": pr.get("body", "") or "",
                "pr_url": pr.get("html_url", ""),
                "changed_files": [
                    {
                        "filename": f.get("filename", ""),
                        "status": f.get("status", ""),
                        "additions": f.get("additions", 0),
                        "deletions": f.get("deletions", 0),
                        "patch": f.get("patch", ""),
                    }
                    for f in files
                ],
                "github_comments": [
                    {
                        "id": c.get("id"),
                        "user": c["user"]["login"] if c.get("user") else "",
                        "body": c.get("body", ""),
                        "path": c.get("path", ""),
                        "line": c.get("line") or c.get("original_line"),
                        "created_at": c.get("created_at", ""),
                    }
                    for c in comments
                ],
                "github_reviews": [
                    {
                        "id": rv.get("id"),
                        "user": rv["user"]["login"] if rv.get("user") else "",
                        "state": rv.get("state", ""),
                        "body": rv.get("body", "") or "",
                        "submitted_at": rv.get("submitted_at", ""),
                    }
                    for rv in reviews
                ],
                "annotations": existing.get("annotations", []) if existing else [],
                "status": existing.get("status", "pending") if existing else "pending",
                "review_summary": existing.get("review_summary") if existing else None,
                "converted_task_id": existing.get("converted_task_id") if existing else None,
                "workspace_path": existing.get("workspace_path") if existing else None,
            }
            state.save_review(review)
            _push("review_updated", review)
        # Remove reviews for PRs that are no longer open
        state.delete_reviews_for_repo(repo, kept_ids)
        # Push deletions for any that disappeared
        for r in state.get_reviews():
            if r.get("repo") == repo and r["id"] not in kept_ids:
                _push("review_deleted", {"id": r["id"]})
    except Exception:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    async def _open():
        await asyncio.sleep(1)
        webbrowser.open(f"http://localhost:{PORT}")

    async def _webex_poll():
        while True:
            await asyncio.sleep(4)
            if not webex._token:
                continue
            loop = asyncio.get_event_loop()
            resolved = await loop.run_in_executor(None, webex.poll_pending)
            for approval_id, approved in resolved:
                if approval_id in _pending:
                    slot = _pending[approval_id]
                    slot["result"][0] = approved
                    slot["event"].set()
                    _push("approval_resolved", {"id": approval_id, "approved": approved})
                    await loop.run_in_executor(
                        None, webex.on_resolved, approval_id, approved, "Webex reaction"
                    )

    async def _review_sync_loop():
        while True:
            await asyncio.sleep(REVIEW_SYNC_INTERVAL)
            for tool in state.get_tools():
                await _sync_tool_prs(tool)

    asyncio.create_task(_open())
    asyncio.create_task(_webex_poll())
    asyncio.create_task(_review_sync_loop())
    yield


app = FastAPI(lifespan=lifespan)


class ApprovalRequest(BaseModel):
    action: str
    context: dict


class ValueRequest(BaseModel):
    prompt: str
    task_id: str = ""


class ChoiceRequest(BaseModel):
    prompt: str
    options: list[str]
    task_id: str = ""


class StatusReport(BaseModel):
    summary: str
    percent_complete: int
    task_id: str = ""


class BuildRecord(BaseModel):
    job: str
    build_number: int
    status: str
    params: dict = {}


class Tool(BaseModel):
    id: str = ""
    name: str
    code_repo: str
    jenkins_job: str
    is_multibranch: bool = False
    pipeline_location: str = "pipeline_repo"  # pipeline_repo | tool_repo | jenkins
    pipeline_repo: str = ""
    base_branch: str = "pre_production"


class Task(BaseModel):
    id: str = ""
    name: str = ""
    tool_id: str = ""
    branch: str = ""
    description: str = ""
    static_params: dict = {}
    completed: bool = False
    status: str = "pending"
    # snapshotted from tool at creation
    code_repo: str = ""
    pipeline_repo: str = ""
    jenkins_job: str = ""
    is_multibranch: bool = False
    pipeline_location: str = "pipeline_repo"
    base_branch: str = "pre_production"
    jira_us: str = ""
    pr_url: str = ""
    pr_number: int = 0


class Annotation(BaseModel):
    file_path: str
    line: int | None = None
    comment: str
    severity: str = "info"  # info | warning | error
    author: str = "agent"   # agent | user


@app.post("/approval/request")
async def request_approval(body: ApprovalRequest):
    approval_id = str(uuid.uuid4())
    event = asyncio.Event()
    expires_at = (datetime.now(timezone.utc).timestamp() + 600) * 1000  # ms for JS
    _pending[approval_id] = {
        "event": event,
        "result": [None],
        "action": body.action,
        "context": body.context,
        "expires_at": expires_at,
    }
    _push("approval_requested", {
        "id": approval_id,
        "action": body.action,
        "context": body.context,
        "expires_at": expires_at,
    })
    asyncio.get_event_loop().run_in_executor(
        None, webex.send_approval, approval_id, body.action, body.context
    )
    try:
        await asyncio.wait_for(event.wait(), timeout=600)
    except asyncio.TimeoutError:
        _pending.pop(approval_id, None)
        _push("approval_expired", {"id": approval_id})
        asyncio.get_event_loop().run_in_executor(None, webex.on_resolved, approval_id, False, "timeout")
        return {"approved": False, "reason": "timeout"}
    approved = _pending.pop(approval_id)["result"][0]
    return {"approved": approved}


@app.post("/approval/{approval_id}/approve")
async def approve(approval_id: str):
    if approval_id not in _pending:
        raise HTTPException(404)
    slot = _pending[approval_id]
    slot["result"][0] = True
    slot["event"].set()
    _push("approval_resolved", {"id": approval_id, "approved": True})
    asyncio.get_event_loop().run_in_executor(None, webex.on_resolved, approval_id, True, "dashboard")
    return {"ok": True}


@app.post("/approval/{approval_id}/reject")
async def reject(approval_id: str):
    if approval_id not in _pending:
        raise HTTPException(404)
    slot = _pending[approval_id]
    slot["result"][0] = False
    slot["event"].set()
    _push("approval_resolved", {"id": approval_id, "approved": False})
    asyncio.get_event_loop().run_in_executor(None, webex.on_resolved, approval_id, False, "dashboard")
    return {"ok": True}


@app.delete("/status")
async def clear_status():
    state.clear_status()
    _push("status_cleared", {})
    return {"ok": True}


@app.post("/value/request")
async def request_value(body: ValueRequest):
    req_id = str(uuid.uuid4())
    event = asyncio.Event()
    expires_at = (datetime.now(timezone.utc).timestamp() + 600) * 1000
    _value_pending[req_id] = {
        "event": event,
        "result": [None],
        "cancelled": [False],
        "prompt": body.prompt,
        "task_id": body.task_id,
        "expires_at": expires_at,
    }
    _push("value_requested", {
        "id": req_id,
        "prompt": body.prompt,
        "task_id": body.task_id,
        "expires_at": expires_at,
    })
    asyncio.get_event_loop().run_in_executor(
        None, webex.send_input_request, body.prompt, body.task_id or None, state.get_tasks()
    )
    try:
        await asyncio.wait_for(event.wait(), timeout=600)
    except asyncio.TimeoutError:
        _value_pending.pop(req_id, None)
        _push("value_expired", {"id": req_id})
        return {"value": None, "reason": "timeout"}
    slot = _value_pending.pop(req_id)
    if slot["cancelled"][0]:
        return {"value": None, "reason": "cancelled"}
    return {"value": slot["result"][0]}


@app.post("/value/{req_id}/submit")
async def submit_value(req_id: str, body: dict):
    if req_id not in _value_pending:
        raise HTTPException(404)
    slot = _value_pending[req_id]
    slot["result"][0] = body.get("value", "")
    slot["event"].set()
    _push("value_resolved", {"id": req_id})
    return {"ok": True}


@app.post("/value/{req_id}/cancel")
async def cancel_value(req_id: str):
    if req_id not in _value_pending:
        raise HTTPException(404)
    slot = _value_pending[req_id]
    slot["cancelled"][0] = True
    slot["event"].set()
    _push("value_resolved", {"id": req_id})
    return {"ok": True}


@app.post("/choice/request")
async def request_choice(body: ChoiceRequest):
    req_id = str(uuid.uuid4())
    event = asyncio.Event()
    expires_at = (datetime.now(timezone.utc).timestamp() + 600) * 1000
    _choice_pending[req_id] = {
        "event": event,
        "result": [None],
        "cancelled": [False],
        "prompt": body.prompt,
        "options": body.options,
        "task_id": body.task_id,
        "expires_at": expires_at,
    }
    _push("choice_requested", {
        "id": req_id,
        "prompt": body.prompt,
        "options": body.options,
        "task_id": body.task_id,
        "expires_at": expires_at,
    })
    asyncio.get_event_loop().run_in_executor(
        None, webex.send_choice_request, body.prompt, body.options, body.task_id or None, state.get_tasks()
    )
    try:
        await asyncio.wait_for(event.wait(), timeout=600)
    except asyncio.TimeoutError:
        _choice_pending.pop(req_id, None)
        _push("choice_expired", {"id": req_id})
        return {"value": None, "reason": "timeout"}
    slot = _choice_pending.pop(req_id)
    if slot["cancelled"][0]:
        return {"value": None, "reason": "cancelled"}
    return {"value": slot["result"][0]}


@app.post("/choice/{req_id}/submit")
async def submit_choice(req_id: str, body: dict):
    if req_id not in _choice_pending:
        raise HTTPException(404)
    slot = _choice_pending[req_id]
    slot["result"][0] = body.get("value", "")
    slot["event"].set()
    _push("choice_resolved", {"id": req_id})
    return {"ok": True}


@app.post("/choice/{req_id}/cancel")
async def cancel_choice(req_id: str):
    if req_id not in _choice_pending:
        raise HTTPException(404)
    slot = _choice_pending[req_id]
    slot["cancelled"][0] = True
    slot["event"].set()
    _push("choice_resolved", {"id": req_id})
    return {"ok": True}


@app.post("/status")
async def post_status(body: StatusReport):
    state.save_status(body.summary, body.percent_complete, body.task_id or None)
    _push("status_update", {
        "summary": body.summary,
        "pct": body.percent_complete,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "task_id": body.task_id or None,
    })
    asyncio.get_event_loop().run_in_executor(
        None, webex.send_status, body.summary, body.percent_complete, body.task_id or None, state.get_tasks()
    )
    return {"ok": True}


class WebexConfig(BaseModel):
    token: str
    room: str


@app.post("/webex/config")
async def configure_webex(body: WebexConfig):
    asyncio.get_event_loop().run_in_executor(None, webex.configure, body.token, body.room)
    return {"ok": True}


@app.post("/build")
async def record_build(body: BuildRecord):
    state.save_build(body.job, body.build_number, body.status, body.params)
    _push("build_updated", body.model_dump())
    return {"ok": True}


@app.get("/builds")
async def get_builds():
    return state.get_builds()


@app.get("/tasks")
async def get_tasks():
    return state.get_tasks()


@app.get("/tasks/{task_id}")
async def get_task(task_id: str):
    task = state.get_task(task_id)
    if not task:
        raise HTTPException(404)
    return task


@app.get("/tools")
async def get_tools():
    return state.get_tools()


@app.post("/tools")
async def create_tool(body: Tool):
    tool = body.model_dump()
    tool["id"] = str(uuid.uuid4())
    state.save_tool(tool)
    _push("tool_updated", tool)
    asyncio.create_task(_sync_tool_prs(tool))
    return tool


@app.patch("/tools/{tool_id}")
async def update_tool(tool_id: str, body: dict):
    tool = state.get_tool(tool_id)
    if not tool:
        raise HTTPException(404)
    old_repo = tool.get("code_repo", "")
    tool.update(body)
    state.save_tool(tool)
    _push("tool_updated", tool)
    # If code_repo changed, drop reviews for old repo that don't match new one
    new_repo = tool.get("code_repo", "")
    if old_repo != new_repo and old_repo:
        try:
            old_owner_repo = gh.repo_from_url(old_repo)
            state.delete_reviews_for_repo(old_owner_repo, set())
        except Exception:
            pass
    asyncio.create_task(_sync_tool_prs(tool))
    return tool


@app.delete("/tools/{tool_id}")
async def remove_tool(tool_id: str):
    state.delete_tool(tool_id)
    _push("tool_deleted", {"id": tool_id})
    return {"ok": True}


@app.post("/tasks")
async def create_task(body: Task):
    task = body.model_dump()
    task["id"] = str(uuid.uuid4())
    task["created_at"] = datetime.now(timezone.utc).isoformat()
    if body.tool_id:
        tool = state.get_tool(body.tool_id)
        if not tool:
            raise HTTPException(404, "Tool not found")
        task["code_repo"] = tool["code_repo"]
        task["pipeline_location"] = tool["pipeline_location"]
        task["is_multibranch"] = tool["is_multibranch"]
        task["base_branch"] = tool.get("base_branch", "pre_production")
        if tool["pipeline_location"] == "pipeline_repo":
            task["pipeline_repo"] = tool.get("pipeline_repo", "")
        elif tool["pipeline_location"] == "tool_repo":
            task["pipeline_repo"] = tool["code_repo"]
        else:
            task["pipeline_repo"] = ""
        base_job = tool["jenkins_job"]
        task["jenkins_job"] = f"{base_job}/{body.branch}" if tool["is_multibranch"] else base_job
    if not task["name"] and task["jira_us"]:
        task["name"] = task["jira_us"]
    state.save_task(task)
    _push("task_updated", task)
    return task


@app.patch("/tasks/{task_id}")
async def update_task(task_id: str, body: dict):
    task = state.get_task(task_id)
    if not task:
        raise HTTPException(404)
    task.update(body)
    state.save_task(task)
    _push("task_updated", task)
    return task


@app.delete("/tasks/{task_id}")
async def remove_task(task_id: str):
    state.delete_task(task_id)
    _push("task_deleted", {"id": task_id})
    return {"ok": True}


# ── Reviews ──────────────────────────────────────────────────────────────────

@app.get("/reviews")
async def get_reviews():
    return state.get_reviews()


@app.get("/reviews/{review_id}")
async def get_review(review_id: str):
    r = state.get_review(review_id)
    if not r:
        raise HTTPException(404)
    return r


@app.delete("/reviews/{review_id}")
async def remove_review(review_id: str):
    state.delete_review(review_id)
    _push("review_deleted", {"id": review_id})
    return {"ok": True}


@app.post("/reviews/sync")
async def sync_reviews(tool_id: str = None):
    tools = state.get_tools()
    if tool_id:
        tools = [t for t in tools if t["id"] == tool_id]
    for tool in tools:
        asyncio.create_task(_sync_tool_prs(tool))
    return {"ok": True, "syncing": len(tools)}


@app.post("/reviews")
async def add_review(body: dict):
    """Manually add a PR by URL. Works for any author."""
    url = body.get("pr_url", body.get("url", "")).strip()
    m = re.search(r"https?://[^/]+/([^/]+/[^/]+)/pull/(\d+)", url)
    if not m:
        raise HTTPException(400, "Invalid GitHub PR URL")
    repo = m.group(1)
    pr_number = int(m.group(2))

    # Check if already tracked
    existing = next(
        (r for r in state.get_reviews() if r.get("repo") == repo and r.get("pr_number") == pr_number),
        None,
    )
    if existing:
        return existing

    loop = asyncio.get_event_loop()
    try:
        pr = await loop.run_in_executor(None, lambda: gh.get_pr(repo, pr_number))
        files = await loop.run_in_executor(None, lambda: gh.get_pr_files(repo, pr_number))
        comments = await loop.run_in_executor(None, lambda: gh.get_pr_comments(repo, pr_number))
        reviews = await loop.run_in_executor(None, lambda: gh.get_pr_reviews(repo, pr_number))
        user = await loop.run_in_executor(None, gh.get_authed_user)
    except Exception as e:
        raise HTTPException(502, f"GitHub API error: {e}")

    # Auto-associate tool by matching code_repo URL
    tool_id = None
    try:
        for t in state.get_tools():
            if gh.repo_from_url(t.get("code_repo", "")) == repo:
                tool_id = t["id"]
                break
    except Exception:
        pass

    review = {
        "id": str(uuid.uuid4()),
        "tool_id": tool_id,
        "pr_number": pr_number,
        "repo": repo,
        "title": pr.get("title", ""),
        "head_branch": pr["head"]["ref"],
        "base_branch": pr["base"]["ref"],
        "author": pr["user"]["login"],
        "authored_by_me": pr["user"]["login"] == user["login"],
        "draft": pr.get("draft", False),
        "pr_body": pr.get("body", "") or "",
        "pr_url": pr.get("html_url", ""),
        "changed_files": [
            {
                "filename": f.get("filename", ""),
                "status": f.get("status", ""),
                "additions": f.get("additions", 0),
                "deletions": f.get("deletions", 0),
                "patch": f.get("patch", ""),
            }
            for f in files
        ],
        "github_comments": [
            {
                "id": c.get("id"),
                "user": c["user"]["login"] if c.get("user") else "",
                "body": c.get("body", ""),
                "path": c.get("path", ""),
                "line": c.get("line") or c.get("original_line"),
                "created_at": c.get("created_at", ""),
            }
            for c in comments
        ],
        "github_reviews": [
            {
                "id": rv.get("id"),
                "user": rv["user"]["login"] if rv.get("user") else "",
                "state": rv.get("state", ""),
                "body": rv.get("body", "") or "",
                "submitted_at": rv.get("submitted_at", ""),
            }
            for rv in reviews
        ],
        "annotations": [],
        "status": "pending",
        "review_summary": None,
        "converted_task_id": None,
        "workspace_path": None,
    }
    state.save_review(review)
    _push("review_updated", review)
    return review


@app.patch("/reviews/{review_id}")
async def update_review(review_id: str, body: dict):
    r = state.get_review(review_id)
    if not r:
        raise HTTPException(404)
    updated = state.update_review(review_id, body)
    _push("review_updated", updated)
    return updated


@app.post("/reviews/{review_id}/annotations")
async def add_annotation(review_id: str, body: Annotation):
    r = state.get_review(review_id)
    if not r:
        raise HTTPException(404)
    annotation = body.model_dump()
    annotation["id"] = str(uuid.uuid4())
    annotation["created_at"] = datetime.now(timezone.utc).isoformat()
    result = state.add_annotation(review_id, annotation)
    # Update status to reviewing if still pending
    if r.get("status") == "pending":
        state.update_review(review_id, {"status": "reviewing"})
    updated = state.get_review(review_id)
    _push("review_updated", updated)
    return result


@app.delete("/reviews/{review_id}/annotations/{annotation_id}")
async def remove_annotation(review_id: str, annotation_id: str):
    r = state.get_review(review_id)
    if not r:
        raise HTTPException(404)
    state.delete_annotation(review_id, annotation_id)
    updated = state.get_review(review_id)
    _push("review_updated", updated)
    return {"ok": True}


@app.post("/reviews/{review_id}/convert-to-task")
async def convert_review_to_task(review_id: str):
    r = state.get_review(review_id)
    if not r:
        raise HTTPException(404)
    if r.get("converted_task_id"):
        existing_task = state.get_task(r["converted_task_id"])
        if existing_task:
            return existing_task

    # Build annotation summary grouped by file
    annotations = r.get("annotations", [])
    by_file: dict[str, list] = {}
    for a in annotations:
        fp = a.get("file_path", "unknown")
        by_file.setdefault(fp, []).append(a)

    lines = [f"Address review comments for PR #{r['pr_number']}: {r['title']}", f"Repo: {r['repo']}  |  {r['head_branch']} -> {r['base_branch']}", ""]
    if r.get("review_summary"):
        lines += [f"Review summary: {r['review_summary']}", ""]
    if by_file:
        lines.append("Issues to address:")
        for fp, anns in by_file.items():
            lines.append(f"\n{fp}:")
            for a in anns:
                line_ref = f"line {a['line']}: " if a.get("line") else ""
                lines.append(f"  [{a['severity'].upper()}] {line_ref}{a['comment']}")
    else:
        lines.append("(No annotations - review the PR and apply any needed fixes.)")

    description = "\n".join(lines)

    tool_id = r.get("tool_id")
    if not tool_id:
        # Try to find a matching tool by repo
        try:
            for t in state.get_tools():
                if gh.repo_from_url(t.get("code_repo", "")) == r["repo"]:
                    tool_id = t["id"]
                    break
        except Exception:
            pass

    task = {
        "id": str(uuid.uuid4()),
        "name": f"PR #{r['pr_number']}: {r['title']}",
        "tool_id": tool_id or "",
        "branch": r.get("head_branch", ""),
        "description": description,
        "static_params": {},
        "completed": False,
        "status": "pending",
        "jira_us": "",
        "pr_url": r.get("pr_url", ""),
        "pr_number": r.get("pr_number", 0),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if tool_id:
        tool = state.get_tool(tool_id)
        if tool:
            task["code_repo"] = tool["code_repo"]
            task["pipeline_location"] = tool["pipeline_location"]
            task["is_multibranch"] = tool["is_multibranch"]
            task["base_branch"] = tool.get("base_branch", "pre_production")
            task["pipeline_repo"] = tool.get("pipeline_repo", "") if tool["pipeline_location"] == "pipeline_repo" else (tool["code_repo"] if tool["pipeline_location"] == "tool_repo" else "")
            task["jenkins_job"] = f"{tool['jenkins_job']}/{r['head_branch']}" if tool["is_multibranch"] else tool["jenkins_job"]
    else:
        task.update({"code_repo": "", "pipeline_repo": "", "jenkins_job": "", "is_multibranch": False, "pipeline_location": "none", "base_branch": "pre_production"})

    state.save_task(task)
    _push("task_updated", task)
    state.update_review(review_id, {"converted_task_id": task["id"]})
    updated_review = state.get_review(review_id)
    _push("review_updated", updated_review)
    return task
async def list_jenkins_jobs():
    try:
        from jenkins import Jenkins
        j = Jenkins(
            os.getenv("JENKINS_URL", ""),
            os.getenv("JENKINS_USERNAME", ""),
            os.getenv("JENKINS_API_TOKEN", ""),
        )
        loop = asyncio.get_event_loop()
        jobs = await loop.run_in_executor(None, j.list_jobs)
        return jobs
    except Exception:
        return []


@app.get("/jenkins/job/{job:path}/info")
async def get_job_info(job: str):
    try:
        from jenkins import Jenkins
        j = Jenkins(
            os.getenv("JENKINS_URL", ""),
            os.getenv("JENKINS_USERNAME", ""),
            os.getenv("JENKINS_API_TOKEN", ""),
        )
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, lambda: j.get_job_info(job))
    except Exception as e:
        return {"is_multibranch": False, "params": [], "error": str(e)}


@app.get("/status-feed")
async def get_status_feed():
    return state.get_status_feed()


@app.get("/proxy/logs/{job}/{build}")
async def proxy_logs(job: str, build: int, tail: int = 200):
    from jenkins import Jenkins
    j = Jenkins(
        os.getenv("JENKINS_URL", ""),
        os.getenv("JENKINS_USERNAME", ""),
        os.getenv("JENKINS_API_TOKEN", ""),
    )
    loop = asyncio.get_event_loop()
    logs = await loop.run_in_executor(None, lambda: j.get_logs(job, build, tail))
    return {"logs": logs}


@app.get("/events")
async def sse(request: Request):
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.append(q)

    async def generate():
        try:
            # Send current state on connect so a page refresh restores everything
            pending = [
                {"id": id_, "action": s["action"], "context": s["context"], "expires_at": s["expires_at"]}
                for id_, s in _pending.items()
            ]
            pending_values = [
                {"id": id_, "prompt": s["prompt"], "task_id": s["task_id"], "expires_at": s["expires_at"]}
                for id_, s in _value_pending.items()
            ]
            pending_choices = [
                {"id": id_, "prompt": s["prompt"], "options": s["options"], "task_id": s["task_id"], "expires_at": s["expires_at"]}
                for id_, s in _choice_pending.items()
            ]
            init = json.dumps({
                "type": "init",
                "builds": state.get_builds(),
                "status_feed": state.get_status_feed(),
                "pending_approvals": pending,
                "pending_value_requests": pending_values,
                "pending_choice_requests": pending_choices,
                "tasks": state.get_tasks(),
                "tools": state.get_tools(),
                "reviews": state.get_reviews(),
            })
            yield f"data: {init}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            _subscribers.remove(q)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Static files last so API routes take priority
app.mount("/", StaticFiles(directory=str(Path(__file__).parent / "static"), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
