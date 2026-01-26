# PgDumpLens Demo Dump Files

This directory contains sample PostgreSQL dump files for demonstrating PgDumpLens features.

## 📦 Available Demo Dumps

### 1. E-Commerce System (`ecommerce_demo.sql`) - Base Version

A complete e-commerce database with realistic data demonstrating all major features:

| Feature              | Demo Content                                          |
| -------------------- | ----------------------------------------------------- |
| **ER Diagram**       | 15 interconnected tables with clear relationships     |
| **FK Relationships** | CASCADE, RESTRICT, SET NULL constraints               |
| **Risk Assessment**  | High-risk `users` table referenced by 6 other tables  |
| **JSON Viewer**      | JSONB columns: preferences, attributes, dimensions    |
| **Full-Text Search** | Emails, product names, addresses, SKUs                |
| **Data Types**       | VARCHAR, TEXT, DECIMAL, TIMESTAMP, JSONB, ARRAY, INET |

#### Schema Overview

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   users     │◄────│    orders    │────►│ order_items  │
│  (10 rows)  │     │  (10 rows)   │     │  (11 rows)   │
└─────────────┘     └──────────────┘     └──────────────┘
      │                    │                    │
      │                    │                    │
      ▼                    ▼                    ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  addresses  │     │ order_coupons│     │   products   │
│  (8 rows)   │     │   (4 rows)   │     │  (18 rows)   │
└─────────────┘     └──────────────┘     └──────────────┘
                                               │
      ┌────────────────────┬───────────────────┤
      │                    │                   │
      ▼                    ▼                   ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   reviews   │     │product_images│     │  categories  │
│  (10 rows)  │     │  (10 rows)   │     │  (12 rows)   │
└─────────────┘     └──────────────┘     └──────────────┘
```

#### Key Features Demonstrated

**🔴 High-Risk Tables (Risk Assessment)**

- `users` - Referenced by orders, reviews, addresses, cart, audit_logs (CRITICAL risk)
- `products` - Referenced by order_items, reviews, cart, product_images

**🔗 FK Constraint Types**

- `ON DELETE CASCADE` - user_addresses, order_items, reviews
- `ON DELETE RESTRICT` - orders (protects order history)
- `ON DELETE SET NULL` - products.category_id, inventory_logs.created_by

**📊 JSON/JSONB Data Examples**

```json
// users.preferences
{"theme": "dark", "notifications": {"email": true, "push": true}, "language": "ja"}

// products.attributes  
{"color": "Natural Titanium", "storage": "256GB", "carrier": "SIM Free"}

// products.dimensions
{"length": 14.6, "width": 7.1, "height": 0.83, "unit": "cm"}

// orders.shipping_address
{"name": "田中 太郎", "street": "4-5-6 Shibuya", "city": "Shibuya-ku, Tokyo"}
```

**🔍 Searchable Content**

- Email addresses: `admin@example.com`, `tanaka.taro@example.com`
- Product SKUs: `SP-001`, `LP-001`, `AC-001`
- Order numbers: `ORD-2026-0001`
- Phone numbers: `+81-90-1234-5678`
- Addresses: `Shibuya`, `San Francisco`, `London`

---

## 🚀 How to Use

### Upload via Web UI

1. Start PgDumpLens

   ```bash
   docker compose up -d
   ```

2. Open <http://localhost:3000>

3. Click "Upload New Dump"

4. Select `demo/ecommerce_demo.sql`

5. Explore!

### Upload via CLI

```bash
# Linux/Mac
./scripts/upload-dump.sh ./demo/ecommerce_demo.sql "E-Commerce Demo" http://localhost:8080

# Windows PowerShell
.\scripts\upload-dump.ps1 -DumpFile .\demo\ecommerce_demo.sql -Name "E-Commerce Demo"
```

---

## 🎯 Recommended Exploration Path

1. **ER Diagram** - View the relationship visualization
2. **Table List** - Check the risk scores (users should be Critical)
3. **Data Preview** - Open `users` table, try transpose view
4. **JSON Viewer** - Click on `preferences` column values
5. **Relationship Explorer** - Click `user_id` in orders table
6. **Full-Text Search** - Search for "example.com"
7. **Copy Features** - Try CSV/JSON copy with transpose

---

## 📝 Creating Your Own Demo Dumps

To create a dump from an existing PostgreSQL database:

```bash
# Single database (recommended)
pg_dump -Fp mydb > mydb_demo.sql

# With data only
pg_dump -Fp --data-only mydb > mydb_data.sql

# Multiple databases
pg_dumpall > all_databases.sql
```

---

---

### 2. E-Commerce System Updated (`ecommerce_demo_v2.sql`) - For Diff Comparison

An **updated version** of the e-commerce database with various changes to demonstrate the **Dump Diff Comparison** feature.

#### Changes from Base Version

| Change Type           | Details                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **🟢 Tables Added**    | `wishlists`, `product_variants`                                                           |
| **🔴 Tables Removed**  | `shopping_cart` (replaced with session-based cart)                                        |
| **🟡 Schema Modified** | `users` (+2 columns), `products` (+1 column), `orders` (+1 column), `order_items` (+1 FK) |
| **🟠 Data Changed**    | New users, orders, products, reviews added; existing data modified                        |
| **🔗 FK Changed**      | New foreign keys for wishlists and variants                                               |

#### Schema Changes Detail

```
users table:
  + last_login_at (TIMESTAMP WITH TIME ZONE)  -- NEW
  + login_count (INTEGER)                      -- NEW

products table:
  + status (VARCHAR(20))                       -- NEW
  ~ description (TEXT → TEXT NOT NULL)         -- MODIFIED

orders table:
  + tracking_number (VARCHAR(100))             -- NEW

order_items table:
  + variant_id (FK → product_variants)         -- NEW
```

#### Data Changes Summary

| Table         | Added                | Modified            | Removed             |
| ------------- | -------------------- | ------------------- | ------------------- |
| users         | +2 (id: 11, 12)      | +login data for all | -                   |
| categories    | +1 (Outdoor)         | -                   | -                   |
| products      | +2 (iPhone 16, Tent) | iPhone 15 price ↓   | -                   |
| orders        | +2 (id: 11, 12)      | status updates      | -                   |
| reviews       | +2                   | -                   | -                   |
| coupons       | +1 (OUTDOOR10)       | used_count ↑        | -                   |
| shopping_cart | -                    | -                   | ALL (table removed) |

---

## 🔄 Using the Diff Feature

### Step 1: Upload Base Version

1. Start PgDumpLens
2. Upload `ecommerce_demo.sql` as "E-Commerce (Base)"

### Step 2: Compare with Updated Version

1. Open the uploaded dump detail page
2. Click "Compare Dumps" tab
3. Upload `ecommerce_demo_v2.sql`
4. Wait for analysis to complete

### Step 3: Explore Differences

You'll see:

```
Diff Summary
┌──────────────┬──────────────┬──────────────┬────────────┐
│   Added      │   Removed    │   Modified   │  Data Only │
│   2 tables   │   1 table    │   4 tables   │  5 tables  │
└──────────────┴──────────────┴──────────────┴────────────┘
```

**Try These Features:**

1. **Schema Diff** - See column additions/removals
2. **Data Diff** - Click "View Data Diff" to see row-level changes
3. **FK Diff** - Check new foreign key relationships
4. **Filter by Type** - Use tabs to filter Added/Removed/Modified

---

Happy exploring! 🔍
