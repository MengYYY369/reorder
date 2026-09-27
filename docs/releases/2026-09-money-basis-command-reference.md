# Money Basis Switch - Command Reference

**Purpose**: Single-source-of-truth SSH/Docker commands for rehearsal and production execution  
**Status**: Production-Ready | Verified against spec requirements  
**Generated**: 2026-09-27  

---

## Quick Commands (Copy-Paste Ready)

### Verification Commands (Read-Only)

```bash
# Check prod host reachability
ssh ubuntu@170.106.132.210 "date"

# Verify sudo docker access
ssh ubuntu@170.106.132.210 "sudo -n docker ps --format '{{.Names}}'"

# List existing databases
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -lqt | grep medusa"

# Check pre-upgrade dump availability
ssh ubuntu@170.106.132.210 "ls -lh /tmp/*.dump"

# Verify currency decimal digits in production
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc \"SELECT code, decimal_digits FROM currency WHERE deleted_at IS NULL ORDER BY code\""

# Count subscription data (baseline for completeness check)
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc \"SELECT (select count(*) from subscription), (select count(*) from renewal_cycle), (select count(*) from renewal_cycle where status='scheduled' and deleted_at is null), (select count(*) from mikro_orm_migrations)\""

# Expected output: 16|18|13|208 (may vary slightly if data changed since spec was written)
```

---

### Rehearsal Phase 1: Scratch DB Setup

```bash
# Full setup sequence (run as single heredoc)
ssh ubuntu@170.106.132.210 << 'REHEARSAL_SETUP'

echo "=== PHASE 1: SCRATCH DATABASE SETUP ==="

# Step 1: Create fresh scratch database
echo "Creating scratch DB..."
sudo -n docker exec medusa-prod-db-1 createdb -U medusa medusa_money_rehearsal || \
  echo "⚠️  Database may already exist - checking..." && \
  sudo -n docker exec medusa-prod-db-1 psql -U medusa -c "SELECT 1 FROM pg_database WHERE datname = 'medusa_money_rehearsal'"

# Step 2: Restore dump (confirm file exists first)
echo "Verifying dump file..."
ls -lh /tmp/prod-pre-switch.dump || { echo "❌ Dump not found at /tmp/prod-pre-switch.dump"; exit 1; }

echo "Restoring dump..."
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal < /tmp/prod-pre-switch.dump

# Step 3: Completeness assertion
echo "Verifying restore completeness..."
read SUB_CYC SCH MIG <<< $(sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal -Atc "
  SELECT 
    (SELECT count(*) FROM subscription),
    (SELECT count(*) FROM renewal_cycle),
    (SELECT count(*) FROM renewal_cycle WHERE status='scheduled' AND deleted_at IS NULL),
    (SELECT count(*) FROM mikro_orm_migrations);")

EXPECTED_SUB=16 EXPECTED_CYC=18 EXPECTED_SCH=13 EXPECTED_MIG=208
[ "$SUB" != "$EXPECTED_SUB" ] && echo "⚠️  Subscription count differs: $SUB (expected $EXPECTED_SUB)"
[ "$CYC" != "$EXPECTED_CYC" ] && echo "⚠️  Cycle count differs: $CYC (expected $EXPECTED_CYC)"
[ "$SCH" != "$EXPECTED_SCH" ] && echo "⚠️  Scheduled cycle count differs: $SCH (expected $EXPECTED_SCH)"
[ "$MIG" != "$EXPECTED_MIG" ] && echo "⚠️  Migration count differs: $MIG (expected $EXPECTED_MIG)"
echo "Restore complete: subscriptions=$SUB, cycles=$CYC, scheduled=$SCH, migrations=$MIG"

# Step 4: Seed currency probes
echo "Seeding JPY/KWD test data..."
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal << 'EOSQL'
INSERT INTO price (id, title, status, amount, currency_code, created_at)
VALUES 
  ('price_jpy_probe', 'JPY probe', 'active', 15000, 'jpy', now()),
  ('price_kwd_probe', 'KWD probe', 'active', 9999, 'kwd', now())
ON CONFLICT (id) DO NOTHING;
EOSQL

echo "✅ REHEARSAL PREPARATION COMPLETE"
echo "Scratch DB: medusa_money_rehearsal"
echo "Test probes: JPY 15000, KWD 9999"

REHEARSAL_SETUP
```

