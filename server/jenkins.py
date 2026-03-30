import time
import requests


class Jenkins:
    def __init__(self, url: str, username: str, token: str):
        self.url = url.rstrip("/")
        self.session = requests.Session()
        self.session.auth = (username, token)

    def _crumb(self) -> dict:
        try:
            r = self.session.get(f"{self.url}/crumbIssuer/api/json", timeout=10)
            if r.ok:
                d = r.json()
                return {d["crumbRequestField"]: d["crumb"]}
        except Exception:
            pass
        return {}

    def _job_url(self, job: str) -> str:
        # "parent/branch" -> "/job/parent/job/branch"  (handles multibranch paths)
        # encode # in branch names so the URL is valid
        from urllib.parse import quote
        parts = job.split("/")
        return "/" + "/".join(f"job/{quote(p, safe='')}" for p in parts)

    def get_job_info(self, job: str) -> dict:
        tree = "_class,property[parameterDefinitions[name,defaultParameterValue[value],description,type]]"
        r = self.session.get(f"{self.url}{self._job_url(job)}/api/json", params={"tree": tree}, timeout=10)
        r.raise_for_status()
        d = r.json()
        is_multibranch = "MultiBranch" in d.get("_class", "")
        params = []
        for prop in d.get("property", []):
            for p in prop.get("parameterDefinitions", []):
                params.append({
                    "name": p["name"],
                    "default": (p.get("defaultParameterValue") or {}).get("value", ""),
                    "description": p.get("description", ""),
                    "type": p.get("type", "StringParameterDefinition"),
                })
        return {"is_multibranch": is_multibranch, "params": params}

    def trigger_build(self, job: str, params: dict) -> int:
        crumb = self._crumb()
        # try buildWithParameters first; fall back to /build for parameterless jobs
        resp = self.session.post(
            f"{self.url}{self._job_url(job)}/buildWithParameters",
            params=params or None,
            headers=crumb,
            timeout=30,
        )
        if resp.status_code == 400 and not params:
            resp = self.session.post(
                f"{self.url}{self._job_url(job)}/build",
                headers=crumb,
                timeout=30,
            )
        resp.raise_for_status()
        queue_url = resp.headers["Location"].rstrip("/") + "/api/json"
        # Poll queue until build number is assigned
        for _ in range(30):
            time.sleep(2)
            q = self.session.get(queue_url, timeout=10).json()
            if q.get("executable"):
                return q["executable"]["number"]
        raise TimeoutError("Build never left the queue after 60s")

    def get_status(self, job: str, build: int) -> dict:
        r = self.session.get(f"{self.url}{self._job_url(job)}/{build}/api/json", timeout=10)
        r.raise_for_status()
        d = r.json()
        return {
            "building": d.get("building", False),
            "result": d.get("result"),
            "duration_ms": d.get("duration", 0),
            "url": d.get("url", ""),
        }

    def get_logs(self, job: str, build: int, tail: int = 200) -> str:
        # Fetch only the last ~100KB to avoid blowing context on huge logs
        size_resp = self.session.get(
            f"{self.url}{self._job_url(job)}/{build}/logText/progressiveText",
            params={"start": 0},
            timeout=30,
        )
        total = int(size_resp.headers.get("X-Text-Size", 0))
        start = max(0, total - 100_000)
        resp = self.session.get(
            f"{self.url}{self._job_url(job)}/{build}/logText/progressiveText",
            params={"start": start},
            timeout=30,
        )
        lines = resp.text.splitlines()
        return "\n".join(lines[-tail:])

    def get_logs_range(self, job: str, build: int, start_line: int, end_line: int) -> str:
        resp = self.session.get(
            f"{self.url}{self._job_url(job)}/{build}/consoleText", timeout=60
        )
        lines = resp.text.splitlines()
        return "\n".join(lines[start_line:end_line])

    def wait_for_build(self, job: str, build: int, timeout_seconds: int = 3600) -> dict:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            status = self.get_status(job, build)
            if not status["building"]:
                return status
            time.sleep(15)
        return {"building": True, "result": None, "timed_out": True}

    def list_jobs(self) -> list:
        r = self.session.get(f"{self.url}/api/json?tree=jobs[name]", timeout=10)
        r.raise_for_status()
        return [j["name"] for j in r.json().get("jobs", [])]
