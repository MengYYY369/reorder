# Post-Switch Closeout: Money Basis Conversion

**Status:** Post-Switch Execution Guide  
**Date:** 2026-09-27  
**Related Runbook:** `2026-09-27-money-basis-production-runbook.md`  

---

## Overview

This document provides the post-switch closeout procedures for after the money basis conversion completes successfully. These tasks must be executed within **24 hours** of switching store back online to ensure data integrity and operational readiness.

---

## Task 11.1: Rebuild Analytics - Subscription Metrics Daily

### Background
The `subscription_metrics_daily` table is **deleted during conversion** (per conversion script design) because it's derived from order totals, which have now been converted to major units. The table must be repopulated to restore MRR tracking and analytics capabilities.

### Method A: Via Admin API Trigger (Recommended)

**Prerequisites:**
- Admin token with analytics module permissions
- Access to backend admin endpoint

**Execution:**
```bash
ADMIN_TOKEN="your_admin_token_here"
BACKEND_URL="http://localhost:9000"

curl -X POST "${BACKEND_URL}/admin/analytics/rebuild-daily-metrics" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2026-09-26T00:00:00Z",
    "endDate": null
  }'
```

**Expected response:**
```json
{
  "success": true,
  "message": "Daily metrics rebuilt successfully",
  "metricsRebuilt": 15,
  "dateRange": {
    "start": "2026-09-26T00:00:00Z",
    "end": "2026-09-27T00:00:00Z"
  }
}
```

### Method B: Via Job Queue (Alternative)

If your infrastructure uses a job queue for analytics rebuilds:

```bash
# Dispatch analytics rebuild job (replace with your actual job dispatcher)
queue.dispatch("analytics-rebuild-daily", {
  startDate: "2026-09-26T00:00:00Z",
  endDate: null,
  priority: "high"
})
```

### Verification Steps

Run these queries immediately after trigger completes:

```sql
-- Check table populated
docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -c \
  "select count(*) from subscription_metrics_daily;"

-- Verify date range coverage
docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -c \
  "select min(effective_at) as min_date, max(effective_at) as max_date 
   from subscription_metrics_daily;"

-- Confirm MRR repopulates correctly (sample day)
docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -c \
  "select effective_at, count(subscription_id) as subs_count, 
          sum(mrr) as total_mrr 
   from subscription_metrics_daily 
   group by 1 order by 1 desc limit 3;"
```

**Expected results:**
- **Row count:** At least 1-2 days worth of records (depending on historical data)
- **Date range:** Should include today's date and previous days
- **MRR values:** Reasonable magnitudes (comparable to pre-switch if tracked externally)
- **Subscription counts:** Match live subscription count (~16 expected based on rehearsal data)

### Troubleshooting

**Issue: No rows inserted**
```sql
-- Check if rebuild job ran at all
docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -c \
  "select * from activity_log where event_type = 'analytics.daily_rebuild.started' 
   order by created_at desc limit 5;"

-- Look for errors in logs
docker logs medusa-prod-store-1 --tail 200 | grep -i analytics
```

**Solution:** Manually invoke rebuild function or check job queue failures.

**Issue: MRR values zero or inconsistent**
```sql
-- Check underlying orders were converted properly
docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -c \
  "select count(*), sum(total) as order_total_sum 
   from orders 
   where created_at >= '2026-09-26T00:00:00Z' 
     and currency_code = 'usd';"

-- Compare against subscription_metrics_daily
docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -c \
  "select sum(mrr) as mrr_total from subscription_metrics_daily 
   where effective_at = current_date;"
```

**Diagnosis:** If order totals show converted values but MRR is zero, rebuild job has logic bug. Re-trigger after fix.

---

## Task 11.2: Document Lessons Learned

### Template & Guidelines

Complete this section within 48 hours while details are fresh. Be specific and actionable.

### What Worked Well

List concrete elements that functioned as designed:

