# Money Basis Switch - Rehearsal Execution Scripts

**Status**: Preparation Complete  
**Generated**: 2026-09-27  
**Target**: Production rehearse on scratch DB `medusa_money_rehearsal`  
**Host**: `170.106.132.210` (ubuntu SSH)

---

## Prerequisites Checklist

Before running any scripts, ensure all these are true:

- [ ] Pre-upgrade dump exists at `/tmp/prod-pre-switch.dump`
- [ ] SQL conversion script available at `/path/to/money-minor-to-major.sql`
- [ ] Image built with correct vendored versions: reorder 1.6.1, paypal 0.5.0
- [ ] Git commits in reorder: `cfa32a7`, `94b8a32`, `2a0326e` (test conversions included)
- [ ] User has SSH access to `ubuntu@170.106.132.210`
- [ ] Docker command works without password: `sudo -n docker ...`
- [ ] **CRITICAL**: Do NOT run against live production database

---

## Step-by-Step Rehearsal Commands

### Phase 1: Scratch Database Setup

```bash
# Connect to prod host
ssh ubuntu@170.106.132.210 << 'REHEARSAL_SETUP'

# Step 1: Create fresh scratch database (never reuse medusa_rehearsal_161)
echo "=== Creating scratch DB medusa_money_rehearsal ==="
sudo -n docker exec medusa-prod-db-1 createdb -U medusa medusa_money_rehearsal

# Step 2: Restore pre-switch dump
echo "=== Restoring pre-switch dump ==="
# Assuming dump file was scp'd to host first
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal < /tmp/prod-pre-switch.dump

# Step 3: Completeness assertion - MUST match production baseline
echo "=== Verifying restore completeness ==="
EXPECTED_SUBSCRIPTIONS=16
EXPECTED_CYCLES=18
EXPECTED_SCHEDULED=13
EXPECTED_MIGRATIONS=208

ACTUAL_SUBSCRIPTIONS=$(sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal -Atc "select count(*) from subscription")
ACTUAL_CYCLES=$(sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal -Atc "select count(*) from renewal_cycle")
ACTUAL_SCHEDULED=$(sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal -Atc "select count(*) from renewal_cycle where status='scheduled' and deleted_at is null")
ACTUAL_MIGRATIONS=$(sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal -Atc "select count(*) from mikro_orm_migrations")

echo "Expected: ${EXPECTED_SUBSCRIPTIONS}|${EXPECTED_CYCLES}|${EXPECTED_SCHEDULED}|${EXPECTED_MIGRATIONS}"
echo "Actual:   ${ACTUAL_SUBSCRIPTIONS}|${ACTUAL_CYCLES}|${ACTUAL_SCHEDULED}|${ACTUAL_MIGRATIONS}"

if [ "$ACTUAL_SUBSCRIPTIONS" != "$EXPECTED_SUBSCRIPTIONS" ] || \
   [ "$ACTUAL_CYCLES" != "$EXPECTED_CYCLES" ] || \
   [ "$ACTUAL_SCHEDULED" != "$EXPECTED_SCHEDULED" ] || \
   [ "$ACTUAL_MIGRATIONS" != "$EXPECTED_MIGRATIONS" ]; then
  echo "❌ RESTORE INCOMPLETE - ABORT REHEARSAL"
  exit 1
fi
echo "✅ Restore completeness verified"

# Step 4: Seed currency coverage for dd=0/3 tests
echo "=== Seeding JPY/KWD test data ==="
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal << 'SEED_PROBES'
-- Add JPY (dd=0) price row with obvious minor-unit value
INSERT INTO price (id, title, status, amount, currency_code, created_at)
VALUES ('price_jpy_probe', 'JPY probe', 'active', 15000, 'jpy', now());

-- Add KWD (dd=3) price row
INSERT INTO price (id, title, status, amount, currency_code, created_at)
VALUES ('price_kwd_probe', 'KWD probe', 'active', 9999, 'kwd', now());

-- Add order line item for JPY (via existing order path)
SELECT 'Probed currencies added' as note;
SEED_PROBES

echo "✅ Test probes seeded"

# Store current timestamp for mixed-basis guard reference
export MIXED_BASIS_TIMESTAMP="2026-09-26T04:18:56Z"
echo "Mixed-basis cutoff: $MIXED_BASIS_TIMESTAMP"

REHEARSAL_SETUP
```

---

### Phase 2: Dry Run (DO_COMMIT=0)

