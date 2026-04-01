import json
from datetime import datetime, timezone
from pathlib import Path

STATE_FILE = Path(__file__).parent / "state.json"


def _load() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"builds": [], "status_feed": [], "tasks": []}


def _save(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def save_build(job: str, build_number: int, status: str, params: dict = None):
    state = _load()
    entry = {
        "job": job,
        "build_number": build_number,
        "status": status,
        "params": params or {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    state["builds"] = [
        b for b in state["builds"]
        if not (b["job"] == job and b["build_number"] == build_number)
    ]
    state["builds"].insert(0, entry)
    state["builds"] = state["builds"][:100]
    _save(state)


def get_builds() -> list:
    return _load()["builds"]


def save_status(summary: str, pct: int, task_id: str = None):
    state = _load()
    entry = {
        "summary": summary,
        "pct": pct,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if task_id:
        entry["task_id"] = task_id
    state["status_feed"].insert(0, entry)
    state["status_feed"] = state["status_feed"][:50]
    _save(state)


def get_status_feed() -> list:
    return _load().get("status_feed", [])


def clear_status():
    s = _load()
    s["status_feed"] = []
    _save(s)


def save_task(task: dict) -> dict:
    s = _load()
    s.setdefault("tasks", [])
    s["tasks"] = [t for t in s["tasks"] if t["id"] != task["id"]]
    s["tasks"].insert(0, task)
    _save(s)
    return task


def get_tasks() -> list:
    return _load().get("tasks", [])


def get_task(task_id: str) -> dict | None:
    return next((t for t in get_tasks() if t["id"] == task_id), None)


def delete_task(task_id: str):
    s = _load()
    s["tasks"] = [t for t in s.get("tasks", []) if t["id"] != task_id]
    _save(s)


def save_tool(tool: dict) -> dict:
    s = _load()
    s.setdefault("tools", [])
    s["tools"] = [t for t in s["tools"] if t["id"] != tool["id"]]
    s["tools"].append(tool)
    _save(s)
    return tool


def get_tools() -> list:
    return _load().get("tools", [])


def get_tool(tool_id: str) -> dict | None:
    return next((t for t in get_tools() if t["id"] == tool_id), None)


def delete_tool(tool_id: str):
    s = _load()
    s["tools"] = [t for t in s.get("tools", []) if t["id"] != tool_id]
    _save(s)


def save_review(review: dict) -> dict:
    s = _load()
    s.setdefault("reviews", [])
    s["reviews"] = [r for r in s["reviews"] if r["id"] != review["id"]]
    s["reviews"].insert(0, review)
    _save(s)
    return review


def get_reviews() -> list:
    return _load().get("reviews", [])


def get_review(review_id: str) -> dict | None:
    return next((r for r in get_reviews() if r["id"] == review_id), None)


def delete_review(review_id: str):
    s = _load()
    s["reviews"] = [r for r in s.get("reviews", []) if r["id"] != review_id]
    _save(s)


def delete_reviews_for_repo(repo: str, keep_ids: set):
    """Remove reviews for a specific repo that are not in keep_ids (i.e. their PR was closed)."""
    s = _load()
    s["reviews"] = [
        r for r in s.get("reviews", [])
        if r.get("repo") != repo or r["id"] in keep_ids
    ]
    _save(s)


def add_annotation(review_id: str, annotation: dict) -> dict | None:
    s = _load()
    for r in s.get("reviews", []):
        if r["id"] == review_id:
            r.setdefault("annotations", [])
            r["annotations"].append(annotation)
            _save(s)
            return annotation
    return None


def delete_annotation(review_id: str, annotation_id: str):
    s = _load()
    for r in s.get("reviews", []):
        if r["id"] == review_id:
            r["annotations"] = [a for a in r.get("annotations", []) if a["id"] != annotation_id]
            _save(s)
            return


def update_review(review_id: str, updates: dict) -> dict | None:
    s = _load()
    for r in s.get("reviews", []):
        if r["id"] == review_id:
            r.update(updates)
            _save(s)
            return r
    return None