**Example format:**
```markdown
### What Worked Well

1. **Pre-conversion backup mechanism**
   - Backup taken in <5 minutes via pg_dump with custom format
   - SHA-256 hash recorded for audit trail
   - File permissions hardened immediately (chmod 600)
   - Retention location accessible via rehearsal directory structure

2. **Per-currency assertions**
   - Assertions provided clear pass/fail signals per currency
   - Empty result sets no longer skipped (fixed assertion logic)
   - Per-currency suspicion thresholds prevented false negatives (JPY vs USD)

3. **Docker-based restore**
   - Full database restore achieved in ~2.5 minutes
   - Schema restored alongside data automatically
   - No manual intervention required post-restore

4. **Atomic migration flag**
   - --all-or-nothing prevented partial schema states
   - Module-level isolation maintained even when one module failed
   - Clear error messages identifying failed module

5. **Dry-run capability**
   - DO_COMMIT=0 allowed validation without production impact
   - Syntax errors caught before committing
   - Confident green light for actual conversion
```

### What Didn't Work

Identify friction points and unexpected issues:

**Example format:**
```markdown
### What Didn't Work

1. **Image build verification timing**
   - Issue: Had to verify vendor tree inside built image before shipping
   - Impact: Added extra step requiring separate docker run command
   - Better approach: Bake version check into image build process itself

2. **Session state persistence during rebuild**
   - Issue: Mid-window Docker rebuild invalidated running SSH sessions
   - Impact: Had to re-authenticate and re-establish connections
   - Better approach: Use tmux/screen with persistent shell or jump host

3. **Log aggregation complexity**
   - Issue: Store startup logs scattered across multiple containers
   - Impact: Took longer than expected to correlate errors
   - Better approach: Centralized logging via fluentd or similar before window

4. **SQL script path discovery**
   - Issue: Had to search for money-minor-to-major.sql on first attempt
   - Impact: Added 3 minutes to conversion step
   - Better approach: Document exact path in runbook prerequisite checklist

5. **Scheduler timing uncertainty**
   - Issue: Exact scheduler start time unpredictable after boot
   - Impact: Required 5-minute watch period before confident idle
   - Better approach: Disable scheduler temporarily, re-enable after confirmation
```

### Gaps Needing Follow-Up

Identify technical debt and process improvements:

**Example format:**
```markdown
### Gaps Needing Follow-Up

1. **Automated health checks before conversion**
   - Gap: Manual queries required for mixed-basis guard
   - Recommendation: Create /health/money-basis-ready endpoint that runs checks
   - Priority: High (prevents human error)

2. **Real-time conversion progress dashboard**
   - Gap: Conversion steps executed blindly without visibility
   - Recommendation: Stream SQL execution status via WebSocket or server-sent events
   - Priority: Medium (improves confidence during execution)

3. **Rollback time SLA definition**
   - Gap: No documented target for how fast we must recover
   - Recommendation: Establish 10-minute maximum rollback window; measure against it
   - Priority: High (business continuity requirement)

4. **Post-switch validation suite**
   - Gap: Smoke tests ad-hoc rather than automated checklist
   - Recommendation: Create validation scripts that assert known states post-switch
   - Priority: Medium (reduces regression risk)

5. **Payment provider synchronization**
   - Gap: PayPal webhook handling not verified immediately post-switch
   - Recommendation: Add webhook test events to post-switch checklist
   - Priority: High (real customer billing depends on this)
```

### Operational Metrics

Track quantitative performance:

```markdown
### Operational Metrics

| Metric | Target | Actual | Notes |
|--------|--------|--------|-------|
| Total maintenance window | 60 minutes | X minutes | From store stop to smoke tests complete |
| Downtime accepted | 30 minutes | X minutes | Actual store unavailability |
| Backup creation time | <5 minutes | X minutes | pg_dump duration |
| Database restore time | <5 minutes | N/A | Did not require restore |
| Conversion execution | <10 minutes | X minutes | SQL script runtime |
| Migration execution | <5 minutes | X minutes | db:migrate duration |
| Store bootstrap time | <3 minutes | X minutes | Container up to ready |
| User interventions | 0 | X | Number of escalations required |
| Rollback attempts | 0 | 0 | Successful first-pass conversion |
| Assertion failures | 0 | 0 | All checks passed |
```

### Format Submission

1. Fill template above with actual observations
2. Save to `.agents/lessons-money-basis-2026-09-27.md` in repository root
3. Link from main `CHANGELOG.md` under relevant release section
4. Tag relevant team members for review (`@devops @backend @payments`)

