import os
import re
import requests

_BASE = "https://api.github.com"
_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

_authed_user = None


def _token():
    return os.getenv("GITHUB_TOKEN", "")


def _get(path, params=None):
    tok = _token()
    if not tok:
        raise RuntimeError("GITHUB_TOKEN not set")
    r = requests.get(
        f"{_BASE}{path}",
        params=params,
        headers={**_HEADERS, "Authorization": f"Bearer {tok}"},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def get_authed_user() -> dict:
    global _authed_user
    if _authed_user is None:
        _authed_user = _get("/user")
    return _authed_user


def repo_from_url(url: str) -> str:
    """Extract 'owner/repo' from a GitHub clone or web URL."""
    url = url.rstrip("/").removesuffix(".git")
    m = re.search(r"github\.com[/:](.+/.+)$", url)
    if not m:
        raise ValueError(f"Cannot parse GitHub repo from URL: {url}")
    return m.group(1)


def get_open_prs_by_user(username: str, repo: str = None) -> list:
    """Return all open PRs (including drafts) authored by username, optionally filtered to one repo."""
    query = f"is:pr is:open author:{username}"
    if repo:
        query += f" repo:{repo}"
    results = []
    page = 1
    while True:
        data = _get("/search/issues", {"q": query, "per_page": 100, "page": page})
        items = data.get("items", [])
        results.extend(items)
        if len(items) < 100:
            break
        page += 1
    return results


def get_pr(repo: str, number: int) -> dict:
    return _get(f"/repos/{repo}/pulls/{number}")


def get_pr_files(repo: str, number: int) -> list:
    files = []
    page = 1
    while True:
        data = _get(f"/repos/{repo}/pulls/{number}/files", {"per_page": 100, "page": page})
        files.extend(data)
        if len(data) < 100:
            break
        page += 1
    return files


def get_pr_comments(repo: str, number: int) -> list:
    comments = []
    page = 1
    while True:
        data = _get(f"/repos/{repo}/pulls/{number}/comments", {"per_page": 100, "page": page})
        comments.extend(data)
        if len(data) < 100:
            break
        page += 1
    return comments


def get_pr_reviews(repo: str, number: int) -> list:
    return _get(f"/repos/{repo}/pulls/{number}/reviews")
