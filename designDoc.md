# DB Dump Visualization & Risk-Aware Explorer  

**Design Document (v1)**  
Target Stack: **Rust / Next.js / PostgreSQL / Kubernetes**

---

## 1. Overview

This service ingests a database dump (initially PostgreSQL), restores it into an isolated sandbox environment, and provides a web UI and CLI-driven workflow to:

- Visualize schema structure via ER diagrams
- Browse and search real restored data
- Suggest related values during search/edit workflows
- Explain table/column relationships when a value is selected
- Assess and display **data modification/deletion risk**
- Provide **equivalent SQL examples** for all relationship-based views

Each uploaded dump corresponds to a **dedicated view page** with a stable URL, expiring automatically after a fixed TTL.

---

## 2. Goals and Non-Goals

### Goals

- Prevent accidental data corruption by making relationships and risks explicit
- Support both **UI users** and **script/CLI users**
- Emphasize **performance**, **read-only safety**, and **explainability**
- Enable future extension to other databases with minimal redesign

### Non-Goals (v1)

- Writing data back to production databases
- Cross-database (multi-dump) joins
- Full SQL console access (read-only DSL only)

---

## 3. User Experience Summary

### UI Users

1. Upload a PostgreSQL dump
2. Wait for restore and analysis
3. Access `/d/{slug}` to:
   - View ER diagram
   - Browse tables and rows
   - Search with suggestions
   - Click values to inspect relationships, risks, and SQL examples

### CLI Users

- Upload a dump via script
- Optionally wait for completion
- Receive the **final view URL** as output

Example:

```bash
dbviz upload --file dump.sql --name my-snapshot --wait
# -> https://example.com/d/my-snapshot
````

---

## 4. Core Concepts

### Dump (Primary Unit)

A single uploaded database dump.

Each dump has:

- A unique internal ID (UUID)
- A human-friendly **slug** used in URLs
- Its own restored sandbox database
- Independent lifecycle and TTL

---

## 5. URL and Naming Model

### View URL

```text
/d/{slug}
```

### Slug Rules

- User-provided name → slugified
- If omitted → random short identifier (8–12 chars)
- Guaranteed uniqueness (suffix if needed)

### Internal Identity

- All internal references use `dump_id` (UUID)
- Slug is a stable external alias

---

## 6. Architecture

### Components

- **Frontend**

  - Next.js (React)
  - ER visualization, table viewer, relationship panels

- **API Server**

  - Rust (Axum)
  - Authentication, metadata queries, read-only data access

- **Worker**

  - Rust async worker
  - Restore dumps, introspect schema, compute statistics

- **Sandbox PostgreSQL**

  - Shared cluster
  - One database per dump

- **Metadata PostgreSQL**

  - Stores schema graphs, statistics, job state, TTL info

---

## 7. Kubernetes Deployment

### Pods

- `api`
- `worker`
- `frontend`
- `metadata-postgres`
- `sandbox-postgres`

### Storage

- **No S3**
- Local disk via:

  - `hostPath` (single-node / dev)
  - or local PV/PVC (multi-node)

### Paths

```text
/data/uploads/{dump_id}/dump.sql
/data/uploads/{dump_id}/logs/
```

---

## 8. Dump Lifecycle

1. Dump session created
2. File uploaded (streamed to disk)
3. Restore job started
4. Schema introspection
5. Profiling & relationship graph build
6. Dump becomes **READY**
7. Auto-deletion after 7 days

---

## 9. TTL and Cleanup

- TTL: **7 days**
- Implemented via Kubernetes `CronJob`
- Cleanup steps:

  - Drop sandbox database
  - Delete local dump directory
  - Mark dump as `deleted` in metadata DB

---

## 10. Database Adapter Abstraction

To support future DB engines:

```text
DbAdapter
 ├─ restore_dump()
 ├─ list_tables()
 ├─ list_columns()
 ├─ list_foreign_keys()
 ├─ estimate_row_counts()
 ├─ fetch_sample_rows()
 ├─ generate_sql_examples()
```

### v1 Implementation

- `PostgresAdapter`

---

## 11. ER Diagram Generation

- Source: foreign key graph from metadata
- Format: Mermaid ER syntax
- Filters:

  - Schema-based
  - N-hop relationship scoping

---

## 12. Data Search and Suggest

### Search

- Table-scoped filtering
- Read-only queries only
- Limits enforced

### Suggest Sources

- Top-N frequent values
- Prefix matches
- Foreign-key referenced values
- Type-aware defaults (UUID, timestamps)

All suggestions are pre-profiled by the worker when possible.

---

## 13. Relationship Exploration

Triggered when a user clicks a value in a table cell.

### Returned Information

- Related tables and columns
- Relationship direction (inbound / outbound)
- Join paths (up to configurable hops)
- Sample joined rows
- **Equivalent SQL examples**
- Risk score with explanation

---

## 14. SQL Example Generation

For each relationship path, the system emits SQL such as:

```sql
-- Rows referencing the selected value
SELECT *
FROM child_schema.child_table c
WHERE c.child_fk_column = $1
LIMIT 50;
```

```sql
-- Join preview along relationship path
SELECT c.*, p.*
FROM child_schema.child_table c
JOIN parent_schema.parent_table p
  ON p.id = c.parent_id
