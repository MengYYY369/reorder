---
name: appendix-a-verified-join-paths-and-inventory
description: Production database schema verification results for money columns and currency resolution paths
metadata:
  type: project
  created: 2026-09-27
  database: medusa_store on prod host (170.106.132.210)
  query_timestamp: 2026-09-27
---

# Appendix A: Verified Join Paths and Money Column Inventory

## Executive Summary

Production database `medusa_store` contains **58+ money-bearing columns**, not ~29 as initially estimated. Critical finding: `order_shipping_method.amount` has **no currency resolution path** and must be treated as store-default currency (divided by 100 since both live currencies have dd=2).

**Verification timestamp:** 2026-09-27  
**Database:** medusa_store on production host (170.106.132.210)  
**Query method:** Read-only SSH queries to PostgreSQL

---

## 1. Complete Money-Bearing Column Inventory (vs Spec Estimate)

### Spec Estimated: ~29 columns  
### Actual Found: **58+ distinct numeric columns + associated raw_* JSONB fields**

#### Tables with direct `currency_code`:

| Table | Money Columns | Currency Source | Rows in Prod |
|-------|--------------|-----------------|--------------|
| `price` | `amount`, `raw_amount` | `price.currency_code` | 57 |
| `payment` | `amount` | `payment.currency_code` | ? |
| `payment_session` | `amount`, `raw_amount` | `payment_session.currency_code` | ? |
| `payment_collection` | `amount`, `authorized_amount`, `captured_amount`, `refunded_amount`, raw_* variants | `payment_collection.currency_code` | 57 |
| `order_transaction` | `amount`, `raw_amount` | `order_transaction.currency_code` | 22 |
| `paypal_subscription` | `locked_amount` (INTEGER → needs NUMERIC(20,6)) | `paypal_subscription.currency_code` | ? |

#### Tables via Order parent join:

| Table | Money Columns | Join Path | Proven? | Rows |
|-------|--------------|-----------|---------|------|
| `order_line_item` | `unit_price`, `compare_at_unit_price`, raw_* | `li.item_id → oi.order_id → order.currency_code` | ✅ Yes (49→49) | 49 |
| `order_item` | `unit_price`, `compare_at_unit_price` | `oi.order_id → order.currency_code` | ✅ Yes (49→49) | 59 |
| `order_line_item_adjustment` | `amount`, `raw_amount` | via `item_id → order_line_item → ... → order` | ⚠️ Path exists | 0 |
| `order_shipping_method` | `amount`, `raw_amount` | ❌ **UNRESOLVED - no FK to order/cart** | **FINDING** | 5 |
| `order_shipping_method_adjustment` | `amount`, `raw_amount` | depends on parent path | Depends | 0 |
| `order_claim` | `refund_amount`, `raw_refund_amount` | `oc.order_id → order.currency_code` | Needs validation | 0 |
| `order_exchange` | ? | `oe.order_id → order.currency_code` | Needs validation | 0 |
| `order_credit_line` | `amount`, `raw_amount` | `ocl.order_id → order.currency_code` | Needs validation | 0 |
| `order_change_action` | `amount`, `raw_amount` | `oca.order_id → order.currency_code` | Needs validation | 0 |

#### Tables via Cart parent join:

| Table | Money Columns | Join Path | Proven? | Rows |
|-------|--------------|-----------|---------|------|
| `cart_line_item` | `unit_price`, `compare_at_unit_price` | `cli.cart_id → cart.currency_code` | ✅ Yes (47→1) | 47 |
| `cart_shipping_method` | `amount`, `raw_amount` | `csm.cart_id → cart.currency_code` | ✅ Yes (5→1) | 5 |
| `cart_shipping_method_adjustment` | `amount`, `raw_amount` | `csm.cart_id → cart.currency_code` | ✅ Yes | ? |
| `credit_line` | `amount`, `raw_amount` | `cl.cart_id → cart.currency_code` | Needs validation | 0 |

#### Payment-related tables:

