"""Webex Bot notifications with Adaptive Card buttons for approvals."""

from __future__ import annotations

import logging
from typing import Any

import requests

WEBEX_API = "https://webexapis.com/v1"

log = logging.getLogger(__name__)

# Runtime config - set via /webex/config endpoint
_token: str = ""
_room: str = ""
_webhook_url: str = ""


def configure(token: str, room: str, webhook_url: str):
    global _token, _room, _webhook_url
    _token = token
    _room = room
    _webhook_url = webhook_url.rstrip("/")
    if _token and _webhook_url:
        _register_webhook()


def _headers():
    return {"Authorization": f"Bearer {_token}", "Content-Type": "application/json"}


def _register_webhook():
    """Ensure an attachmentActions webhook is registered pointing to this server."""
    target = f"{_webhook_url}/webex/webhook"
    try:
        r = requests.get(f"{WEBEX_API}/webhooks", headers=_headers(), timeout=10)
        r.raise_for_status()
        existing = r.json().get("items", [])
        for wh in existing:
            if wh.get("resource") == "attachmentActions" and wh.get("targetUrl") == target:
                return  # already registered
        # Delete any stale attachmentActions webhooks pointing elsewhere
        for wh in existing:
            if wh.get("resource") == "attachmentActions":
                requests.delete(f"{WEBEX_API}/webhooks/{wh['id']}", headers=_headers(), timeout=10)
        requests.post(
            f"{WEBEX_API}/webhooks",
            headers=_headers(),
            json={
                "name": "plumber-approvals",
                "targetUrl": target,
                "resource": "attachmentActions",
                "event": "created",
            },
            timeout=10,
        ).raise_for_status()
        log.info("Webex webhook registered: %s", target)
    except Exception as e:
        log.warning("Webex webhook registration failed: %s", e)


def _dest() -> dict:
    """Return roomId or toPersonEmail depending on what _room looks like."""
    if "@" in _room:
        return {"toPersonEmail": _room}
    return {"roomId": _room}


def _send(body: dict) -> str | None:
    """Send a message, return the message ID or None on failure."""
    if not _token or not _room:
        return None
    try:
        r = requests.post(f"{WEBEX_API}/messages", headers=_headers(), json=body, timeout=10)
        r.raise_for_status()
        return r.json().get("id")
    except Exception as e:
        log.warning("Webex send failed: %s", e)
        return None


def _ctx_rows(context: dict) -> list[dict]:
    rows = []
    for k, v in context.items():
        val = str(v) if not isinstance(v, (dict, list)) else __import__("json").dumps(v)
        rows.append({
            "type": "ColumnSet",
            "columns": [
                {"type": "Column", "width": "auto", "items": [{"type": "TextBlock", "text": k, "weight": "Bolder", "size": "Small", "color": "Accent"}]},
                {"type": "Column", "width": "stretch", "items": [{"type": "TextBlock", "text": val, "wrap": True, "size": "Small", "fontType": "Monospace"}]},
            ],
        })
    return rows


# ---------------------------------------------------------------------------
# Approval request (with Approve / Reject buttons)
# ---------------------------------------------------------------------------

def send_approval(approval_id: str, action: str, context: dict):
    if not _token:
        return

    if action == "open_pr":
        _send_pr_approval(approval_id, context)
        return
    if action == "jenkins_trigger":
        _send_jenkins_approval(approval_id, context)
        return

    badge_color = "Warning" if action.startswith("git") else "Accent"
    label = action.replace("_", " ").title()

    card: dict[str, Any] = {
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.3",
        "body": [
            {
                "type": "TextBlock",
                "text": f"Approval required: **{label}**",
                "wrap": True,
                "size": "Medium",
                "weight": "Bolder",
                "color": badge_color,
            },
            *_ctx_rows(context),
        ],
        "actions": [
            {"type": "Action.Submit", "title": "Approve", "data": {"plumber_action": "approve", "approval_id": approval_id}, "style": "positive"},
            {"type": "Action.Submit", "title": "Reject",  "data": {"plumber_action": "reject",  "approval_id": approval_id}, "style": "destructive"},
        ],
    }
    _send({**_dest(), "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": card}], "text": f"Approval required: {label}"})


