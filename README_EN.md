# PgDumpLens

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-9.6--17-blue.svg)](https://www.postgresql.org/)

> Visualize and analyze PostgreSQL dump files - ER diagrams, data browsing, and impact risk assessment

A web application for uploading PostgreSQL dump files and visualizing/analyzing database structures.

**English | [日本語](README.md)**

## 📋 Features

- **Dump Upload**: Upload dump files created with `pg_dump` / `pg_dumpall`
- **Multi-Database Support**: View and switch between multiple databases in `pg_dumpall` format
- **ER Diagram Generation**: Automatically visualize table relationships with Mermaid.js (PNG/SVG export)
- **Data Browsing**: Browse table data in your browser with pagination
- **Transpose View**: Switch between row/column views for easier data inspection
- **Data Copy**: Copy data as CSV, JSON, or individual cell values
- **Value Filtering**: Filter by column values with frequent value suggestions
- **Relationship Explorer**: Click cells to view related tables, JOIN paths, and sample SQL
- **Impact Risk Assessment**: Score the impact of data changes (considering CASCADE dependencies)
- **Dump Diff Comparison**: Visualize schema and data differences between two dumps
  - Schema diff: tables/columns/foreign keys additions, deletions, modifications
  - Data diff: Auto-detect data changes via MD5 checksums
  - Per-table data comparison with row-level diff view
- **URL State Persistence**: Browser back/forward navigation, URL sharing, state preservation on reload
- **Dark Mode Support**: Full dark mode support for all UI components
- **TTL Auto-Deletion**: Automatic cleanup of dumps after a specified time

### 📦 Supported File Formats

| Format    | Extension             | Description                |
| --------- | --------------------- | -------------------------- |
| Plain SQL | `.sql`                | Created with `pg_dump -Fp` |
| Custom    | `.dump`, `.backup`    | Created with `pg_dump -Fc` |
| Gzip      | `.sql.gz`, `.dump.gz` | Gzip compressed versions   |

> **Note**: File format is auto-detected by magic bytes, not by extension.

### 🐘 PostgreSQL Version Support

PgDumpLens supports the following PostgreSQL versions:

| Target               | Supported Versions | Description                                      |
| -------------------- | ------------------ | ------------------------------------------------ |
| **Dump file source** | 9.6 - 17.x         | Dump files created with `pg_dump` / `pg_dumpall` |
| **Metadata DB**      | 16.x (recommended) | Used internally by the application               |
| **Sandbox DB**       | 16.x (recommended) | Where dump files are restored                    |

#### Compatibility Details

- **Backward Compatibility**: Supports dump files from PostgreSQL 9.6+
  - Uses `information_schema` and `pg_stat_user_tables` (standardized in 9.6)
  - Basic schema information retrieval works with older versions
  
- **Recommended Version**: PostgreSQL 12+
  - More accurate `pg_stat_user_tables` statistics
  - Full JSON/JSONB type support
  - Partition table metadata support
  
- **Latest Version**: Tested up to PostgreSQL 17.x
  - No compatibility issues with SQL command changes or new features
  - Full support for `pg_dump` custom format (-Fc)

#### Verified Versions

Tested and working with:
- ✅ PostgreSQL 9.6
- ✅ PostgreSQL 10.x
- ✅ PostgreSQL 11.x
- ✅ PostgreSQL 12.x
- ✅ PostgreSQL 13.x
- ✅ PostgreSQL 14.x
- ✅ PostgreSQL 15.x
- ✅ PostgreSQL 16.x (recommended)
- ✅ PostgreSQL 17.x

> **Note**: Dump files from PostgreSQL 9.5 or earlier may have limited statistics information.

## 🏗️ Architecture

```text
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Frontend      │────>│   API Server    │────>│  Metadata DB    │
│   (Next.js)     │     │   (Rust/Axum)   │     │  (PostgreSQL)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │   Sandbox DB    │
                        │  (PostgreSQL)   │
                        └─────────────────┘
```

## 🚀 Quick Start (Development)

### Prerequisites

- [Docker](https://www.docker.com/) & Docker Compose
- [Rust](https://rustup.rs/) (1.75+)
- [Node.js](https://nodejs.org/) (20+)
- [Yarn](https://yarnpkg.com/) (4.x)

### 1. Clone the Repository

```bash
git clone https://github.com/pkaiy81/pgdumplens.git
cd pgdumplens
```

### 2. Start with Docker Compose

#### Standard Mode (Recommended)

```bash
docker compose up -d
```

This starts:

- **API Server**: <http://localhost:8080>
- **Frontend**: <http://localhost:3000>
- **Metadata DB**: localhost:5432
- **Sandbox DB**: localhost:5433
- **Worker**: Background job processing

#### Hot-Reload Development Mode

Auto-rebuild on source code changes:

```bash
docker compose -f docker-compose.dev.yml up
```

- Frontend: Runs with `yarn dev` (instant updates)
- Backend: Runs with `cargo-watch` (auto-rebuild on changes)

### 3. Set Environment Variables (Local Development Only)

If running directly without Docker Compose:

```bash
# Backend
cp backend/.env.example backend/.env

# Frontend
cp frontend/.env.example frontend/.env.local
```

### 4. Direct Local Execution (Optional)

Running without Docker:

```bash
# Start databases only
docker compose up -d metadata-db sandbox-db

# Backend
cd backend
cargo run --bin api-server

# Worker (separate terminal)
cd backend
cargo run --bin worker

# Frontend (separate terminal)
cd frontend
yarn install && yarn dev
```

The app starts at <http://localhost:3000>.

## 📁 Project Structure

```bash
pgdumplens/
├── backend/                 # Rust backend
│   ├── api/                 # API server (Axum)
│   ├── core/                # Core logic (domain, adapters)
│   ├── worker/              # Async job worker
│   └── migrations/          # DB migrations
├── frontend/                # Next.js frontend
│   ├── src/app/             # App Router pages
│   ├── src/components/      # React components
│   └── src/lib/             # Utilities
├── deploy/                  # Deployment configs
│   ├── k8s/                 # Kubernetes manifests
│   └── nginx/               # Nginx config
├── scripts/                 # CLI tools
│   ├── upload-dump.sh       # Linux/Mac upload script
│   └── upload-dump.ps1      # Windows upload script
├── docs/                    # Documentation
│   └── architecture.md      # Architecture diagrams
├── docker-compose.yml       # Standard dev environment (pre-built images)
├── docker-compose.dev.yml   # Hot-reload dev environment
└── docker-compose.prod.yml  # Production (with Nginx reverse proxy)
```

## 🖥️ CLI Upload

Upload dumps from the command line without using a browser.

### Linux / Mac

```bash
./scripts/upload-dump.sh ./backup.sql "Production DB" http://localhost:8080
```

### Windows (PowerShell)

```powershell
.\scripts\upload-dump.ps1 -DumpFile .\backup.sql -Name "Production DB" -ServerUrl http://localhost:8080
```

### Features

- File upload
- Auto-wait for analysis completion
- Display table count and risk levels

## 🧪 Testing

### Backend Tests

```bash
cd backend
cargo test
```

### Frontend Tests

```bash
cd frontend
yarn test        # Unit tests (vitest)
yarn test:e2e    # E2E tests (playwright)
```

## 🔧 Development Commands

### Backend Commands

```bash
# Build
cargo build

# Format
cargo fmt

# Lint
cargo clippy

# Run Worker
cargo run --bin worker
```

### Frontend Commands

```bash
# Dev server
yarn dev

# Production build
yarn build

# Lint
yarn lint

# Test (watch mode)
yarn test
```

## 📝 Logging

### Backend

Structured logging using the `tracing` crate.

```bash
# Set log level
RUST_LOG=info cargo run --bin api-server

# Enable debug logging
RUST_LOG=debug cargo run --bin api-server

# Debug specific modules only
RUST_LOG=db_viewer_api=debug,db_viewer_core=info cargo run --bin api-server
```

### Nginx (Production)

Access logs configured in `deploy/nginx/nginx.conf`:

- Request time
- Upstream response time
- Client IP

## 🐳 Docker Build

```bash
# API server
docker build -t pgdumplens-api ./backend

# Frontend
docker build -t pgdumplens-frontend ./frontend
```

## 🚀 Production Deployment

### Deployment Options

| Method                 | Use Case                | Complexity  | Internet Required |
| ---------------------- | ----------------------- | ----------- | ----------------- |
| **GHCR Images**        | Restricted/Offline envs | ⭐ Easiest   | Initial only      |
| Docker Compose (Build) | Dev/Small scale         | ⭐⭐ Easy     | Yes               |
| Kubernetes             | Enterprise              | ⭐⭐⭐ Complex | Initial only      |

---

### 🏢 Restricted/Offline Environment Deployment (Recommended)

**For environments without npm/yarn/cargo, or with internet restrictions**

Fetch pre-built Docker images from GitHub Container Registry (GHCR).
**No source code build required**.

#### Prerequisites

- Docker Engine installed
- Temporary access to GHCR (`ghcr.io`) for image pull

#### Step 1: Pull Docker Images

Run in an internet-connected environment:

```bash
# Pull PgDumpLens images
docker pull ghcr.io/pkaiy81/pgdumplens/api:latest
docker pull ghcr.io/pkaiy81/pgdumplens/frontend:latest

# Pull dependency images
docker pull postgres:16-alpine
docker pull nginx:alpine
```

#### Step 2: Export for Offline Environment (If Needed)

For air-gapped environments:

```bash
# Export images to files
docker save ghcr.io/pkaiy81/pgdumplens/api:latest | gzip > pgdumplens-api.tar.gz
docker save ghcr.io/pkaiy81/pgdumplens/frontend:latest | gzip > pgdumplens-frontend.tar.gz
docker save postgres:16-alpine | gzip > postgres.tar.gz
docker save nginx:alpine | gzip > nginx.tar.gz

# Check file sizes (total ~500MB)
ls -lh *.tar.gz
```

Transfer via USB or internal file server to the offline environment.

#### Step 3: Import in Offline Environment

```bash
# Import images
gunzip -c pgdumplens-api.tar.gz | docker load
gunzip -c pgdumplens-frontend.tar.gz | docker load
gunzip -c postgres.tar.gz | docker load
gunzip -c nginx.tar.gz | docker load

# Verify
docker images | grep -E "pgdumplens|postgres|nginx"
```

#### Step 4: Start

```bash
# Create environment file
cat > .env << 'EOF'
# External port (adjust for your environment)
HTTP_PORT=8080

# DB authentication (use secure passwords in production)
DB_PASSWORD=your_secure_password
SANDBOX_PASSWORD=your_secure_password

# Upload directory
UPLOAD_DIR=/dumps
EOF

# Start
docker compose -f docker-compose.offline.yml up -d

# Verify
docker compose -f docker-compose.offline.yml ps
curl http://localhost:${HTTP_PORT}/health
```

#### Required Files (For Offline Deployment)

| File                         | Description           | Required    |
| ---------------------------- | --------------------- | ----------- |
| `pgdumplens-api.tar.gz`      | API server image      | ✅           |
| `pgdumplens-frontend.tar.gz` | Frontend image        | ✅           |
| `postgres.tar.gz`            | PostgreSQL image      | ✅           |
| `nginx.tar.gz`               | Nginx image           | ✅           |
| `docker-compose.offline.yml` | Startup config        | ✅           |
| `deploy/nginx/nginx.conf`    | Nginx config          | ✅           |
| `.env`                       | Environment variables | Situational |

---

### Docker Compose Deployment (Source Build)

**For environments with internet access, building from source**

```bash
# 1. Clone source code
git clone <repo-url> pgdumplens && cd pgdumplens

# 2. Set environment variables
cp .env.example .env
vi .env  # Set passwords, etc.

# 3. Start production environment
docker compose -f docker-compose.prod.yml up -d --build

# 4. Verify
docker compose -f docker-compose.prod.yml ps
curl http://localhost/health

# 5. Check logs
docker compose -f docker-compose.prod.yml logs -f api
```

**Included Services**:

- API Server (Rust/Axum)
- Frontend (Next.js)
- Worker (Async jobs)
- Metadata DB (PostgreSQL)
- Sandbox DB (PostgreSQL)
- Nginx (Reverse proxy)

---

## ☸️ Kubernetes Deployment

**For enterprise/cloud environments**. Deploy on AWS EKS / GCP GKE / Azure AKS.

### Docker Compose vs Kubernetes

| Feature             | Docker Compose | Kubernetes       |
| ------------------- | -------------- | ---------------- |
| **Scaling**         | Manual         | Auto-scaling     |
| **Availability**    | Single machine | Multi-node       |
| **Load Balancing**  | Manual (Nginx) | Built-in         |
| **Rolling Updates** | None           | Automatic        |
| **Self-Healing**    | None           | Auto Pod restart |

### When to Use Kubernetes

- Multiple concurrent users
- High availability (99.9%+) required
- Auto-scaling needed
- Using cloud managed services

### Deployment Steps

```bash
# 1. Create namespace
kubectl apply -f deploy/k8s/namespace.yaml

# 2. Create secrets
cp deploy/k8s/secret.template.yaml deploy/k8s/secret.yaml
# Edit secret.yaml with Base64-encoded passwords
kubectl apply -f deploy/k8s/secret.yaml

# 3. Deploy ConfigMap
kubectl apply -f deploy/k8s/configmap.yaml

# 4. Create persistent volumes
kubectl apply -f deploy/k8s/pvc.yaml

# 5. Deploy databases
kubectl apply -f deploy/k8s/metadata-postgres.yaml
kubectl apply -f deploy/k8s/sandbox-postgres.yaml

# 6. Deploy application
kubectl apply -f deploy/k8s/api.yaml
kubectl apply -f deploy/k8s/frontend.yaml
kubectl apply -f deploy/k8s/worker.yaml

# 7. Configure Ingress
kubectl apply -f deploy/k8s/ingress.yaml

# 8. Set up cleanup job
kubectl apply -f deploy/k8s/cronjob-cleanup.yaml

# Verify
kubectl get pods -n pgdumplens
kubectl get svc -n pgdumplens
```

### Manifest List

| File                     | Description                    |
| ------------------------ | ------------------------------ |
| `namespace.yaml`         | pgdumplens namespace           |
| `secret.template.yaml`   | Secrets (DB passwords, etc.)   |
| `configmap.yaml`         | Environment configuration      |
| `pvc.yaml`               | Persistent volumes (dumps, DB) |
| `metadata-postgres.yaml` | Metadata DB StatefulSet        |
| `sandbox-postgres.yaml`  | Sandbox DB StatefulSet         |
| `api.yaml`               | API server Deployment          |
| `frontend.yaml`          | Frontend Deployment            |
| `worker.yaml`            | Worker Deployment              |
| `ingress.yaml`           | Ingress (external access)      |
| `cronjob-cleanup.yaml`   | Expired dump cleanup CronJob   |

## 📊 API Endpoints

| Endpoint                                                | Method | Description           |
| ------------------------------------------------------- | ------ | --------------------- |
| `/health`                                               | GET    | Health check          |
| `/api/dumps`                                            | GET    | List dumps            |
| `/api/dumps`                                            | POST   | Create dump session   |
| `/api/dumps/{id}`                                       | GET    | Get dump details      |
| `/api/dumps/{id}/upload`                                | PUT    | Upload dump file      |
| `/api/dumps/{id}/restore`                               | POST   | Start restore         |
| `/api/dumps/{id}/databases`                             | GET    | List databases        |
| `/api/dumps/{id}/schema`                                | GET    | Get schema info       |
| `/api/dumps/{id}/tables/{table}`                        | GET    | Get table data        |
| `/api/dumps/{id}/suggest`                               | GET    | Get value suggestions |
| `/api/dumps/{id}/relation/explain`                      | POST   | Explain relationship  |
| `/api/dumps/{id}/risk/table/{schema}/{table}`           | GET    | Get table risk        |
| `/api/dumps/{id}/risk/column/{schema}/{table}/{column}` | GET    | Get column risk       |
| `/api/dumps/{id}/compare/{compare_id}`                  | GET    | Compare schemas       |
| `/api/dumps/{id}/compare/{compare_id}/data-diff`        | GET    | Get table data diff   |
| `/api/dumps/{id}/search`                                | GET    | Full-text search      |
| `/api/dumps/by-slug/{slug}`                             | GET    | Get dump by slug      |

## 🎯 Risk Assessment Logic

PgDumpLens automatically evaluates the impact of data changes/deletions and visualizes it as a score from 0-100.

### Risk Score Calculation (0-100 points)

#### 📊 Table-Level Risk (`calculate_table_risk`)

Evaluates risk of operations on the entire table (bulk delete, truncate, etc.).

| Factor                                 | Points           | Description                                       |
| -------------------------------------- | ---------------- | ------------------------------------------------- |
| Inbound foreign keys                   | 10 each (max 30) | Number of foreign keys referencing this table     |
| CASCADE delete behavior                | 15 each (max 30) | ON DELETE CASCADE foreign keys (cascade deletion) |
| RESTRICT/NoAction                      | 10               | Foreign keys that block deletion                  |
| Large table (>10,000 rows)             | 10               | May take significant processing time              |
| Primary key referenced by other tables | 10               | Possibly an important reference source            |

**Implementation**: `backend/core/src/risk.rs` - `calculate_table_risk()`

#### 🔍 Column-Level Risk (`calculate_column_risk`)

Evaluates risk when changing/deleting specific values (used in Relationship Explorer).

| Factor                   | Points  | Description                                 |
| ------------------------ | ------- | ------------------------------------------- |
| **Referenced row count** |         | Rows in other tables referencing this value |
| └ 1-10 rows              | 10      | Small impact                                |
| └ 11-100 rows            | 20      | Moderate impact                             |
| └ 101-1,000 rows         | 30      | Wide impact                                 |
| └ 1,000+ rows            | 40      | Very wide impact                            |
| CASCADE foreign key      | 20 each | Deletion cascades to other table rows       |
| Primary key column       | 15      | Used as table identifier                    |

**Implementation**: `backend/core/src/risk.rs` - `calculate_column_risk()`

### Risk Level Classification

Scores are classified into 4 levels, color-coded in the UI.

| Level        | Score Range | Color    | Description                               |
| ------------ | ----------- | -------- | ----------------------------------------- |
| **Low**      | 0-25        | 🟢 Green  | Limited impact, safe to execute           |
| **Medium**   | 26-50       | 🟡 Yellow | Moderate impact, proceed with caution     |
| **High**     | 51-75       | 🟠 Orange | Wide impact, careful verification needed  |
| **Critical** | 76-100      | 🔴 Red    | Severe impact, high CASCADE deletion risk |

### Usage Example

#### Relationship Explorer Display

```text
Click on users.id = 123

[Inbound References]
├─ orders → users
│  Risk: 65/100 (High) 🟠
│  • 450 row(s) in other tables reference this value
│  • Deletion will cascade to public.orders
│  • This is a primary key column
│
└─ audit_logs → users
   Risk: 20/100 (Low) 🟢
   • 15 row(s) in other tables reference this value
```

#### API Response Example

```json
{
  "score": 65,
  "level": "high",
  "reasons": [
    "450 row(s) in other tables reference this value",
    "Deletion will cascade to public.orders",
    "This is a primary key column"
  ]
}
```

This risk assessment helps you understand the impact of database operations in advance, enabling safer data management.

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Mermaid.js](https://mermaid.js.org/) - Diagram generation
- [Axum](https://github.com/tokio-rs/axum) - Rust web framework
- [Next.js](https://nextjs.org/) - React framework
- [PostgreSQL](https://www.postgresql.org/) - The world's most advanced open source database