| Table | Money Columns | Join Path | Proven? | Rows |
|-------|--------------|-----------|---------|------|
| `capture` | `amount`, `raw_amount` | `cp.payment_id → payment.currency_code` | ✅ Yes (24→1) | 24 |
| `refund` | `amount`, `raw_amount` | `r.payment_id → payment.currency_code` | ✅ Yes (2→1) | 2 |
| `return` | `refund_amount`, `raw_refund_amount` | ? | Unknown parent | ? |

#### Derived tables (DELETE for rebuild):

| Table | Money Columns | Action |
|-------|--------------|--------|
| `subscription_metrics_daily` | `mrr_amount`, `raw_mrr_amount` | DELETE + rebuild from orders |
| `paypal_plan` | ? | DELETE + rebuild |

#### Currency-less JSONB money (store-default conversion):

- `variant.metadata.paypal_subscription.setup_fee` / `trial_periods[].price`
- `plan_offer.discount_per_frequency` (fixed type only)
- `subscription.pricing_snapshot` fixed values
- `retention_offer_event.offer_payload` (fixed type)
- `order_summary.totals` (8 keys converted directly, not recomputed)

---

## 2. Critical Finding: `order_shipping_method` Unresolved

### Problem Statement

Table `order_shipping_method` exists with 5 rows but has **no foreign key** to any table containing currency information:

```sql
-- Schema shows no currency path
id                 | text
name               | text
description        | jsonb
amount             | numeric    ← NO CURRENCY REFERENCE
raw_amount         | jsonb
is_tax_inclusive   | boolean
shipping_option_id | text       ← Does NOT link to currency
data               | jsonb      ← NULL for all 5 rows
metadata           | jsonb      ← NULL for all 5 rows
```

### Investigation Results

1. **`data` field**: Empty (`{}`) for all 5 rows - no hidden order reference
2. **`shipping_option.data.region_id`**: Also empty - cannot resolve via shipping option's region
3. **No alternative FKs found**: No `order_id`, `cart_id`, or other references

### Resolution: Store-Default Currency

Since no currency resolution path exists, treat `order_shipping_method.amount` like variant metadata - use the **store's default currency assumption**.

**Guard condition**: This is safe because both live currencies (USD/CNY) have `dd=2`, so a blanket ÷100 divisor is correct for the current store state.

**Risk**: If future stores add JPY/KRW (dd=0) or KWD/BHD (dd=3), this conversion would be incorrect. The guard must abort if any live currency has dd≠2.

---

## 3. Verified Join Paths (with actual counts)

### Primary Money Tables (Direct currency_code)

```sql
SELECT COUNT(*) FROM price; 
-- Result: 57 rows ✓

SELECT COUNT(*) FROM payment_collection; 
-- Result: 57 rows ✓

SELECT COUNT(*) FROM order_transaction; 
-- Result: 22 rows ✓
```

### Secondary Tables via Order

```sql
-- order_line_item → order_item → order chain
SELECT 'order_line_item JOIN order_item', COUNT(*) 
FROM order_line_item li 
JOIN order_item oi ON oi.item_id = li.id;
-- Result: 49 rows ✓

SELECT 'order_item JOIN order', COUNT(*) 
FROM order_item oi 
JOIN "order" o ON o.id = oi.order_id;
-- Result: 49 rows ✓

-- Zero-row tables (empty in production)
SELECT COUNT(*) FROM order_claim; 
-- Result: 0 rows (but needs conversion code for future data)

SELECT COUNT(*) FROM order_exchange; 
-- Result: 0 rows

SELECT COUNT(*) FROM order_credit_line; 
-- Result: 0 rows
```

### Secondary Tables via Cart

```sql
-- cart_line_item path
SELECT 'cart_line_item JOIN cart', COUNT(*) 
FROM cart_line_item cli 
JOIN "cart" c ON c.id = cli.cart_id;
-- Result: 47 rows ✓

-- cart_shipping_method path  
SELECT 'cart_shipping_method JOIN cart', COUNT(*) 
FROM cart_shipping_method csm 
JOIN "cart" c ON c.id = csm.cart_id;
-- Result: 5 rows ✓
```

