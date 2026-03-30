from __future__ import annotations

import asyncio
import json
import os
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

load_dotenv(Path(__file__).parent.parent / ".env")

PORT = int(os.getenv("DASHBOARD_PORT", "8755"))

# SSE: each connected client gets its own queue
_subscribers: list[asyncio.Queue] = []

# Approval slots: id -> { event, result, action, context, expires_at }
_pending: dict[str, dict] = {}

# Value request slots: id -> { event, result, prompt, task_id, expires_at }
_value_pending: dict[str, dict] = {}


def _push(event_type: str, data: dict):
    msg = json.dumps({"type": event_type, **data})
    for q in _subscribers:
        q.put_nowait(msg)


@asynccontextmanager
async def lifespan(app: FastAPI):
    async def _open():
        await asyncio.sleep(1)
        webbrowser.open(f"http://localhost:{PORT}")
    asyncio.create_task(_open())
    yield


app = FastAPI(lifespan=lifespan)


class ApprovalRequest(BaseModel):
    action: str
    context: dict


class ValueRequest(BaseModel):
    prompt: str
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
    try:
        await asyncio.wait_for(event.wait(), timeout=600)
    except asyncio.TimeoutError:
        _pending.pop(approval_id, None)
        _push("approval_expired", {"id": approval_id})
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
    return {"ok": True}


@app.post("/approval/{approval_id}/reject")
async def reject(approval_id: str):
    if approval_id not in _pending:
        raise HTTPException(404)
    slot = _pending[approval_id]
    slot["result"][0] = False
    slot["event"].set()
    _push("approval_resolved", {"id": approval_id, "approved": False})
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


@app.post("/status")
async def post_status(body: StatusReport):
    state.save_status(body.summary, body.percent_complete, body.task_id or None)
    _push("status_update", {
        "summary": body.summary,
        "pct": body.percent_complete,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "task_id": body.task_id or None,
    })
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
    return tool


@app.patch("/tools/{tool_id}")
async def update_tool(tool_id: str, body: dict):
    tool = state.get_tool(tool_id)
    if not tool:
        raise HTTPException(404)
    tool.update(body)
    state.save_tool(tool)
    _push("tool_updated", tool)
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


@app.get("/jenkins/jobs")
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
            init = json.dumps({
                "type": "init",
                "builds": state.get_builds(),
                "status_feed": state.get_status_feed(),
                "pending_approvals": pending,
                "pending_value_requests": pending_values,
                "tasks": state.get_tasks(),
                "tools": state.get_tools(),
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