def _send_pr_approval(approval_id: str, ctx: dict):
    body_preview = (ctx.get("body") or "")[:500]
    card: dict[str, Any] = {
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.3",
        "body": [
            {"type": "TextBlock", "text": "Open PR (draft)", "weight": "Bolder", "size": "Medium", "color": "Good"},
            {"type": "ColumnSet", "columns": [
                {"type": "Column", "width": "auto", "items": [{"type": "TextBlock", "text": "Repo", "weight": "Bolder", "size": "Small", "color": "Accent"}]},
                {"type": "Column", "width": "stretch", "items": [{"type": "TextBlock", "text": ctx.get("repo", ""), "size": "Small", "fontType": "Monospace", "wrap": True}]},
            ]},
            {"type": "ColumnSet", "columns": [
                {"type": "Column", "width": "auto", "items": [{"type": "TextBlock", "text": "Branch", "weight": "Bolder", "size": "Small", "color": "Accent"}]},
                {"type": "Column", "width": "stretch", "items": [{"type": "TextBlock", "text": f"{ctx.get('head', '')} \u2192 {ctx.get('base', '')}", "size": "Small", "fontType": "Monospace"}]},
            ]},
            {"type": "TextBlock", "text": ctx.get("title", ""), "weight": "Bolder", "wrap": True},
            *(
                [{"type": "TextBlock", "text": body_preview, "wrap": True, "size": "Small", "maxLines": 8}]
                if body_preview else []
            ),
        ],
        "actions": [
            {"type": "Action.Submit", "title": "Approve & Create PR", "data": {"plumber_action": "approve", "approval_id": approval_id}, "style": "positive"},
            {"type": "Action.Submit", "title": "Reject", "data": {"plumber_action": "reject", "approval_id": approval_id}, "style": "destructive"},
        ],
    }
    _send({**_dest(), "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": card}], "text": f"PR approval: {ctx.get('title', '')}"})


def _send_jenkins_approval(approval_id: str, ctx: dict):
    params = ctx.get("params") or {}
    param_rows = [
        {
            "type": "ColumnSet",
            "columns": [
                {"type": "Column", "width": "auto", "items": [{"type": "TextBlock", "text": k, "weight": "Bolder", "size": "Small", "color": "Accent"}]},
                {"type": "Column", "width": "stretch", "items": [{"type": "TextBlock", "text": str(v), "wrap": True, "size": "Small", "fontType": "Monospace"}]},
            ],
        }
        for k, v in params.items()
    ] if params else [{"type": "TextBlock", "text": "(no parameters)", "size": "Small", "color": "Light"}]

    card: dict[str, Any] = {
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.3",
        "body": [
            {"type": "TextBlock", "text": "Jenkins Trigger", "weight": "Bolder", "size": "Medium", "color": "Warning"},
            {"type": "ColumnSet", "columns": [
                {"type": "Column", "width": "auto", "items": [{"type": "TextBlock", "text": "Job", "weight": "Bolder", "size": "Small", "color": "Accent"}]},
                {"type": "Column", "width": "stretch", "items": [{"type": "TextBlock", "text": ctx.get("job", ""), "size": "Small", "fontType": "Monospace", "wrap": True}]},
            ]},
            {"type": "TextBlock", "text": "Parameters", "weight": "Bolder", "size": "Small", "spacing": "Medium"},
            *param_rows,
        ],
        "actions": [
            {"type": "Action.Submit", "title": "Approve", "data": {"plumber_action": "approve", "approval_id": approval_id}, "style": "positive"},
            {"type": "Action.Submit", "title": "Reject",  "data": {"plumber_action": "reject",  "approval_id": approval_id}, "style": "destructive"},
        ],
    }
    _send({**_dest(), "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": card}], "text": f"Jenkins trigger approval: {ctx.get('job', '')}"})


# ---------------------------------------------------------------------------
# Status update
# ---------------------------------------------------------------------------

def send_status(summary: str, pct: int, task_id: str | None, tasks: list[dict]):
    if not _token:
        return
    task_name = ""
    if task_id:
        t = next((t for t in tasks if t["id"] == task_id), None)
        if t:
            task_name = t.get("name") or t.get("jira_us") or task_id

    bar_filled = int(pct / 5)  # 20-block bar
    bar = "█" * bar_filled + "░" * (20 - bar_filled)

    lines = [f"**{pct}%** {bar}"]
    if task_name:
        lines.append(f"Task: {task_name}")
    lines.append(summary)

    _send({**_dest(), "markdown": "\n\n".join(lines)})


# ---------------------------------------------------------------------------
# Value / choice requests (no buttons - user replies don't feed back here)
# ---------------------------------------------------------------------------

def send_input_request(prompt: str, task_id: str | None, tasks: list[dict]):
    if not _token:
        return
    task_name = ""
    if task_id:
        t = next((t for t in tasks if t["id"] == task_id), None)
        if t:
            task_name = t.get("name") or ""
    header = f"Input required" + (f" - {task_name}" if task_name else "")
    _send({**_dest(), "markdown": f"**{header}**\n\n{prompt}\n\n_Respond in the dashboard._"})


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
    _send({**_dest(), "markdown": f"**{header}**\n\n{prompt}\n\n{opts_text}\n\n_Select in the dashboard._"})