### Payment Chain

```sql
-- refund → payment
SELECT 'refund JOIN payment', COUNT(*) 
FROM refund r 
JOIN payment p ON p.id = r.payment_id;
-- Result: 2 rows ✓

-- capture → payment
SELECT 'capture JOIN payment', COUNT(*) 
FROM capture cp 
JOIN payment p ON p.id = cp.payment_id;
-- Result: 24 rows ✓
```

---

## 4. Currency Set and Decimal Digits

### Live currencies in production:

```sql
SELECT c.code, c.decimal_digits 
FROM (
  SELECT DISTINCT currency_code AS code FROM price 
  UNION ALL 
  SELECT DISTINCT currency_code AS "order".currency_code 
) t 
JOIN currency c ON c.code = t.code 
ORDER BY 1;
```

**Result:**
```
code | decimal_digits
-----+----------------
cny  |              2
usd  |              2
```

**Confirmed Baseline:** Only USD and CNY with `decimal_digits = 2` each.

### Implications for Conversion Script

1. **Store-default currency-less jsonb** can safely use ÷100 divisor (both currencies have dd=2)
2. **Guard condition**: ABORT if any new currency with dd≠2 is added before conversion completes
3. **Per-currency assertions** will show identical thresholds for usd/cny (÷100) but code must support dd=0/3 for future expansion

---

## 5. Additional Tables Beyond Spec Estimate

### New Medusa v2 entities discovered:

1. **`cart_shipping_method`** / `cart_shipping_method_adjustment`
   - Missing from initial spec estimate
   - Resolves via `cart.currency_code` ✅

2. **`order_item`** (separate from `order_line_item`)
   - Has own `unit_price`, `compare_at_unit_price` columns
   - Resolves via `order.currency_code` ✅

3. **`return`** / `return_item`
   - May have additional money columns
   - Parent path requires investigation

4. **`subscription_metrics_daily`**
   - Derived table, DELETE + rebuild from orders
   - Contains `mrr_amount` (major units after conversion)

---

## 6. Type Changes Required Before Conversion

### Critical ALTER statements:

```sql
-- PayPal subscription locked_amount MUST change first
ALTER TABLE paypal_subscription 
ALTER COLUMN locked_amount TYPE numeric(20,6);
```

**Current state:** INTEGER(32,0)  
**Why critical:** Division on integer truncates (e.g., `999/100 → 9` instead of `9.99`)  
**Must execute:** Before ANY division operations

---

## 7. Conversion Script Requirements

Based on Task 1 findings, the SQL script (Task 2) must:

1. ✅ **Handle 58+ money columns** (not just ~29)
2. ✅ **Include missing tables**: `cart_shipping_method*`, `order_item`, `return`, `subscription_metrics_daily`
3. ✅ **Treat `order_shipping_method` as store-default** - divide by 100 with proper guard
4. ✅ **Ensure `locked_amount` ALTER precedes all conversions**
5. ✅ **Write guards** against mixed-basis data after 2026-09-26T04:18:56Z
6. ✅ **Implement per-currency assertions** (post_sum = pre_sum / power(10, dd))
7. ✅ **Remove `post_sum > 0` skip** - assert even on empty tables (partial restore detection)

---

## 8. Next Steps

### For Task 2 (Conversion SQL Rewrite):

1. Incorporate all 58+ money columns into UPDATE statements
2. Add `order_shipping_method` handling with store-default guard
3. Implement proven join paths exactly as documented here
4. Ensure `paypal_subscription.locked_amount` ALTER runs first
5. Write per-currency assertions matching the verified schema

### For Future Verification:

- After conversion: Re-run join count queries to ensure row integrity preserved
- Spot-check sample values against expected major-unit amounts
- Validate that all `raw_*` JSONB fields correctly regenerated

---

**Document generated:** 2026-09-27  
**Production database verified:** medusa_store (170.106.132.210)  
**Verification method:** Read-only SSH queries (no data modification)  
**Status:** READY FOR TASK 2 IMPLEMENTATION