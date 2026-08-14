# Lessons Learned

In this file, we record recurring patterns, encountered issues, and mistakes to avoid when working with the Reorder plugin.
It should be reviewed at the start of a session and updated after fixing any bug or resolving a complex issue.

## Rules for AI Agents

### Repository Language Constraint

- **Rule**: All files, code comments, documentation, specs, lessons, and commit messages added or modified in the repository on GitHub MUST be written in English. Even if the user interacts with you in another language (e.g., Polish), do not write Polish code comments, skill files, specs, or repository files.
- **Context**: The repository codebase and its meta-configuration (like AI agents instructions) must maintain a unified English language standard.

### Git Commits and Push Approval

- **Rule**: Before proposing a commit or git push to GitHub, always construct a Conventional Commits message format: `type(scope): description` and present it to the user. Wait for the user's explicit approval before proceeding with the commit and push.
- **Context**: Helps the user audit and accept individual changes, ensuring only well-formed commits with correct scopes are pushed.

### Local Dev Server URLs

- **Rule**: Whenever starting the local Medusa backend dev server (via `local-dev` skill or scripts), always inspect the output logs for the running port and immediately provide the clickable local URLs (Backend API `http://localhost:<port>` and Admin Dashboard `http://localhost:<port>/app`) directly to the user.
- **Context**: Prevents leaving the user guessing where the dev server and admin panel are hosted when the process runs in the background.

### Mandatory Confirmation for Test Data Wipe

- **Rule**: NEVER execute destructive reset or test data wipe scripts (such as `scripts/wipe-test-data.ts` or `wipe-test-data` skill) immediately upon request. Always first explicitly warn the user that 100% of operational data (orders, customers, subscriptions, renewals, dunning, logs, analytics) will be permanently deleted, and wait for their explicit confirmation before proceeding.
- **Context**: Protects against accidental data loss when the user invokes a wipe command or mentions clearing data without realizing the full scope.

### Post-Push Docs Sync

- **Rule**: Whenever you push code to GitHub (e.g. after resolving an issue or implementing a feature), ALWAYS proactively ask the user: "Czy zmiany wymagają aktualizacji dokumentacji (wewnętrznej w reorder/docs lub publicznej Mintlify w ../docs)? Jeśli tak, użyję skilla `sync-docs`."
- **Context**: This ensures both internal technical docs (`reorder/docs/`) and the public documentation repository (`../docs`) stay in sync with codebase changes without the user having to remember it.

## General Lessons

* (No lessons recorded yet. Will be updated as issues arise.)
