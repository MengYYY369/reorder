#!/usr/bin/env bash
set -e

echo "=== Medusa Reorder Local Dev Workflow ==="

# 1. Verify source directory
if [ ! -f "package.json" ] || ! grep -q "\"name\": \"@reorderjs/reorder\"" "package.json"; then
  echo "Error: This script must be run from the root of the 'reorder' repository."
  exit 1
fi

REORDER_ROOT="$(pwd)"

echo ">> 1/6: Building reorder plugin..."
yarn build

echo ">> 2/6: Pushing plugin locally to yalc registry..."
npx yalc push

# 2. Find Medusa backend directory
BACKEND_DIR=""
echo ">> 3/6: Searching for Medusa backend directory..."
for dir in ../*/; do
  if [ -f "${dir}medusa-config.ts" ] && [ -f "${dir}package.json" ]; then
    if grep -q "@reorderjs/reorder" "${dir}package.json"; then
      BACKEND_DIR="$(cd "${dir}" && pwd)"
      break
    fi
  fi
done

if [ -z "$BACKEND_DIR" ]; then
  echo "Error: Could not find a Medusa backend project with @reorderjs/reorder installed adjacent to this directory."
  exit 1
fi
echo ">> Found backend at: $BACKEND_DIR"

# 3. Find Storefront directory
STOREFRONT_DIR=""
echo ">> 4/6: Searching for Storefront directory..."
if [ -d "../subscription-storefront" ] && [ -f "../subscription-storefront/package.json" ]; then
  STOREFRONT_DIR="$(cd "../subscription-storefront" && pwd)"
else
  for dir in ../*/; do
    if [ -f "${dir}package.json" ] && { [ -f "${dir}next.config.js" ] || [ -f "${dir}next.config.mjs" ] || [ -f "${dir}next.config.ts" ]; }; then
      if [ "$(cd "$dir" && pwd)" != "$BACKEND_DIR" ]; then
        STOREFRONT_DIR="$(cd "${dir}" && pwd)"
        break
      fi
    fi
  done
fi

if [ -z "$STOREFRONT_DIR" ]; then
  echo "Warning: Could not auto-detect Storefront directory adjacent to reorder."
else
  echo ">> Found storefront at: $STOREFRONT_DIR"
fi

# 4. Prepare backend: check DB & run migrations
echo ">> 5/6: Preparing Medusa backend..."
cd "$BACKEND_DIR"
if [ -f ".env" ]; then
  DB_URL=$(grep '^DATABASE_URL=' .env | cut -d '=' -f2-)
  if [ -n "$DB_URL" ]; then
    echo "   Database configured at: $DB_URL"
  else
    echo "   Warning: DATABASE_URL is missing in backend .env!"
  fi
else
  echo "   Warning: .env file is missing in backend directory!"
fi

yarn install
yarn medusa db:migrate

# 5. Prepare storefront (if found)
if [ -n "$STOREFRONT_DIR" ]; then
  echo ">> Preparing Storefront..."
  cd "$STOREFRONT_DIR"
  if [ -f ".env.local" ]; then
    PUB_KEY=$(grep '^NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=' .env.local | cut -d '=' -f2-)
    if [ -n "$PUB_KEY" ]; then
      echo "   Storefront publishable key: $PUB_KEY"
    else
      echo "   Warning: NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY is missing in storefront .env.local!"
    fi
  elif [ -f ".env" ]; then
    PUB_KEY=$(grep '^NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=' .env | cut -d '=' -f2-)
    if [ -n "$PUB_KEY" ]; then
      echo "   Storefront publishable key: $PUB_KEY"
    fi
  else
    echo "   Warning: No .env.local or .env found in storefront directory!"
  fi
  yarn install
fi

# 6. Start servers concurrently
echo ">> 6/6: Starting servers..."
echo "=================================================="
echo "🚀 Medusa Backend API:     http://localhost:9000"
echo "🖥️  Medusa Admin Dashboard: http://localhost:9000/app"
if [ -n "$STOREFRONT_DIR" ]; then
  echo "🛍️  Storefront:             http://localhost:8000"
fi
echo "=================================================="

BACKEND_PID=""
STOREFRONT_PID=""

cleanup() {
  echo ""
  echo ">> Stopping dev servers..."
  if [ -n "$BACKEND_PID" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [ -n "$STOREFRONT_PID" ]; then
    kill "$STOREFRONT_PID" 2>/dev/null || true
  fi
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

cd "$BACKEND_DIR"
yarn dev &
BACKEND_PID=$!

if [ -n "$STOREFRONT_DIR" ]; then
  cd "$STOREFRONT_DIR"
  yarn dev &
  STOREFRONT_PID=$!
fi

if [ -n "$STOREFRONT_PID" ]; then
  wait "$BACKEND_PID" "$STOREFRONT_PID"
else
  wait "$BACKEND_PID"
fi