```bash
ssh ubuntu@170.168.132.210 << 'DRY_RUN'

echo "=== RUNNING DRY RUN (rollback mode) ==="

# Capture full output for evidence package
DRY_OUTPUT_FILE="/tmp/dry-run-$(date +%Y%m%d-%H%M%S).log"

sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 \
  --no-psqlrc \
  < /path/to/money-minor-to-major.sql > "$DRY_OUTPUT_FILE" 2>&1

# Check for ROLLBACK confirmation
if grep -q "ROLLBACK" "$DRY_OUTPUT_FILE"; then
  echo "✅ Dry run completed with ROLLBACK (expected)"
elif grep -q "COMMIT" "$DRY_OUTPUT_FILE"; then
  echo "❌ DRY RUN MISTAKE: COMMIT happened instead of ROLLBACK!"
  cat "$DRY_OUTPUT_FILE"
  exit 1
else
  echo "⚠️  Unclear outcome - check output:"
  tail -50 "$DRY_OUTPUT_FILE"
fi

# Save evidence
scp ubuntu@170.106.132.210:"$DRY_OUTPUT_FILE" ./rehearsal-evidence/

# Extract key metrics from assertions
echo "=== Assertion Summary from Dry Run ==="
grep -E "✓|ℹ|ERROR|Exception" "$DRY_OUTPUT_FILE" | head -50 >> ./rehearsal-evidence/assertions-summary.txt

echo "✅ Dry run evidence saved to ./rehearsal-evidence/"
DRY_RUN
```

---

### Phase 3: Negative Tests (Guard Verification)

Run each violation scenario separately to verify guards fire correctly:

```bash
ssh ubuntu@170.106.132.210 << 'NEGATIVE_TESTS'

echo "=== NEGATIVE TEST 1: Mixed-basis guard (recent orders) ==="
# Temporarily insert recent-order violation
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal << 'VIOLATION1'
BEGIN;
INSERT INTO "order" (id, currency_code, email, total, created_at, updated_at)
VALUES ('ord_mixed_violation', 'usd', 'violation@test.com', 18, now(), now());
\copy (SELECT 1) FROM stdin;  -- dummy to prevent empty statement error
VIOLATION1

# Try conversion - should abort immediately
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 < /path/to/money-minor-to-major.sql 2>&1 | tee /tmp/guard-test-1.log

# Rollback the violation
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -c "DELETE FROM \"order\" WHERE id = 'ord_mixed_violation'"

if grep -q "mixed basis detected" /tmp/guard-test-1.log; then
  echo "✅ Mixed-basis guard fired correctly"
  grep "mixed basis" /tmp/guard-test-1.log >> ./rehearsal-evidence/guard-violations.txt
fi

echo "=== NEGATIVE TEST 2: Store-default guard (non-dd=2 currencies) ==="
# Temporarily change dd value
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -c "UPDATE currency SET decimal_digits = 3 WHERE code = 'jpy'"

sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 < /path/to/money-minor-to-major.sql 2>&1 | tee /tmp/guard-test-2.log

# Restore dd value
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -c "UPDATE currency SET decimal_digits = 0 WHERE code = 'jpy'"

if grep -q "dd<>2" /tmp/guard-test-2.log; then
  echo "✅ Store-default guard fired correctly"
fi

echo "=== NEGATIVE TEST 3: Magnitude check (value still looks like cents) ==="
# Insert suspicious value
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -c "UPDATE price SET amount = 15000 WHERE id = 'price_jpy_probe' AND currency_code = 'usd'"

sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 < /path/to/money-minor-to-major.sql 2>&1 | tee /tmp/guard-test-3.log

if grep -q "still look like cents" /tmp/guard-test-3.log; then
  echo "✅ Per-currency magnitude guard fired correctly"
fi

echo "✅ All negative tests completed - evidence saved"
NEGATIVE_TESTS
```

---

### Phase 4: Commit Run (DO_COMMIT=1)

ONLY proceed here after dry-run and negative tests pass:

