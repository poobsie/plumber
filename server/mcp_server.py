import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
import requests

load_dotenv(Path(__file__).parent.parent / ".env")

DASHBOARD = os.getenv("DASHBOARD_URL", "http://localhost:8755")
JENKINS_URL = os.getenv("JENKINS_URL", "")
JENKINS_USER = os.getenv("JENKINS_USERNAME", "")
JENKINS_TOKEN = os.getenv("JENKINS_API_TOKEN", "")

WORKSPACE_ROOT = Path(__file__).parent.parent / "workspace"

# Branches the agent must never push to or create directly.
# Override via env: PROTECTED_BRANCHES=main,master,pre_production,production
_default_protected = {"main", "master", "pre_production", "production", "develop", "dev"}
_env_protected = os.getenv("PROTECTED_BRANCHES", "")
PROTECTED_BRANCHES: set[str] = (
    {b.strip() for b in _env_protected.split(",") if b.strip()}
    if _env_protected else _default_protected
)

# 605s client timeout - slightly longer than server's 600s to let the server respond first
APPROVAL_TIMEOUT = 605

mcp = FastMCP("plumber")


def _approve(action: str, context: dict) -> bool:
    try:
        resp = requests.post(
            f"{DASHBOARD}/approval/request",
            json={"action": action, "context": context},
            timeout=APPROVAL_TIMEOUT,
        )
        return resp.json().get("approved", False)
    except requests.Timeout:
        return False
    except Exception:
        return False


def _jenkins():
    from jenkins import Jenkins
    return Jenkins(JENKINS_URL, JENKINS_USER, JENKINS_TOKEN)


