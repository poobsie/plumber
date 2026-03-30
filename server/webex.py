"""Webex Bot notifications. Approvals use 👍/👎 reaction polling - no public URL needed."""

from __future__ import annotations

import json
import logging
from typing import Any

import requests

WEBEX_API = "https://webexapis.com/v1"
log = logging.getLogger(__name__)

_token: str = ""
_room: str = ""
# approval_id -> message_id, kept while the approval is pending
_pending_msgs: dict[str, str] = {}


def configure(token: str, room: str):
    global _token, _room
    _token = token
    _room = room


def _headers() -> dict:
    return {"Authorization": f"Bearer {_token}", "Content-Type": "application/json"}


def _dest() -> dict:
    if "@" in _room:
        return {"toPersonEmail": _room}
    return {"roomId": _room}


def _send(text: str) -> str | None:
    """Send a markdown message, return message ID or None."""
    if not _token or not _room:
        return None
    try:
        r = requests.post(
            f"{WEBEX_API}/messages",
            headers=_headers(),
            json={**_dest(), "markdown": text},
            timeout=10,
        )
        r.raise_for_status()
        return r.json().get("id")
    except Exception as e:
        log.warning("Webex send failed: %s", e)
        return None


def _edit(message_id: str, text: str):
    """Update an existing message to reflect resolved state."""
    if not _token or not message_id:
        return
    try:
        requests.put(
            f"{WEBEX_API}/messages/{message_id}",
            headers=_headers(),
            json={**_dest(), "markdown": text},
            timeout=10,
        ).raise_for_status()
    except Exception as e:
        log.warning("Webex edit failed: %s", e)


def _ctx_lines(context: dict) -> str:
    lines = []
    for k, v in context.items():
        val = json.dumps(v) if isinstance(v, (dict, list)) else str(v)
        lines.append(f"**{k}:** `{val}`")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Approval request
# ---------------------------------------------------------------------------

def send_approval(approval_id: str, action: str, context: dict):
    if not _token:
        return
    label = action.replace("_", " ").title()
    ctx = _ctx_lines(context)
    # For jenkins_trigger, show params block separately for readability
    if action == "jenkins_trigger" and isinstance(context.get("params"), dict):
        params = context["params"]
        param_lines = "\n".join(f"  `{k}` = `{v}`" for k, v in params.items()) if params else "  _(none)_"
        job_line = f"**job:** `{context.get('job', '')}`"
        ctx = f"{job_line}\n\n**Parameters:**\n{param_lines}"
    elif action == "open_pr":
        ctx = (
            f"**repo:** `{context.get('repo', '')}`\n"
            f"**branch:** `{context.get('head', '')}` \u2192 `{context.get('base', '')}`\n"
            f"**title:** {context.get('title', '')}"
        )
        if context.get("body"):
            preview = (context["body"] or "")[:400]
            ctx += f"\n\n{preview}" + ("..." if len(context["body"]) > 400 else "")

    text = (
        f"**\U0001f510 Approval required: {label}**\n\n"
        f"{ctx}\n\n"
        f"React \U0001f44d to approve or \U0001f44e to reject"
    )
    msg_id = _send(text)
    if msg_id:
        _pending_msgs[approval_id] = msg_id


def poll_pending() -> list[tuple[str, bool]]:
    """Poll reactions on pending approval messages. Returns (approval_id, approved) pairs."""
    if not _token or not _pending_msgs:
        return []
    resolved: list[tuple[str, bool]] = []
    for approval_id, msg_id in list(_pending_msgs.items()):
        try:
            r = requests.get(
                f"{WEBEX_API}/reactions",
                headers=_headers(),
                params={"messageId": msg_id},
                timeout=10,
            )
            r.raise_for_status()
            items = r.json().get("items", [])
        except Exception:
            continue
        for reaction in items:
            emoji = (reaction.get("emoji") or "").lower().strip(":")
            if emoji in ("thumbsup", "+1", "thumbs_up", "like", "yes"):
                resolved.append((approval_id, True))
                break
            if emoji in ("thumbsdown", "-1", "thumbs_down", "dislike", "no"):
                resolved.append((approval_id, False))
                break
    return resolved


def on_resolved(approval_id: str, approved: bool, via: str = "dashboard"):
    """Called when an approval is resolved (from dashboard or reaction). Edits the Webex message."""
    msg_id = _pending_msgs.pop(approval_id, None)
    if not msg_id:
        return
    icon = "\u2705" if approved else "\u274c"
    result = "Approved" if approved else "Rejected"
    _edit(msg_id, f"**{icon} {result}** _(via {via})_")


# ---------------------------------------------------------------------------
# Status / input / choice
# ---------------------------------------------------------------------------

def send_status(summary: str, pct: int, task_id: str | None, tasks: list[dict]):
    if not _token:
        return
    task_name = ""
    if task_id:
        t = next((t for t in tasks if t["id"] == task_id), None)
        if t:
            task_name = t.get("name") or t.get("jira_us") or ""
    bar_filled = int(pct / 5)
    bar = "\u2588" * bar_filled + "\u2591" * (20 - bar_filled)
    lines = [f"**{pct}%** `{bar}`"]
    if task_name:
        lines.append(f"**Task:** {task_name}")
    lines.append(summary)
    _send("\n".join(lines))


def send_input_request(prompt: str, task_id: str | None, tasks: list[dict]):
    if not _token:
        return
    task_name = ""
    if task_id:
        t = next((t for t in tasks if t["id"] == task_id), None)
        if t:
            task_name = t.get("name") or ""
    header = "Input required" + (f" - {task_name}" if task_name else "")
    _send(f"**\u2328\ufe0f {header}**\n\n{prompt}\n\n_Respond in the dashboard._")


def send_choice_request(prompt: str, options: list[str], task_id: str | None, tasks: list[dict]):
    if not _token:
        return
    task_name = ""
    if task_id:
        t = next((t for t in tasks if t["id"] == task_id), None)
        if t:
            task_name = t.get("name") or ""
    header = "Choice required" + (f" - {task_name}" if task_name else "")
    opts_text = "\n".join(f"- {o}" for o in options)
    _send(f"**\U0001f500 {header}**\n\n{prompt}\n\n{opts_text}\n\n_Select in the dashboard._")
