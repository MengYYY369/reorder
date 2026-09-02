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

- **Rule**: Whenever starting the local Medusa backend and storefront dev servers (via `local-dev` skill or scripts), always inspect the output logs for the running ports and immediately provide the clickable local URLs:
  - **Medusa Backend API**: `http://localhost:9000`
  - **Medusa Admin Dashboard**: `http://localhost:9000/app`
  - **Medusa Storefront**: `http://localhost:8000`
  directly to the user.
- **Context**: Prevents leaving the user guessing where the dev server, admin panel, and storefront are hosted when processes run in the background.

### Mandatory Confirmation for Test Data Wipe

- **Rule**: NEVER execute destructive reset or test data wipe scripts (such as `scripts/wipe-test-data.ts` or `wipe-test-data` skill) immediately upon request. Always first explicitly warn the user that 100% of operational data (orders, customers, subscriptions, renewals, dunning, logs, analytics) will be permanently deleted, and wait for their explicit confirmation before proceeding.
- **Context**: Protects against accidental data loss when the user invokes a wipe command or mentions clearing data without realizing the full scope.

### Post-Push Docs Sync

- **Rule**: Whenever you push code to GitHub (e.g. after resolving an issue or implementing a feature), ALWAYS proactively ask the user: "Czy zmiany wymagają aktualizacji dokumentacji (wewnętrznej w reorder/docs lub publicznej Mintlify w ../docs)? Jeśli tak, użyję skilla `sync-docs`."
- **Context**: This ensures both internal technical docs (`reorder/docs/`) and the public documentation repository (`../docs`) stay in sync with codebase changes without the user having to remember it.

### Reseeding & Database Reset Invalidation Checklist

- **Rule**: Whenever performing a full database reset, schema drop, or `yarn seed`:
  1. **Recreate Admin User**: Medusa v2 `seed.ts` does not create an admin user by default. Always recreate the admin account (`yarn medusa user -e admin@medusa-test.com -p supersecret`).
  2. **Sync Publishable API Key**: A fresh seed generates a new `publishable_api_key` in the database. Always check/update `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` in the storefront's `.env.local` to match the newly generated key, and restart the storefront dev server.
  3. **Preserve Catalog Inventory**: In transactional data wipes (`wipe-test-data.ts`), never truncate `inventory_item` or catalog tables, as Medusa v2 requires inventory items and levels for cart item creation when `manage_inventory: true`.
- **Context**: Prevents 401 "Invalid email or password" admin login failures, 400 "A valid publishable key is required to proceed with the request" storefront errors, and 500 cart item creation failures.

## General Lessons

* **Stale Tool-Snapshot Reads**: File contents shown in system reminders or context summaries can be stale after subagents modify the working tree. Always verify actual file state with `grep`/`git status` before acting on a reminder-injected read (hit during the i18n branch: files shown as untranslated were already migrated).
* **Subagent Silent No-Op**: A dispatched subagent can return "completed" with empty output and zero working-tree changes (provider hiccup). Check `git status` before assuming failure, and prefer resuming the same agent via SendMessage before re-dispatching from scratch (hit during Plan 5 of the i18n branch).
* **Medusa 2.19 Typecheck Surfaces**: `medusa plugin:build` on 2.19 typechecks `scripts/` and module tests too. Hand-written narrow connection types (e.g. a custom `PgConnection`) can break on `whereIn`/`where` — resolve `ContainerRegistrationKeys.PG_CONNECTION` untyped instead of annotating a narrow type.
* **Translation Key Hygiene for Backend-Event Strings**: Strings that are backend contract values (e.g. dunning event types `dunning.started`, `dunning.recovered`) must never become translation keys; the contract test denylists them so the key-literal scan cannot confuse logic strings with copy.
* **Publishable API Key Mismatch**: If Storefront throws `Error: A valid publishable key is required to proceed with the request`, the key in `.env.local` (`NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`) is out of sync with the active key in the Medusa backend database (table `api_key` where `type = 'publishable'`).
* **Missing Inventory on Cart Line Items**: In Medusa v2, `addToCartWorkflow` checks inventory levels for all variants with `manage_inventory: true`. If `inventory_item` or `inventory_level` rows are missing, `POST /store/carts/:id/line-items` will fail with a 500 error.
* **Subscription MRR on First Billing Cycle**: Newly created subscriptions do not have a renewal cycle record yet (`latestRenewal` is null). Analytics daily snapshots must resolve the latest order from linked subscription orders (including the initial checkout order) rather than exclusively checking renewal cycles to avoid calculating MRR as unavailable or zero before the first renewal.
* **Analytics Daily Snapshot Order Resolution**: When resolving `latestOrderId` for daily metric snapshots, always prefer `latestRenewal.generated_order_id` (representing the most recent renewal order) and fallback to `latestOrderBySubscription` (representing initial order creation) so that both renewal-generated orders and initial orders are properly captured.