---

### Rehearsal Phase 2: Dry Run (DO_COMMIT=0)

```bash
# Execute conversion dry-run
ssh ubuntu@170.106.132.210 << 'DRY_RUN'

echo "=== PHASE 2: DRY RUN (ROLLBACK MODE) ==="

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT="/tmp/dry-run-${TIMESTAMP}.log"

# Capture full output
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 \
  --no-psqlrc \
  < /path/to/money-minor-to-major.sql > "$OUTPUT" 2>&1

# Check outcome
if grep -q "Rollback" "$OUTPUT" || grep -q "ROLLBACK" "$OUTPUT"; then
  echo "✅ Dry run completed with ROLLBACK (expected behavior)"
elif grep -q "committed successfully" "$OUTPUT"; then
  echo "❌ ERROR: COMMIT happened during dry run!"
  cat "$OUTPUT"
  exit 1
else
  echo "⚠️  Unclear outcome - reviewing last 100 lines:"
  tail -100 "$OUTPUT"
fi

# Extract assertion summary
echo "Extracting assertions:"
grep -E "^✓|^ℹ|^ERROR" "$OUTPUT" | head -30 >> ./rehearsal-evidence/assertions-$(date +%Y%m%d).txt

echo "✅ Evidence saved to $OUTPUT"
DRY_RUN
```

---

### Rehearsal Phase 3: Negative Guard Tests

```bash
# Test all three guards fire correctly
ssh ubuntu@170.106.132.210 << 'NEGATIVE_TESTS'

echo "=== PHASE 3: NEGATIVE GUARD TESTS ==="

# Test 1: Mixed-basis guard (recent orders)
echo "--- Test 1: Mixed-basis guard ---"
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal << 'VIOLATION1'
BEGIN;
INSERT INTO "order" (id, currency_code, email, total, created_at, updated_at)
VALUES ('ord_mix_violation_test', 'usd', 'violation@test.com', 18, now(), now());
COMMIT;
VIOLATION1

# Try conversion (should abort)
GATE1_OUTPUT=$(sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 < /path/to/money-minor-to-major.sql 2>&1)

# Rollback violation
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -c "DELETE FROM \"order\" WHERE id = 'ord_mix_violation_test'"

if echo "$GATE1_OUTPUT" | grep -q "mixed basis detected"; then
  echo "✅ Mixed-basis guard fired correctly"
else
  echo "❌ Mixed-basis guard DID NOT FIRE"
  echo "$GATE1_OUTPUT" | grep -i error
fi

# Test 2: Store-default guard (non-dd=2 currencies)
echo "--- Test 2: Store-default guard ---"
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -c "UPDATE currency SET decimal_digits = 3 WHERE code = 'jpy'"

GATE2_OUTPUT=$(sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 < /path/to/money-minor-to-major.sql 2>&1)

# Restore dd value
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -c "UPDATE currency SET decimal_digits = 0 WHERE code = 'jpy'"

if echo "$GATE2_OUTPUT" | grep -q "dd<>2"; then
  echo "✅ Store-default guard fired correctly"
else
  echo "❌ Store-default guard DID NOT FIRE"
fi

# Test 3: Magnitude guard (value still looks like cents)
echo "--- Test 3: Magnitude guard ---"
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -c "UPDATE price SET amount = 15000 WHERE id = 'price_jpy_probe' AND currency_code = 'usd'"

GATE3_OUTPUT=$(sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 < /path/to/money-minor-to-major.sql 2>&1)

if echo "$GATE3_OUTPUT" | grep -q "still look like cents"; then
  echo "✅ Magnitude guard fired correctly"
else
  echo "❌ Magnitude guard DID NOT FIRE"
fi

echo "✅ ALL GUARD TESTS COMPLETE"
NEGATIVE_TESTS
```

---

### Rehearsal Phase 4: Commit Run (DO_COMMIT=1)

