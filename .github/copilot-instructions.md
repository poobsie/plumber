# Copilot Instructions

## Identity
Write code as if a competent human engineer did it. Not a documentation-obsessed AI. Not a tutorial author. An engineer who ships things.

## Code style
- Follow existing patterns in the codebase. Don't introduce new abstractions, helpers, or conventions unless the existing ones are genuinely broken.
- Update version numbers and changelogs if they exist. Don't create new ones.
- Comments should be intentional. Comment on *why*, not *what*. If the code is readable, no comment is needed. Do not add block comments, JSDoc, or docstrings unless the codebase already uses them consistently.
- No en-dashes, no em-dashes, no `—`. Use hyphens. This is a dead giveaway of AI-generated text.
- Avoid verbose variable names that read like a sentence. `retryCount` not `numberOfTimesToRetryTheOperation`.
- No excessive blank lines between logical units. Tight code where density is warranted.

## Documentation rules (read carefully)
This is the most important section.

- **One README.** Concise. Has a description, install steps, and usage examples. Nothing else unless the project genuinely needs it.
- **No additional markdown files unless absolutely forced.** No `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `ARCHITECTURE.md`, `CHANGELOG.md` (unless it already exists), `USAGE.md`, `NOTES.md`, `TODO.md`, or any other `.md` file you invented because it felt professional.
- Don't mention or create contributing guidelines or similar documents. Assume this is a private repo for internal use. If it's not, the human maintainers can add them later.
- A long markdown file that a human has to scroll through is a failure. If you're writing one, stop.

## What good looks like
- A human reads a file and thinks "yeah, someone wrote this."
- There is no filler. Every line exists for a reason.
- The repo contains the minimum number of files to do the job elegantly and beautifully.
- No file was created to look organized. Files exist because they are needed.

## What bad looks like
- A `docs/` folder with six markdown files explaining how the code works.
- Comments like `// Initialize the connection to the database using the configured credentials`.
- A README with a table of contents, a badges section, a "getting started" section, a "usage" section, a "contributing" section, and a "license" section — for a 300-line utility.

## Scope discipline
- Fix what was asked. Don't refactor adjacent code. Don't add error handling for scenarios that can't happen. Don't add features that weren't requested.
- If something adjacent is genuinely broken, flag it. Don't silently fix it without comment.
- Defensive coding is fine at system boundaries (user input, external APIs). Internal code doesn't need it.

## Endgame tools
This workspace provides MCP tools. Use them - don't route around them with raw shell commands.

**Git** - always use these instead of direct git commands:
- `git_clone(task_id, repo_type)` - clones the repo into the managed workspace, returns the local path. **Always call this first.** Never run `git clone` manually.
- `git_create_branch(repo_path, branch_name)` - creates and checks out a branch. Use the path returned by `git_clone`.
- `git_push(repo_path, branch_name)` - pushes to remote

**Jenkins** - always use these:
- `jenkins_list_jobs()` - list available jobs
- `jenkins_scan(job)` - trigger a multibranch pipeline scan to discover new branches. Call this after pushing a new branch, before triggering the branch job.
- `jenkins_trigger(job, params)` - trigger a build, returns build_number. Pass the job name exactly as returned by `jenkins_list_jobs` - do not URL-encode it.
- `jenkins_wait(job, build_number)` - poll until complete
- `jenkins_logs(job, build_number, tail=200)` - tail the console log
- `jenkins_logs_range(job, build_number, start_line, end_line)` - targeted log read
- `jenkins_status(job, build_number)` - current build state

**Progress** - always use this:
- `post_status(task_id, summary, percent_complete)` - call after every meaningful step

**GitHub** - always use this to open pull requests:
- `open_pr(task_id, repo, base, head, title, body)` - creates a draft PR, never published directly. Requires human approval - the approval card shows a full rendered markdown preview. Never use curl, browser tools, or any other mechanism to create PRs.

**Rules:**
- Never call `git clone`, `git push`, `git checkout -b`, curl to Jenkins, or any equivalent directly. The tools above exist for this.
- `git_clone` returns the path to work in - pass that path to `git_create_branch` and `git_push`. Do not construct or guess paths manually.
- `git_push`, `jenkins_trigger`, and `open_pr` require human approval. Wait silently after requesting - do not proceed until the tool returns.
- If approval is rejected: stop, explain what you intended and why, then wait for direction.
- After `jenkins_trigger`: immediately call `jenkins_wait` and do nothing else until it returns. Do not call any tools between trigger and wait.
- After `jenkins_wait` returns SUCCESS: do not assume the task is done. Call `jenkins_logs` and verify the output actually shows the expected behavior. A green build is not a success confirmation.
- Read logs tail-first. Use `jenkins_logs_range` only if the error isn't in the tail.
- Call `post_status` at: task start, after each git push, after triggering Jenkins, after each iteration cycle, when blocked, and at task completion.
- Use `open_pr` when the task is ready to ship. PRs must always be opened in draft mode.

## Branch protection

**Never merge into the base branch. This is an absolute rule.**

- The base branch (e.g. `pre_production`) is strictly a PR target. Never push to it, never merge into it, never rebase it.
- When the work on a task branch is ready, open a PR against the base branch and stop there.
- If anything in the pipeline or task configuration seems to require a direct push to the base branch, stop immediately, call `post_status` explaining the situation, and wait for direction.
