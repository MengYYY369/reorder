#!/usr/bin/env bash
set -e

echo "=== Medusa Reorder Local Dev Workflow ==="

# 1. Verify source directory
if [ ! -f "package.json" ] || ! grep -q "\"name\": \"@reorderjs/reorder\"" "package.json"; then
  echo "Error: This script must be run from the root of the 'reorder' repository."
  exit 1
fi

echo ">> 1/5: Building reorder plugin..."
yarn build

echo ">> 2/5: Pushing plugin locally to yalc registry..."
npx yalc push

# 2. Find Medusa backend directory
BACKEND_DIR=""
echo ">> Searching for a Medusa backend directory (depending on @reorderjs/reorder) in the parent directory (..)..."
for dir in ../*/; do
  if [ -f "${dir}medusa-config.ts" ] && [ -f "${dir}package.json" ]; then
    if grep -q "@reorderjs/reorder" "${dir}package.json"; then
      BACKEND_DIR="${dir}"
      break
    fi
  fi
done

if [ -z "$BACKEND_DIR" ]; then
  echo "Error: Could not find a Medusa backend project with @reorderjs/reorder installed adjacent to this directory."
  exit 1
fi

echo ">> Found backend at: $BACKEND_DIR"
cd "$BACKEND_DIR"

# 3. Check database environment variables
if [ -f ".env" ]; then
  # Load only DATABASE_URL to avoid polluting the environment
  DB_URL=$(grep '^DATABASE_URL=' .env | cut -d '=' -f2-)
  if [ -n "$DB_URL" ]; then
    echo ">> 3/5: Database configured at: $DB_URL"
  else
    echo "Warning: DATABASE_URL is missing in the backend's .env file!"
  fi
else
  echo "Warning: .env file is missing in the backend directory!"
fi

# 4. Install dependencies and run migrations
echo ">> 4/5: Refreshing dependencies (yarn) and running migrations (medusa db:migrate)..."
yarn install
yarn medusa db:migrate

# 5. Start the server
echo ">> 5/5: Starting the backend server..."
yarn dev