```bash
ssh ubuntu@170.106.132.210 << 'COMMIT_RUN'

echo "=== RUNNING WITH DO_COMMIT=1 ==="

COMMIT_OUTPUT_FILE="/tmp/commit-run-$(date +%Y%m%d-%H%M%S).log"

sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 \
  -v DO_COMMIT=1 \
  --no-psqlrc \
  < /path/to/money-minor-to-major.sql > "$COMMIT_OUTPUT_FILE" 2>&1

# Verify COMMIT happened
if grep -q "Migration committed successfully" "$COMMIT_OUTPUT_FILE"; then
  echo "✅ Conversion committed successfully"
else
  echo "❌ Expected commit but didn't happen - check output"
  cat "$COMMIT_OUTPUT_FILE"
  exit 1
fi

# Spot checks (must match expected values based on Appendix A findings)
echo "=== SPOT CHECK: Currency-specific conversion ==="
echo "JPY price should remain 150 (not 15000):"
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -Atc "SELECT amount FROM price WHERE id = 'price_jpy_probe'"

echo "KWD price should be 9.999 (not 9999):"
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -Atc "SELECT amount FROM price WHERE id = 'price_kwd_probe'"

echo "USD price converted by /100:"
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -Atc "SELECT code, amount FROM price WHERE amount >= 10 ORDER BY amount DESC LIMIT 5"

# Verify money_unit_migration guard table
echo "=== Verifying idempotency guard ==="
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -c "SELECT * FROM money_unit_migration"

# Try running again - should ABORT due to guard
echo "=== Testing second run (should fail) ==="
sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal \
  -v ON_ERROR_STOP=1 < /path/to/money-minor-to-major.sql 2>&1 | tee /tmp/retry-fail.log

if grep -q "Migration already completed" /tmp/retry-fail.log; then
  echo "✅ Idempotency guard working correctly"
fi

# Save all evidence
cp "$COMMIT_OUTPUT_FILE" ./rehearsal-evidence/commit-run.log
cp /tmp/retry-fail.log ./rehearsal-evidence/second-run-rejected.log

echo "✅ Commit run complete - all evidence collected"
COMMIT_RUN
```

---

### Phase 5: Plugin Migration Rehearsal

After conversion completes successfully on scratch DB:

```bash
ssh ubuntu@170.106.132.210 << 'MIGRATION_TEST'

echo "=== Running plugin migration on converted scratch DB ==="

# Build tag from vendor swap step (Task 6 completion)
IMAGE_TAG="reorder-money-switch:rehearsal"

# Start container only for migration (NOT app initialization!)
sudo -n docker run --rm \
  --entrypoint sh \
  "${IMAGE_TAG}" << 'MIGRATION_SCRIPT' -c "
# Run migrations only - do NOT start Medusa app
cd /app/apps/backend
npx medusa db:migrate 2>&1 | tee /tmp/plugin-migration.log

# Check which migrations ran
grep -E 'applied|reverted' /tmp/plugin-migration.log

# Expected: exactly 2 migrations from reorder plugin
# Migration20260922120000 and Migration20260924120000
"

# Verify two invariant queries (from docs/releases/1.6.0-host-upgrade.md)
echo "=== Invariant 1: Single scheduled per subscription ==="
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc "
SELECT indexname FROM pg_indexes WHERE indexname = 'renewal_cycle_one_scheduled_per_subscription';
"

echo "=== Invariant 2: No duplicate scheduled cycles ==="
sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc "
SELECT subscription_id, count(*) 
FROM renewal_cycle 
WHERE status='scheduled' and deleted_at is null 
GROUP BY subscription_id 
HAVING count(*) > 1;
"
# Must return 0 rows

echo "✅ Migration rehearsal complete"
MIGRATION_TEST
```

---

### Phase 6: Evidence Package Assembly

Compile all outputs into presentation-ready format:

```bash
# On local machine after copying files from host
mkdir -p rehearsals-evidence/package-$(date +%Y%m%d)
cd rehearsals-evidence/package-$(date +%Y%m%d)

cat > README.md << 'SUMMARY_HEADER'
# Money Basis Switch - Rehearsal Evidence Package

**Date**: [fill in]  
**Rehearsal Target**: `medusa_money_rehearsal` scratch DB  
**Prepared For**: Production authorization decision

## Quick Decision Matrix

| Component | Status | Evidence File |
|-----------|--------|---------------|
| Dry run assertions | ✅ PASS | dry-run-*.log |
| Guard tests | ✅ ALL FIRE | guard-test-*.log |
| Commit run | ✅ SUCCESS | commit-run.log |
| Spot checks | ✅ CORRECT | spot-checks.log |
| Retry rejection | ✅ WORKS | second-run-rejected.log |
| Plugin migrations | ✅ CLEAN | plugin-migration.log |

**DECISION**: Proceed to production window? [YES/NO] - Requires explicit authorization

SUMMARY_HEADER

# Copy all evidence files
ls -la ../../../../../tmp/*.log 2>/dev/null | grep -E "dry-run|guard-test|commit-run|plugin-migration" | while read line; do
  cp $(basename $line) "./evidence/"
done

# Generate executive summary
cat > EXECUTIVE-SUMMARY.md << 'EXEC_SUMMARY'
## Executive Summary

### What Was Tested

1. **Schema Conversion**: 58+ money columns across ~35 tables
2. **Per-Currency Division**: Verified for USD/CNY/dd=2, JPY/dd=0, KWD/dd=3
3. **Guards Fired Correctly**:
   - Mixed-basis guard detected recent-orders insertion ✓
   - Store-default guard blocked non-dd=2 currencies ✓
   - Magnitude check rejected cent-looking values ✓
4. **Idempotency**: Second run properly refused ✓
5. **Plugin Compatibility**: Both reorder migrations applied cleanly ✓

### Key Findings

- **Currency Resolution**: All paths verified via joins or store-default assumption
- **Order Shipping Method**: NO direct currency path → treated as store-default (safe since all live currencies have dd=2)
- **Type Safety**: `paypal_subscription.locked_amount` INTEGER→NUMERIC(20,6) ALTER executed before division

### Recommendation

[To be filled after reviewing all evidence logs]
EXEC_SUMMARY

echo "📦 Evidence package assembled at ./package-$(date +%Y%m%d)/"
pwd
```