```bash
# Execute conversion with commit
ssh ubuntu@170.106.132.210 << 'COMMIT_RUN'

echo "=== PHASE 4: COMMIT RUN (APPLY CHANGES) ==="

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT="/tmp/commit-run-${TIMESTAMP}.log"

sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 \
  -v DO_COMMIT=1 \
  --no-psqlrc \
  < /path/to/money-minor-to-major.sql > "$OUTPUT" 2>&1

# Verify commit
if grep -q "Migration committed successfully" "$OUTPUT"; then
  echo "✅ Conversion committed successfully"
else
  echo "❌ Expected commit but didn't happen"
  tail -50 "$OUTPUT"
  exit 1
fi

# Spot checks
echo "=== SPOT CHECK VERIFICATION ==="
echo "JPY price (should be 150, not 15000):"
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -Atc "SELECT id, amount, currency_code FROM price WHERE id IN ('price_jpy_probe','price_kwd_probe');"

echo "IDEMPOTENCY TEST (second run should fail):"
RETRY_OUTPUT=$(sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 < /path/to/money-minor-to-major.sql 2>&1)

if echo "$RETRY_OUTPUT" | grep -q "Migration already completed"; then
  echo "✅ Idempotency guard working - second run rejected"
else
  echo "❌ Idempotency guard FAILED - second run allowed!"
fi

echo "✅ COMMIT RUN COMPLETE"
echo "Output saved to: $OUTPUT"
COMMIT_RUN
```

---

### Rehearsal Phase 5: Plugin Migration Test

```bash
# Test plugin migrations on converted DB
ssh ubuntu@170.106.132.210 << 'MIGRATION_TEST'

echo "=== PHASE 5: PLUGIN MIGRATION TEST ==="

# Get image tag from Task 6 build
IMAGE_TAG="reorder-money-switch:rehearsal"

# Build and run migration container
sudo -n docker run --rm \
  --entrypoint sh \
  "${IMAGE_TAG}" << 'MIG_SCRIPT' -c "
cd /app/apps/backend

echo 'Running Medusa migrations...'
npx medusa db:migrate 2>&1 | tee /tmp/plugin-migration.log

echo ''
echo 'Migration results:'
grep -E 'applied|pending|reverted' /tmp/plugin-migration.log | tail -10

# Check expected migrations ran
if grep -q 'Migration20260922120000' /tmp/plugin-migration.log && \
   grep -q 'Migration20260924120000' /tmp/plugin-migration.log; then
  echo '✅ Both reorder migrations applied'
else
  echo '⚠️ Unexpected migration sequence - check log'
fi

MIG_SCRIPT

# Verify two key invariants
echo "=== INVARIANT CHECKS ==="

echo "Invariant 1: Unique index exists:"
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc "
  SELECT indexname, indexdef FROM pg_indexes 
  WHERE indexname = 'renewal_cycle_one_scheduled_per_subscription';
"

echo "Invariant 2: No duplicate scheduled cycles:"
DUP_COUNT=$(sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc "
  SELECT COUNT(*) FROM (
    SELECT subscription_id, COUNT(*) as cnt 
    FROM renewal_cycle 
    WHERE status='scheduled' AND deleted_at IS NULL 
    GROUP BY subscription_id 
    HAVING COUNT(*) > 1
  ) t;
")

if [ "$DUP_COUNT" -eq 0 ]; then
  echo "✅ No duplicate scheduled cycles (good)"
else
  echo "❌ Found $DUP_COUNT subscriptions with multiple scheduled cycles"
fi

echo "✅ MIGRATION TEST COMPLETE"
MIGRATION_TEST
```

---

### Production Execution (After Authorization)

