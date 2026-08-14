---
name: local-dev
description: Guidelines for local development, syncing, and testing of the reorder plugin with an external Medusa backend project and subscription storefront.
---

# Local development in Medusa backend & Storefront

This skill describes how to sync local changes in the `reorder` plugin with an external Medusa backend and launch the subscription storefront during local development.

## Automated Synchronization and Startup

To automatically discover the backend folder and storefront, build the plugin, sync dependencies via `yalc`, run database migrations, and start both dev servers, execute the following script from the root of the `reorder` repository:

```bash
./.agents/scripts/sync-and-start.sh
```

**What this script does automatically:**
1. Verifies you are in the `reorder` repository.
2. Builds the plugin (`yarn build`) and pushes changes using `npx yalc push`.
3. Auto-discovers the Medusa backend project by scanning the parent directory (`..`) for a folder containing both `medusa-config.ts` and `@reorderjs/reorder` in its `package.json` (e.g. `../my-medusa-store`).
4. Auto-discovers the Storefront project (e.g. `../subscription-storefront`).
5. Checks database configuration (`DATABASE_URL`), installs dependencies, and runs database migrations (`yarn medusa db:migrate`).
6. Verifies storefront environment variables (`MEDUSA_BACKEND_URL`, `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`) and installs dependencies.
7. Concurrently starts both dev servers:
   - Medusa Backend (`yarn dev` on port 9000)
   - Storefront (`yarn dev` on port 8000)
   with unified process termination handling on exit/SIGINT.

## Post-Startup Reporting Rule
Whenever executing `local-dev` or starting dev servers in the background:
- Always inspect the server output logs for the active ports.
- Always immediately provide the user with the direct localhost URLs:
  - **Medusa Backend API**: `http://localhost:9000`
  - **Medusa Admin Dashboard**: `http://localhost:9000/app`
  - **Storefront**: `http://localhost:8000`
  - The paths of the detected backend and storefront projects.

## Manual Setup & Storefront Connection Requirements

### 1. Medusa Backend
1. Install `yalc` globally if needed: `npm i yalc -g`
2. In the Medusa backend's `package.json`, declare the plugin dependency using yalc:
   ```json
   "@reorderjs/reorder": "file:.yalc/@reorderjs/reorder"
   ```
3. Ensure the plugin is registered in `medusa-config.ts`.
4. Ensure PostgreSQL database is running and `DATABASE_URL` is configured in `.env`.
5. Ensure CORS settings in backend `.env` allow storefront access (`STORE_CORS=http://localhost:8000,...`).

### 2. Subscription Storefront (`subscription-storefront`)
1. Ensure `.env.local` is present in the storefront directory with:
   ```env
   MEDUSA_BACKEND_URL=http://localhost:9000
   NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=<active_publishable_api_key>
   NEXT_PUBLIC_BASE_URL=http://localhost:8000
   NEXT_PUBLIC_DEFAULT_REGION=us
   ```
2. The publishable API key in the storefront must match an active publishable key in the Medusa backend database that is linked to the appropriate sales channel.
