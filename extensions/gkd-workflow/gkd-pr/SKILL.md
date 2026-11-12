---
name: gkd-pr
description: After GKD judge-route classifies development as FAST or STANDARD and changes are ready, generate a matching PR/MR description and create or update a GitHub pull request or GitLab merge request if authenticated tooling and a suitable Git remote are available. Also handle explicit PR/MR requests for existing commits; never publish during route debugging.
---

# GKD PR / MR publishing

Use the **evidence-backed route** selected through the gkd-workloop Skill, not a guess from the task text or an assumed plugin result. FAST uses `references/FAST.md`; STANDARD uses `references/STANDARD.md`. Load only the corresponding template. Work occurs **after** implementation and attempted verification, never inside the read-only judge-route stage.

## Determine eligibility

- NONE: do not publish. DIRECT: only create a PR/MR if the user explicitly requested it for existing changes; do not treat a plain commit or push as a PR request.
- For GKD FAST/STANDARD development, attempt to publish task-related commits only when permitted, without an opt-out, and when an authenticated writable GitHub/GitLab remote exists.
- Inspect `git status --short`, `git branch --show-current`, `git remote -v`, tracking branch, merge base, commits and complete diff relative to the verified target branch. Confirm there is an actual task-related difference. Do not invent a target branch such as main; resolve the remote default branch.
- Detect the platform from the verified remote host, not from repository names. Respect GitHub Enterprise, GitLab self-hosted and SSH remotes. If multiple remotes/projects are ambiguous, ask before publishing; never publish twice.
- Do not include unrelated files, secrets, credentials, or unreviewed changes. Avoid indiscriminate `git add -A`, force-push, destructive cleanup, bypassing hooks or rewriting unrelated history. For a branch equal to the target, create a topic branch before committing; do not silently push to protected branches.
- A remote URL does not imply authentication or write permissions. Use an available authenticated integration, `gh` for GitHub or `glab` for GitLab. No automatic CLI installation or credentials setup. If no publishing tool is available, leave changes local and report why.

## Describe and publish

- Verify the correct source/target and review the actual diff, test output and commit scope. Confirm before high-risk publication, unexpected public exposure or ambiguous content. STANDARD obeys any prior plan/approval gates.
- Read the matching template. Replace placeholders with factual content, explicitly mark unknowns, and check only tests that actually passed. For STANDARD include concrete escalation evidence, design alternatives, tradeoffs and appropriate migration/rollback.
- Check for an existing open PR/MR from this source into this target before creating one. Update if appropriate; do not duplicate. For work in progress, especially STANDARD, use Draft.
- Prefer authenticated provider integrations if available and capable. With installed local CLIs, write the description into a temporary UTF-8 file outside the repository, then remove that file.

```sh
gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$body_file"
glab mr create --target-branch "$base" --source-branch "$branch" --title "$title" --description-file "$body_file" --push=false --yes
```

Use provider edit/update commands for an existing request. Push verified task commits only when appropriate. Do not merge without an explicit request. Never claim an operation succeeded based on a planned command alone.

## Report

Return the route, provider, source and target branch, confirmed PR/MR URL (or blocker), actual verification outcome and remaining risks.