---

## Task 11.3: Update Spec Status to "Implemented"

### Update Specification Document

**File:** `.agents/specs/2026-09-26-money-basis-minor-to-major.md`

**Location:** Line 3 (top of document after title)

**Current text:**
```markdown
Status: **DESIGN, revision 3 — reviewed adversarially; implementation not started.**
```

**Replace with:**
```markdown
Status: **IMPLEMENTED, 2026-09-27. Production switch completed successfully.**
```

### Add Implementation Record Section

**Location:** Before last section of document (after "Review record", before end)

**Insert new section:**

```markdown
## Implementation Record

Executed 2026-09-27 following production runbook (`docs/releases/2026-09-27-money-basis-production-runbook.md`). All phases completed successfully:

### Phase-by-Phase Summary

**Phase 1: Pre-flight Checks**
- ✅ Store container verified running (1 instance)
- ✅ No due renewal cycles (0 scheduled_for <= now())
- ✅ Mixed-basis guard passed (0 orders after code deploy timestamp)
- ✅ Production baseline documented (16 subscriptions, 13 live scheduled, index absent)

**Phase 2: Stop Store & Backup**
- ✅ Store stopped successfully
- ✅ Pre-conversion backup taken: `/home/ubuntu/reorder-161-rehearsal-20260926/prod-pre-money-switch-YYYY-MM-DD-HHMMSS.dump`
- ✅ Backup hash recorded: `${BACKUP_HASH}`
- ✅ File permissions hardened (mode 600)

**Phase 3: Execute Conversion**
- ✅ Conversion script executed with DO_COMMIT=1
- ✅ All per-currency assertions passed
- ✅ No minor-unit remnants detected (amounts <10000 for 2-decimal currencies)
- ✅ PayPal locked_amount clean (no truncation artifacts)
- ✅ money_unit_migration guard written (1 row)

**Phase 4: Verify Results**
- ✅ Currency-wise summaries validated
- ✅ Price magnitudes correct ($9.99 not $999)
- ✅ Order totals consistent with line items
- ✅ raw_amount JSONB regenerated with major units

**Phase 5: Deploy Image & Migrate**
- ✅ Docker Compose tag updated to 0.4.21
- ✅ Migrations applied cleanly (+2 rows: activity-log + renewal)
- ✅ Index `renewal_cycle_one_scheduled_per_subscription` created
- ✅ Constraint `subscription_log_event_type_check` updated to 26 values

**Phase 6: Failure Recovery**
- ✅ Not required (conversion succeeded on first attempt)

**Phase 7: Start Store & Smoke Tests**
- ✅ Store container booted without errors
- ✅ Startup logs clean (no workflow conflicts, no schema mismatches)
- ✅ Admin UI loads with correct price magnitudes
- ✅ SaaS bridge responses return major-unit totals
- ✅ Transactional emails render converted amounts correctly
- ✅ Scheduler first post-start run wrote nothing (no due cycles)

### Key Metrics

| Metric | Value |
|--------|-------|
| Total window duration | X minutes |
| Downtime accepted | X minutes |
| Backup size | ~655 KB |
| Conversion runtime | X seconds |
| Migration runtime | X seconds |
| Rollbacks required | 0 |
| User interventions | 0 |
| Assertion failures | 0 |

### Conclusion

**Zero rollbacks required. Window downtime within acceptable bounds. All conversion goals achieved.** The money basis switch from minor to major units completed successfully, aligning stored data with Medusa v2's currency system.

```

---

## Task 11.4: Final Compliance Checklist

Ensure all post-switch obligations met:

```markdown
### Final Compliance Checklist

- [ ] **Analytics rebuilt:** subscription_metrics_daily repopulated and verified
- [ ] **MRR healthy:** Daily snapshots show reasonable totals matching converted history
- [ ] **Admin UI confirmed:** Prices display at correct magnitude across products
- [ ] **API responses verified:** SaaS bridge returns major-unit totals consistently
- [ ] **Email templates checked:** Transactional emails render converted amounts
- [ ] **Scheduler idle verified:** No renewal processing occurred during first cycle
- [ ] **Lessons documented:** Written capture saved to .agents/lessons-money-basis-*.md
- [ ] **Spec status updated:** Design spec marked IMPLEMENTED with execution record
- [ ] **Changelog updated:** Release notes reflect money basis change
- [ ] **Runbook archived:** Production documentation saved and tagged
- [ ] **Backup retained:** Pre-conversion dump available for retention period
- [ ] **Stakeholders notified:** Success announcement sent to relevant teams
- [ ] **Monitoring configured:** Alerts set for any revert indicators (e.g., duplicate prices)
```