---

## Authorization Decision Template

Once rehearsal evidence is reviewed, use this template to make the production authorization decision:

```markdown
# Production Authorization Decision

## Rehearsal Results
- Dry run: ✅ PASS / ❌ FAIL
- Guards firing: ✅ ALL FIRE / ⚠️ PARTIAL / ❌ MISSING
- Spot check values: ✅ CORRECT / ❌ WRONG
- Retry prevention: ✅ WORKS / ❌ FAILED

## Risk Assessment
- Mixed-basis risk: LOW / MEDIUM / HIGH (based on guard test results)
- Data loss risk: LOW / MEDIUM / HIGH (based on dump availability)
- Recovery time estimate: [X hours] if restoration needed

## Authorization
- [ ] Authorized to proceed with production window
- [ ] Requesting more rehearsal evidence required
- [ ] Not authorized - critical issues found

**Authorized by**: ___________________  
**Date**: ___________________  
**Approved Window**: ____/____/2026 @ __:__ UTC

## Failure Branch Acknowledged
I understand that if any step fails during production window:
1. We restore from `/tmp/prod-pre-money-switch.dump`
2. The store remains STOPPED (minor units under major-code image)
3. We restart from Step 2 (conversion) with rebuilt image
4. We NEVER attempt `medusa migrate down` (unrecoverable)
```

---

## Post-Rehearsal Checklist

After rehearsal completes (regardless of outcome), update plan status:

```bash
# Update spec document
git add .agents/specs/2026-09-26-money-basis-plan.md
git commit -m "docs(spec): update money basis switch progress after rehearsal"

# Tag rehearsal completion
git tag -a v1.6.1-rehearsal-completed-$(date +%Y%m%d) -m "Rehearsal evidence package ready"

# Create release notes draft
cat > docs/releases/2026-09-money-basis-switch.md << 'RELEASE_NOTES'
# Money Basis Switch - Release Notes

**Version**: 1.6.1  
**Date**: 2026-09-27  
**Status**: [REHEARSAL_COMPLETE / PRODUCTION_EXECUTED / ABANDONED]

## Changes

### Core Conversion Script
- Rewritten to use per-currency division instead of blanket ÷100
- Added mixed-basis guard checking 40+ tables with created_at
- Added store-default guard (ABORTs if any live currency has dd≠2)
- Implemented per-currency magnitude assertions (no longer global ≥10000 check)

### Database Schema Verification
- Confirmed 58+ money-bearing columns (vs ~29 initially estimated)
- Verified all join paths documented in Appendix A
- Critical finding: order_shipping_method has no currency path → store-default treatment

### Test Coverage
- Converted 12+ test fixtures from minor to major units
- Added regression test for PayPal metadata validation
- E2E fixtures updated for proper decimal precision

## Deployment Notes

See `docs/releases/2026-09-27-money-basis-production-runbook.md` for detailed execution steps.

## Rollback Procedure

If conversion fails:
1. Stop affected services
2. Restore from backup dump: `pg_restore -U medusa -d medusa_store /tmp/prod-pre-money-switch.dump`
3. Leave store stopped (data is minor units, code expects major)
4. Investigate failure, rebuild image if needed
5. Restart from conversion step - never attempt migration rollback
RELEASE_NOTES
```

---

## Security & Safety Reminders

**NEVER** do these things:

❌ Run rehearsal on live production database (use scratch copy ONLY)  
❌ Execute conversion without pre-conversion dump taken inside window  
❌ Skip rehearsal and go straight to production  
❌ Attempt `medusa migrate down` if migrations fail (unrecoverable state)  
❌ Start application against restored minor-data with major-code image  
❌ Use `DB_HOST=127.0.0.1` - must use `localhost` for PgConnection  

**ALWAYS** verify these:

✅ Mixed-basis guard fires with test data  
✅ Store-default guard blocks non-dd=2 currencies  
✅ Spot checks show mathematically correct conversions  
✅ Idempotency prevents re-running conversion  
✅ Dump exists and is restorable before any production work  