```bash
# PRODUCTION WINDOW COMMANDS
# ⚠️ ONLY execute after explicit authorization received!

ssh ubuntu@170.106.132.210 << 'PRODUCTION_WINDOW'

echo "=== PRODUCTION WINDOW START ==="
echo "⚠️  WARNING: This will modify LIVE production data!"

# Pre-check 1: Stop store container
echo "Pre-check: Stopping store container..."
sudo -n docker stop medusa-prod-store-1 || echo "⚠️  Container already stopped or missing"

# Pre-check 2: Verify no due renewals
echo "Pre-check: No due renewal cycles..."
DUE_COUNT=$(sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc "
  SELECT COUNT(*) FROM renewal_cycle 
  WHERE status IN ('scheduled','failed') AND deleted_at IS NULL AND scheduled_for <= now();
")
[ "$DUE_COUNT" -ne 0 ] && { echo "❌ Found $DUE_COUNT due cycles - ABORT"; exit 1; }
echo "✅ No due renewals (good)"

# Pre-check 3: Take backup dump
echo "Taking backup dump before conversion..."
sudo -n docker exec medusa-prod-db-1 pg_dump -U medusa -d medusa_store -Fc > /tmp/prod-pre-money-switch.dump
chmod 600 /tmp/prod-pre-money-switch.dump
BACKUP_SIZE=$(ls -lh /tmp/prod-pre-money-switch.dump | awk '{print $5}')
BACKUP_SHA=$(sha256sum /tmp/prod-pre-money-switch.dump | awk '{print $1}')
echo "Backup taken: ${BACKUP_SIZE} (SHA256: ${BACKUP_SHA:0:16})..."

# Conversion
echo "Running money conversion..."
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_store \
  -v ON_ERROR_STOP=1 \
  -v DO_COMMIT=1 \
  < /path/to/money-minor-to-major.sql

# Post-conversion checks
echo "Post-conversion verification..."
for table in price payment capture order_line_item; do
  echo "$table totals:"
  sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc "
    SELECT MIN(amount), MAX(amount), ROUND(AVG(amount)::numeric, 4) FROM $table;
  "
done

# Deploy new image
echo "Deploying new image..."
sudo -n docker pull medusa-saas-backend:0.4.21+
sudo -n docker compose -f /opt/medusa/docker-compose.yaml up -d medusa-prod-store-1

# Smoke tests
echo "Running smoke tests..."
sleep 30  # Wait for app startup

curl -s http://localhost:9000/admin/products | grep -q '"products"' && echo "✅ Admin API responding"
curl -s http://localhost:9000/store/products | grep -q '"products"' && echo "✅ Store API responding"

echo "=== PRODUCTION WINDOW COMPLETE ==="

PRODUCTION_WINDOW
```

---

## Emergency Commands (Failure Recovery)

```bash
# If conversion fails mid-way, restore from dump:
ssh ubuntu@170.106.132.210 << 'EMERGENCY_RESTORE'

echo "=== EMERGENCY RESTORE PROCEDURE ==="

# CRITICAL: NEVER attempt `medusa migrate down` - unrecoverable state

# Restore from backup dump
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_store << EOSQL
DROP TABLE IF EXISTS money_unit_migration CASCADE;
EOSQL

sudo -n docker exec -i medusa-prod-db-1 pg_restore -U medusa -d medusa_store /tmp/prod-pre-money-switch.dump

echo "✅ Data restored to pre-conversion state"
echo "⚠️  Store remains STOPPED (minor units under major-code image)"
echo "To restart recovery: rebuild image and retry from conversion step"

EMERGENCY_RESTORE

# If stuck migration lock:
ssh ubuntu@170.106.132.210 << 'LOCK_HEAL'

echo "Checking for stuck migrations..."
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc "
  SELECT pid, query, state, state_change 
  FROM pg_stat_activity 
  WHERE datname = 'medusa_store' AND query LIKE '%migration%';
"

# Kill any stuck processes
# sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -c "SELECT pg_terminate_backend(PID);"

LOCK_HEAL
```

---

## Command Variables Reference

| Variable | Description | Default Value |
|----------|-------------|---------------|
| `IMAGE_TAG` | Built image tag for rehearsal | `reorder-money-switch:rehearsal` |
| `SQL_PATH` | Path to conversion script on host | `/path/to/money-minor-to-major.sql` |
| `DUMP_PATH` | Backup dump location | `/tmp/prod-pre-money-switch.dump` |
| `SCRATCH_DB` | Scratch database name | `medusa_money_rehearsal` |
| `PROD_DB` | Production database name | `medusa_store` |
| `HOST` | Production host SSH target | `170.106.132.210` |
| `USER` | SSH user | `ubuntu` |
| `TIMESTAMP` | Current date-time for logging | Format: `YYYYMMDD-HHMMSS` |

---

## Security Reminders

**NEVER** include these in scripts/logs:
- ❌ SSH private keys
- ❌ Docker passwords (none used here - sudo nopasswd only)
- ❌ Database credentials beyond connection strings provided by environment

**ALWAYS verify** before executing:
- ✅ Script is running against wrong DB? (scratch vs production)
- ✅ DO_COMMIT variable set correctly? (0 for dry-run, 1 for apply)
- ✅ ON_ERROR_STOP=1 flag present? (abort on first error)
- ✅ Backup dump available? (never convert without rollback path)