---

## Appendix: Post-Switch Monitoring Queries

### Hourly Health Checks (First 24 Hours)

Run these queries every hour for first day to catch issues early:

```sql
-- Check for any minor-unit artifacts appearing in new data
SELECT COUNT(*) FROM price WHERE amount >= 10000 AND currency_code IN ('usd','cny');

-- Monitor PayPal subscription amounts for anomalies
SELECT id, reference, locked_amount, currency_code 
FROM paypal_subscription 
WHERE locked_amount >= 100 OR locked_amount IS NULL;

-- Verify no duplicate renewal cycles emerged
SELECT subscription_id, COUNT(*) as cycle_count 
FROM renewal_cycle 
WHERE status = 'scheduled' AND deleted_at IS NULL 
GROUP BY 1 HAVING COUNT(*) > 1;

-- Check money_unit_migration guard intact
SELECT * FROM money_unit_migration;

-- Monitor for unusual order totals (possible conversion artifact)
SELECT id, total, currency_code, created_at 
FROM orders 
WHERE created_at > '2026-09-26T04:18:56Z' 
  AND (total > 1000 OR total < 0)
ORDER BY created_at DESC LIMIT 10;
```

### Daily Validation (Week Following Switch)

```sql
-- MRR trend consistency
SELECT effective_at, mrr_delta, total_mrr 
FROM subscription_metrics_daily 
WHERE effective_at BETWEEN NOW() - INTERVAL '7 days' AND NOW()
ORDER BY effective_at;

-- Subscription count stability
SELECT COUNT(*) as active_subs FROM subscription WHERE status = 'active';

-- Payment collection success rate
SELECT DATE_TRUNC('hour', created_at) as hour, 
       COUNT(*) FILTER (WHERE status = 'authorized') as successes,
       COUNT(*) FILTER (WHERE status = 'rejected') as failures
FROM payment_collection 
WHERE created_at > NOW() - INTERVAL '1 week'
GROUP BY 1 ORDER BY 1;
```

---

## Emergency Contacts & Escalation Path

### Immediate Response Team

| Role | Contact | Availability |
|------|---------|--------------|
| On-call DevOps | [insert PagerDuty link] | 24/7 |
| Backend Lead | [insert Slack/email] | Business hours + on-call |
| Payments Specialist | [insert Slack/email] | Business hours |
| Infrastructure Owner | [insert phone] | Emergency only |

### Vendor Support

| Provider | Support Portal | Escalation Email |
|----------|----------------|------------------|
| Medusa | https://medusajs.com/support | support@medusa.dev |
| PayPal | https://developer.paypal.com | merchant-support@paypal.com |
| PostgreSQL | [community resources] | - |

### Escalation Triggers

**Escalate to Backend Lead if:**
- Unidentified error in application logs persists >15 minutes
- MRR values deviate >10% from expected trend
- Customer complaints about pricing surface

**Escalate to Infrastructure Owner if:**
- Database restore required but failing
- Host accessibility lost
- Data corruption suspected beyond plugin scope

**Escalate to Vendor Support if:**
- PayPal webhook delivery fails systematically
- Payment authorization fails despite valid cards
- Core Medusa behavior diverges from documented spec

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-09-27 | 1.0 | Production Team | Initial release for money basis switch post-closeout |

---

**Document owner:** Production Team  
**Next review:** End of week following production switch  
**Dependencies:** Requires successful completion of `2026-09-27-money-basis-production-runbook.md`

---

⚠️ **Remember:** This post-switch work must begin **immediately after** store comes online. Do not defer analytics rebuild or lessons documentation—complete them within 24 hours while data integrity can still be verified against fresh conversion results.
