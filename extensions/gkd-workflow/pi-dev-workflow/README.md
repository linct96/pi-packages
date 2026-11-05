# pi-dev-workflow v0.2.0 (prototype)

A Pi Package containing a Skill and an Extension to run bounded FAST / STANDARD development workflows.

## Progressive activation

**Default: manual only.** Installation does not intercept normal user prompts.

```text
/develop Fix the button loading state
/develop --fast Fix a small validation bug
/develop --standard Implement PR #123

/develop-settings             # interactive extension settings menu
/develop-settings auto on     # global opt-in automatic activation
/develop-settings auto off    # global disable
/develop-settings status

/develop-status
/develop-approve
/develop-stop
/develop-resume
```

When enabled, a conservative actionable-development-intent gate intercepts direct user requests before normal agent processing. The agent then inspects the repository and reports **FAST** or **STANDARD** using `dev_workflow_report(kind="mode")`. General coding explanations or discussion pass through untouched. To limit false positives, ambiguous natural-language requests may be missed; use `/develop` for those. Never assume a simple keyword match determines architectural risk.

## Installation

Extract the ZIP and run `pi install ./pi-dev-workflow` from the parent directory; then `/reload` or restart. Works only in trusted Pi project contexts. In a task already waiting for approval use `/develop-approve`, not `/develop` again.

The extension settings are stored in `~/.pi/agent/dev-workflow/settings.json` (or `$PI_CODING_AGENT_DIR/dev-workflow/settings.json`), independent of Pi's built-in `/settings`. `/develop-settings` writes immediately; default is `{ "version": 1, "autoStart": false }`.

## Verification and security

Configure trusted per-project validators in `<project>/.pi/dev-workflow.config.json`, for example:

```json
{ "validators": ["pnpm lint", "pnpm test", "pnpm build"], "validationTimeoutMs": 120000 }
```

Completion without configured validators stops at `review_required`, not `completed`. The controller runs validator commands in the trusted project with user shell permissions. Repeated validation failure (3 attempts) or reaching the maximum agent iterations halts the loop.

STANDARD requires the existing PR/MR to be read where available, plan generation and explicit `/develop-approve` before implementation. It never silently creates/merges/pushes PRs, force-pushes, deploys, or makes destructive changes. FAST does not create PR/plan files. Plan templates are included in the Skill. State is stored in `<project>/.pi/dev-workflow/state.json`.

## Known limitations

Prototype; not tested end-to-end with authenticated Pi and GitHub/GitLab. Auto intent detection is deliberately conservative and may be wrong or miss natural-language requests. Use a separate Git worktree and review validator shell commands. Disabling auto-start only prevents new auto starts; `/develop-stop` stops a running workflow.

See `README.zh-CN.md` for full Chinese guidance.
