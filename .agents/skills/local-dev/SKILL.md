---
name: local-dev
description: Guidelines for local development and testing of the reorder plugin in an external Medusa backend project. Use this skill only when the task involves deploying, syncing, or locally running the plugin with a backend.
---

# Local development in Medusa backend

This skill describes how to sync local changes in the `reorder` plugin with an external Medusa backend during local development.

## Automated Synchronization and Startup

To automatically discover the backend folder, build the plugin, sync dependencies via `yalc`, run migrations and start the backend server, simply execute the following script from the root of the `reorder` repository:

```bash
./.agents/scripts/sync-and-start.sh
```

**What this script does automatically:**
1. Verifies you are in the `reorder` repository.
2. Builds the plugin (`yarn build`) and pushes changes using `npx yalc push`.
3. Auto-discovers the Medusa backend project by scanning the parent directory (`..`) for a folder containing both `medusa-config.ts` and `@reorderjs/reorder` in its `package.json`.
4. Checks the backend's `.env` for the `DATABASE_URL` presence.
5. Installs dependencies and runs database migrations (`yarn medusa db:migrate`).
6. Starts the backend server using `yarn dev`.

## Manual Setup (Prerequisites)

If this is your first time setting up the backend to work with local reorder:

1. Install `yalc` globally if you haven't already: `npm i yalc -g`
2. In the Medusa backend's `package.json`, declare the plugin dependency using yalc:
   ```json
   "@reorderjs/reorder": "file:.yalc/@reorderjs/reorder"
   ```
3. Ensure the plugin is registered in `medusa-config.ts`.
4. Ensure your PostgreSQL database is running and the `DATABASE_URL` is set in the backend's `.env` file.