def _git(args: list, cwd: str, timeout: int = 60) -> tuple:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
    try:
        r = subprocess.run(
            ["git"] + args, cwd=cwd, capture_output=True, text=True,
            timeout=timeout, env=env, stdin=subprocess.DEVNULL,
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return 1, "", f"git {args[0]} timed out after {timeout}s"
    except Exception as e:
        return 1, "", str(e)


@mcp.tool()
def git_clone(task_id: str, repo_type: str) -> str:
    """Clone a task's repo into an isolated workspace directory. Call this first before any git operations.
    repo_type: 'code' or 'pipeline'. Returns the local path to work in."""
    def log(msg):
        print(f"[git_clone] {msg}", file=sys.stderr, flush=True)

    try:
        resp = requests.get(f"{DASHBOARD}/tasks/{task_id}", timeout=10)
        resp.raise_for_status()
        task = resp.json()
    except Exception as e:
        return f"ERROR: could not fetch task: {e}"

    if repo_type == "code":
        url = task.get("code_repo", "")
    elif repo_type == "pipeline":
        url = task.get("pipeline_repo", "")
        if not url:
            return "ERROR: this task has no separate pipeline repo (pipeline is in code repo or Jenkins)"
    else:
        return "ERROR: repo_type must be 'code' or 'pipeline'"

    if not url:
        return f"ERROR: task has no URL for repo_type '{repo_type}'"

    dest = WORKSPACE_ROOT / task_id / repo_type
    dest.mkdir(parents=True, exist_ok=True)
    base = task.get("base_branch", "pre_production")

    if (dest / ".git").exists():
        log("already cloned, fetching latest remote refs")
        _git(["fetch", "--prune", "origin"], str(dest), timeout=60)
        # Reset any uncommitted state and check out base branch if it exists remotely
        log(f"checking if {base} exists remotely")
        rc, out, _ = _git(["ls-remote", "--heads", "origin", base], str(dest))
        if rc == 0 and base in out:
            log(f"checking out {base}")
            _git(["checkout", base], str(dest))
            _git(["pull", "--ff-only", "origin", base], str(dest))
        else:
            log(f"{base} not found remotely, staying on current branch")
        return str(dest)

    log(f"cloning {url}")
    code, out, err = _git(["clone", url, "."], str(dest), timeout=120)
    if code != 0:
        return f"ERROR: clone failed: {err}"
    log("clone complete")

    # Only checkout base if it exists as a remote branch
    log(f"checking if {base} exists remotely")
    rc, out, _ = _git(["ls-remote", "--heads", "origin", base], str(dest))
    if rc == 0 and base in out:
        log(f"checking out {base}")
        _git(["checkout", base], str(dest))
    else:
        log(f"{base} not found remotely, staying on default branch")

    log("returning path")
    return str(dest)


@mcp.tool()
def git_create_branch(repo_path: str, branch_name: str) -> str:
    """Create and checkout a new git branch. Requires human approval."""
    if branch_name in PROTECTED_BRANCHES:
        return f"BLOCKED: '{branch_name}' is a protected branch. Creating or checking out protected branches directly is not allowed. Use a feature branch and open a PR."
    print(f"[git_create_branch] waiting for approval: {branch_name} in {repo_path}", file=sys.stderr, flush=True)
    # Check for existing local or remote branch before asking for approval
    _, local_out, _ = _git(["branch", "--list", branch_name], repo_path)
    branch_exists_locally = bool(local_out.strip())

    _git(["fetch", "--prune", "origin"], repo_path, timeout=60)
    _, remote_out, _ = _git(["ls-remote", "--heads", "origin", branch_name], repo_path)
    branch_exists_remotely = branch_name in remote_out

    if not _approve("git_create_branch", {"repo": repo_path, "branch": branch_name,
                                           "already_exists_locally": branch_exists_locally,
                                           "already_exists_remotely": branch_exists_remotely}):
        return "REJECTED: User declined or approval timed out. Stop and explain what you were trying to do."

    print(f"[git_create_branch] approved, branch_exists_locally={branch_exists_locally} branch_exists_remotely={branch_exists_remotely}", file=sys.stderr, flush=True)

    if branch_exists_locally:
        code, out, err = _git(["checkout", branch_name], repo_path)
    elif branch_exists_remotely:
        code, out, err = _git(["checkout", "--track", f"origin/{branch_name}"], repo_path)
    else:
        code, out, err = _git(["checkout", "-b", branch_name], repo_path)

    print(f"[git_create_branch] done: code={code} err={err}", file=sys.stderr, flush=True)
    if code != 0:
        return f"ERROR: {err}"
    if branch_exists_locally:
        return f"Checked out existing local branch '{branch_name}' in {repo_path}"
    if branch_exists_remotely:
        return f"Checked out existing remote branch '{branch_name}' (tracking origin) in {repo_path}"
    return f"Created branch '{branch_name}' in {repo_path}"


@mcp.tool()
def git_push(repo_path: str, branch_name: str, remote: str = "origin") -> str:
    """Push a local branch to remote. Requires human approval."""
    if branch_name in PROTECTED_BRANCHES:
        return f"BLOCKED: '{branch_name}' is a protected branch. Pushing directly to protected branches is not allowed. Open a PR instead."
    print(f"[git_push] waiting for approval: {branch_name}", file=sys.stderr, flush=True)
    if not _approve("git_push", {"repo": repo_path, "branch": branch_name, "remote": remote}):
        return "REJECTED: User declined or approval timed out. Stop and explain what you were trying to do."
    print(f"[git_push] approved, pushing", file=sys.stderr, flush=True)
    code, out, err = _git(["push", "-u", remote, branch_name], repo_path)
    print(f"[git_push] done: code={code} err={err}", file=sys.stderr, flush=True)
    if code != 0:
        return f"ERROR: {err}"
    return f"Pushed '{branch_name}' to {remote}"


@mcp.tool()
def jenkins_scan(job: str) -> str:
    """Trigger a multibranch pipeline scan so Jenkins discovers new/deleted branches.
    Call this after pushing a new branch, before trying to trigger the branch job.
    Requires human approval - scanning kicks off builds for every branch Jenkins finds."""
    if not _approve("jenkins_scan", {"job": job}):
        return "Scan rejected."
    try:
        j = _jenkins()
        url = f"{j.url}{j._job_url(job)}/build?delay=0"
        r = j.session.post(url, timeout=15)
        if r.status_code in (200, 201, 302):
            return f"Scan triggered for '{job}'. Wait ~10-15s then call jenkins_list_jobs to confirm the branch job appears."
        return f"ERROR: scan returned HTTP {r.status_code}"
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def jenkins_list_jobs() -> str:
    """List all Jenkins jobs. No approval required."""
    try:
        return json.dumps(_jenkins().list_jobs())
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def jenkins_get_params(job: str) -> str:
    """Fetch the parameter definitions for a Jenkins job. Returns each parameter's name,
    default value, description, and type. Call this before jenkins_trigger so you know
    exactly what parameters the job accepts and can set them correctly."""
    try:
        info = _jenkins().get_job_info(job)
        return json.dumps(info["params"])
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def jenkins_trigger(job: str, params: dict) -> str:
    """Trigger a Jenkins build with parameters. Requires human approval. Returns build_number."""
    if not _approve("jenkins_trigger", {"job": job, "params": params}):
        return "REJECTED: User declined or approval timed out. Stop and explain what you were trying to do."
    try:
        j = _jenkins()
        build_number = j.trigger_build(job, params)
        try:
            requests.post(
                f"{DASHBOARD}/build",
                json={"job": job, "build_number": build_number, "status": "running", "params": params},
                timeout=5,
            )
        except Exception:
            pass
        return json.dumps({"build_number": build_number, "job": job})
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def jenkins_status(job: str, build_number: int) -> str:
    """Get current status of a Jenkins build. No approval required."""
    try:
        return json.dumps(_jenkins().get_status(job, build_number))
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def jenkins_logs(job: str, build_number: int, tail: int = 200) -> str:
    """Get the last N lines of a Jenkins build log. Default tail=200. Always read this before assuming a build succeeded or failed."""
    try:
        return _jenkins().get_logs(job, build_number, tail)
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def jenkins_logs_range(job: str, build_number: int, start_line: int, end_line: int) -> str:
    """Get a specific line range from a Jenkins build log. Use when the tail doesn't contain the error."""
    try:
        return _jenkins().get_logs_range(job, build_number, start_line, end_line)
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def jenkins_wait(job: str, build_number: int, timeout_seconds: int = 3600) -> str:
    """Block until a Jenkins build completes or times out. MUST be called after every
    jenkins_trigger before doing anything else. Returns final status dict with 'result'
    (SUCCESS/FAILURE/ABORTED) and 'timed_out'. If timed_out is true, stop and alert the user."""
    try:
        j = _jenkins()
        result = j.wait_for_build(job, build_number, timeout_seconds)
        final_status = result.get("result") or ("timed_out" if result.get("timed_out") else "unknown")
        try:
            requests.post(
                f"{DASHBOARD}/build",
                json={"job": job, "build_number": build_number, "status": final_status},
                timeout=5,
            )
        except Exception:
            pass
        return json.dumps(result)
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def post_status(task_id: str, summary: str, percent_complete: int) -> str:
    """Report current progress to the dashboard. Call after every significant step.
    task_id: the task ID from the task prompt (links status to the task card).
    summary: 1-2 sentences on what you just did and what's next.
    percent_complete: honest estimate 0-100."""
    try:
        requests.post(
            f"{DASHBOARD}/status",
            json={"summary": summary, "percent_complete": percent_complete, "task_id": task_id},
            timeout=5,
        )
    except Exception:
        pass
    return "Status reported."


@mcp.tool()
def request_value(task_id: str, prompt: str) -> str:
    """Request a sensitive value from the user via the dashboard (e.g. an API token or credential
    needed as a pipeline parameter). Blocks until the user submits or cancels.
    Returns the value string, or an error message if cancelled/timed out.
    Use this instead of hardcoding secrets or asking the user in chat."""
    try:
        resp = requests.post(
            f"{DASHBOARD}/value/request",
            json={"prompt": prompt, "task_id": task_id},
            timeout=APPROVAL_TIMEOUT,
        )
        result = resp.json()
        value = result.get("value")
        if value is None:
            return f"CANCELLED: User did not provide a value ({result.get('reason', 'unknown')})."
        return value
    except requests.Timeout:
        return "TIMEOUT: User did not respond in time."
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def request_choice(task_id: str, prompt: str, options: list[str]) -> str:
    """Present the user with a multiple-choice question via the dashboard and return the chosen option.
    Use when a pipeline parameter (or any decision) has a known finite set of valid values and you
    cannot determine the correct one from context alone.
    options: list of strings the user can pick from.
    Blocks until the user selects an option or cancels. Returns the chosen string, or an error."""
    try:
        resp = requests.post(
            f"{DASHBOARD}/choice/request",
            json={"prompt": prompt, "options": options, "task_id": task_id},
            timeout=APPROVAL_TIMEOUT,
        )
        result = resp.json()
        value = result.get("value")
        if value is None:
            return f"CANCELLED: User did not select an option ({result.get('reason', 'unknown')})."
        return value
    except requests.Timeout:
        return "TIMEOUT: User did not respond in time."
    except Exception as e:
        return f"ERROR: {e}"


@mcp.tool()
def open_pr(task_id: str, repo: str, base: str, head: str, title: str, body: str) -> str:
    """Open a draft pull request on GitHub. ALWAYS creates in draft mode - never publish directly.
    Requires human approval which shows a full markdown preview of the PR.
    task_id: the task ID (used to link the PR URL back to the task card).
    repo: owner/repo format, e.g. "acme/my-service". Do not URL-encode.
    base: the target branch, e.g. "pre_production".
    head: the feature branch to open the PR from.
    title: PR title. If the task has a jira_us number, prefix it: "LS-1800: Add new themes".
    body: PR description in markdown. Requirements:
      - First line: one sentence summarising what this PR does.
      - ## Problem: what was broken or missing. Be specific. 1-3 sentences.
      - ## Solution: what you changed and why you chose that approach.
      - ## Before / After: concrete examples using code blocks or command output.
        Show actual behaviour difference - not just "it didn't work, now it does".
      - Keep it tight. Omit sections that add no value. No filler, no compliments.
      - Prefer prose over bullet-point lists.
    """
    if not _approve("open_pr", {"repo": repo, "base": base, "head": head, "title": title, "body": body}):
        return "REJECTED: User declined or approval timed out. Stop and explain what you were trying to do."
    token = os.getenv("GITHUB_TOKEN", "")
    if not token:
        return "ERROR: GITHUB_TOKEN not set in .env"
    try:
        r = requests.post(
            f"https://api.github.com/repos/{repo}/pulls",
            json={"title": title, "body": body, "head": head, "base": base, "draft": True},
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=20,
        )
        if r.status_code not in (200, 201):
            return f"ERROR: GitHub API returned {r.status_code}: {r.text[:500]}"
        pr = r.json()
        pr_url = pr.get("html_url", "")
        pr_number = pr.get("number", 0)
        try:
            requests.patch(
                f"{DASHBOARD}/tasks/{task_id}",
                json={"pr_url": pr_url, "pr_number": pr_number},
                timeout=5,
            )
        except Exception:
            pass
        return json.dumps({"pr_url": pr_url, "pr_number": pr_number})
    except Exception as e:
        return f"ERROR: {e}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