WHERE c.parent_id = $1
LIMIT 50;
```

These SQL samples are guaranteed to align with the UI-displayed relationship graph.

---

## 15. Risk Scoring Model

Risk scores range from **0–100** and are cached.

### Factors

- Number of inbound foreign keys
- Estimated referencing row count
- ON DELETE / ON UPDATE behavior
- Primary key or unique constraint involvement
- NULL constraints
- Data frequency and distribution

### Output

- Numeric score
- Human-readable reasons
- Highlighted “why this is dangerous”

---

## 16. API Surface (High Level)

### Dump Management

- `POST /api/dumps`
- `PUT /api/dumps/{id}/upload`
- `POST /api/dumps/{id}/restore`
- `GET /api/dumps/{id}`

### Schema & Data

- `GET /api/dumps/{id}/schema`
- `GET /api/dumps/{id}/tables/{schema}.{table}`
- `GET /api/dumps/{id}/suggest`

### Relationships & Risk

- `POST /api/dumps/{id}/relation/explain`
- `GET /api/dumps/{id}/risk/table/...`
- `GET /api/dumps/{id}/risk/column/...`

---

## 17. Security Model

- Sandbox DB is not directly exposed
- Only SELECT operations allowed
- Query AST validation
- Hard limits on rows, time, joins
- Dump isolation per user/session

---

## 18. Repository Layout

```bash
repo/
  backend/
    core/
    api/
    worker/
  frontend/
  deploy/
    k8s/
  docs/
    design.md
```

---

## 19. MVP Milestones

1. Dump upload (UI + CLI)
2. Restore into sandbox DB
3. ER diagram rendering
4. Table browsing
5. Relationship explain + SQL samples
6. TTL cleanup automation

---

## 20. Future Extensions

- Support MySQL / MSSQL via new adapters
- View/function/trigger dependency analysis
- Precision “what happens if deleted” simulations
- Team sharing and permission levels
- Advanced query builder UI

---

## 21. Testing Strategy

### Overview

Testing is critical for ensuring the reliability, safety, and correctness of the DB Dump Visualization service. All components follow a multi-layer testing approach.

### Test Levels

#### Unit Tests

- **Backend (Rust)**
  - Core domain logic (schema parsing, risk calculation, SQL generation)
  - Adapter implementations (mocked DB connections)
  - API handlers (mocked dependencies)
  - Worker job processing logic
  
- **Frontend (Next.js)**
  - React component tests (React Testing Library)
  - Utility function tests
  - API client tests (mocked responses)

#### Integration Tests

- **Backend**
  - API endpoint tests with real HTTP calls
  - Database adapter tests against test containers
  - Worker-to-API communication tests
  
- **Frontend**
  - Page-level integration tests
  - API integration with MSW (Mock Service Worker)

#### End-to-End Tests

- Full workflow tests using Playwright
  - Dump upload → restore → view
  - ER diagram rendering
  - Relationship exploration
  - Risk assessment display

### Test Coverage Requirements

| Component | Minimum Coverage |
|-----------|------------------|
| Backend Core | 80% |
| Backend API | 75% |
| Backend Worker | 70% |
| Frontend Components | 70% |
| Frontend Pages | 60% |

### Test Tools

| Layer | Tool |
|-------|------|
| Rust Unit/Integration | `cargo test`, `tokio-test` |
| Rust Mocking | `mockall`, `wiremock` |
| Rust Test DB | `testcontainers-rs` |
| Frontend Unit | `vitest`, `@testing-library/react` |
| Frontend E2E | `Playwright` |
| API Mocking | `MSW (Mock Service Worker)` |

### CI/CD Integration

```yaml
# .github/workflows/test.yml (conceptual)
tests:
  - backend-unit: cargo test --workspace
  - backend-integration: cargo test --features integration
  - frontend-unit: yarn test
  - frontend-e2e: yarn test:e2e
  - coverage-report: cargo llvm-cov, yarn test:coverage
```

### Test Data Management

- **Fixtures**: Pre-defined SQL dump files for consistent testing
- **Factories**: Programmatic test data generation
- **Snapshots**: Expected schema/ER diagram outputs
- **Seed Scripts**: Reproducible test database states

### Risk-Specific Tests

Given the risk-assessment nature of this service, dedicated tests ensure:

- Risk scores are calculated correctly for various FK configurations
- ON DELETE CASCADE chains are properly traced
- High-risk operations are correctly flagged
- SQL examples match relationship graphs exactly

---

**This document defines the authoritative v1 specification.**
