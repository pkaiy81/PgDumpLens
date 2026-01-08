# PgDumpLens - Architecture Documentation

## System Architecture

This document provides visual diagrams explaining the PgDumpLens service architecture and workflows.

---

## 1. High-Level Architecture

```mermaid
graph TB
    subgraph "User Interface"
        UI[Web Browser]
        CLI[CLI Tool]
    end

    subgraph "Docker / Kubernetes"
        subgraph "Frontend Pod"
            FE[Next.js Frontend]
        end

        subgraph "API Pod"
            API[Rust API Server<br/>Axum]
        end

        subgraph "Worker Pod"
            WORKER[Rust Worker<br/>Async Jobs]
        end

        subgraph "Storage"
            META[(Metadata PostgreSQL)]
            SANDBOX[(Sandbox PostgreSQL)]
            PVC[Upload Volume]
        end
    end

    UI --> FE
    CLI --> API
    FE --> API
    API --> META
    API --> SANDBOX
    API --> PVC
    WORKER --> META
    WORKER --> SANDBOX
    WORKER --> PVC
```

---

## 2. Component Diagram

```mermaid
flowchart LR
    subgraph Frontend
        direction TB
        Pages[Pages<br/>/, /upload, /d/slug]
        Components[Components<br/>SchemaExplorer<br/>DataTable<br/>RelationshipExplorer<br/>MermaidDiagram]
        Types[TypeScript Types]
    end

    subgraph Backend
        direction TB
        subgraph Core
            Domain[Domain Models]
            Adapter[PostgreSQL Adapter]
            Risk[Risk Calculator]
            Schema[Schema Tools]
            SqlGen[SQL Generator]
        end

        subgraph API
            Handlers[Handlers<br/>dumps, schema<br/>relation, risk]
            Routes[Routes]
            State[App State]
        end

        subgraph Worker
            Jobs[Job Processor<br/>Restore, Analyze]
            Config[Config]
        end
    end

    Frontend --> API
    API --> Core
    Worker --> Core
```

---

## 3. Dump Lifecycle Flow

```mermaid
stateDiagram-v2
    [*] --> CREATED: Create Session
    CREATED --> UPLOADING: Start Upload
    UPLOADING --> UPLOADED: Upload Complete
    UPLOADED --> RESTORING: Trigger Restore
    RESTORING --> ANALYZING: Restore Done
    ANALYZING --> READY: ANALYZE + Schema Build
    READY --> DELETED: TTL Expired
    
    CREATED --> ERROR: Timeout
    UPLOADING --> ERROR: Upload Failed
    RESTORING --> ERROR: Restore Failed
    ANALYZING --> ERROR: Analysis Failed
    
    ERROR --> [*]
    DELETED --> [*]
```

---

## 4. Request Flow - Upload & Restore

```mermaid
sequenceDiagram
    actor User
    participant Frontend
    participant API
    participant Worker
    participant MetaDB as Metadata DB
    participant SandboxDB as Sandbox DB
    participant Storage

    User->>Frontend: Select dump file
    Frontend->>API: POST /api/dumps
    API->>MetaDB: Insert dump record
    API-->>Frontend: {id, slug, upload_url}
    
    Frontend->>API: PUT /api/dumps/{id}/upload
    API->>Storage: Save dump file
    API->>MetaDB: Update status=UPLOADED
    API-->>Frontend: 200 OK
    
    Frontend->>API: POST /api/dumps/{id}/restore
    API->>MetaDB: Update status=RESTORING
    API-->>Frontend: 202 Accepted
    
    Note over Worker: Polling loop
    Worker->>MetaDB: Fetch RESTORING jobs
    Worker->>Storage: Read dump file
    Worker->>SandboxDB: CREATE DATABASE
    Worker->>SandboxDB: pg_restore / psql
    Worker->>MetaDB: Update status=ANALYZING
    
    Worker->>SandboxDB: ANALYZE (update stats)
    Worker->>SandboxDB: Introspect schema
    Worker->>SandboxDB: Build FK graph
    Worker->>MetaDB: Store schema_graph
    Worker->>MetaDB: Update status=READY
```

---

## 5. Request Flow - Data Browsing with Filter

```mermaid
sequenceDiagram
    actor User
    participant Frontend
    participant API
    participant SandboxDB as Sandbox DB

    User->>Frontend: Select table
    Frontend->>API: GET /api/dumps/{id}/tables/{table}
    API->>SandboxDB: SELECT * LIMIT 50
    API-->>Frontend: {columns, rows, total_count}
    
    User->>Frontend: Click filter icon on column
    Frontend->>API: GET /api/dumps/{id}/suggest?column=X
    API->>SandboxDB: SELECT X, COUNT(*) GROUP BY
    API-->>Frontend: {suggestions: [...]}
    
    User->>Frontend: Select filter value
    Frontend->>Frontend: Client-side filter rows
```

---

## 6. Request Flow - Relationship Exploration

```mermaid
sequenceDiagram
    actor User
    participant Frontend
    participant API
    participant MetaDB as Metadata DB

    User->>Frontend: Click cell value
    Frontend->>API: POST /api/dumps/{id}/relation/explain
    API->>MetaDB: Fetch schema_graph
    API->>API: Find inbound FKs
    API->>API: Find outbound FKs
    API->>API: Calculate risk score
    API->>API: Generate SQL examples
    API-->>Frontend: {explanations, sql_examples}
    
    Frontend->>Frontend: Display RelationshipExplorer modal
    Frontend->>Frontend: Show inbound/outbound relations
    Frontend->>Frontend: Render copyable SQL examples
```

**表示条件:**
- **Inbound**: 他のテーブルがこのカラムを FK で参照している場合
- **Outbound**: このカラムが FK として他のテーブルを参照している場合

---

## 7. Dump Comparison & Data Diff Flow

```mermaid
sequenceDiagram
    actor User
    participant Frontend
    participant API
    participant MetaDB as Metadata DB
    participant SandboxDB as Sandbox DB

    User->>Frontend: Upload comparison dump
    Frontend->>API: POST /api/dumps (is_private: true)
    API->>MetaDB: Insert dump record
    API-->>Frontend: {id, slug}
    
    Frontend->>API: PUT /api/dumps/{id}/upload
    API->>SandboxDB: Restore dump
    API->>MetaDB: Update status=READY
    API-->>Frontend: 200 OK
    
    User->>Frontend: View schema diff
    Frontend->>API: GET /api/dumps/{base}/compare/{compare}
    API->>SandboxDB: Query both schemas
    API->>API: Compare schemas
    API->>SandboxDB: Calculate MD5 checksums for each table
    API-->>Frontend: {schemaDiff, dataChanges}
    
    User->>Frontend: Click "View Data Diff"
    Frontend->>API: GET /api/dumps/{base}/compare/{compare}/data-diff
    API->>SandboxDB: Query table data from both dumps
    API->>API: Compute row-level diff
    API-->>Frontend: {added, removed, modified rows}
    
    Frontend->>Frontend: Display diff with highlights
```

### Data Change Detection

データ変更は以下の方法で自動検出されます：

1. **MD5チェックサム計算**: 各テーブルの先頭10,000行に対してMD5チェックサムを計算
2. **比較**: ベースダンプと比較ダンプのチェックサムを比較
3. **変更フラグ**: チェックサムが異なる場合、`has_data_change: true` をセット

```sql
-- チェックサム計算クエリ
SELECT md5(string_agg(md5(t::text), '' ORDER BY t::text)) as checksum
FROM (SELECT * FROM "schema"."table" ORDER BY 1 LIMIT 10000) t
```

---

## 8. Risk Assessment Model

```mermaid
flowchart TD
    Start[Value Selected] --> FetchSchema[Fetch Schema Graph]
    FetchSchema --> CountFK[Count Inbound FKs]
    CountFK --> CheckCascade{Has CASCADE?}
    
    CheckCascade -->|Yes| AddCascadeScore[+15 per CASCADE]
    CheckCascade -->|No| CheckRestrict{Has RESTRICT?}
    
    AddCascadeScore --> CheckRestrict
    CheckRestrict -->|Yes| AddRestrictScore[+10]
    CheckRestrict -->|No| CheckRowCount
    
    AddRestrictScore --> CheckRowCount
    CheckRowCount{Large Table?} -->|Yes| AddRowScore[+10]
    CheckRowCount -->|No| CheckPK
    
    AddRowScore --> CheckPK
    CheckPK{Primary Key?} -->|Yes| AddPKScore[+10]
    CheckPK -->|No| Calculate
    
    AddPKScore --> Calculate
    Calculate[Sum & Cap at 100] --> Classify
    
    Classify --> Low[0-25: Low]
    Classify --> Medium[26-50: Medium]
    Classify --> High[51-75: High]
    Classify --> Critical[76-100: Critical]
```

---

## 9. Docker Compose Configurations

| ファイル                  | 用途               | 特徴                               |
| ------------------------- | ------------------ | ---------------------------------- |
| `docker-compose.yml`      | 標準開発環境       | ビルド済みイメージ、全サービス起動 |
| `docker-compose.dev.yml`  | ホットリロード開発 | cargo-watch, yarn dev              |
| `docker-compose.prod.yml` | 本番環境           | Nginx リバースプロキシ付き         |

---

## 10. Kubernetes Deployment Architecture

```mermaid
graph TB
    subgraph "Internet"
        Users[Users]
    end

    subgraph "Kubernetes Cluster"
        Ingress[Ingress Controller]
        
        subgraph "pgdumplens namespace"
            FE[Frontend<br/>2 replicas]
            API_SVC[API Service]
            API[API<br/>2 replicas]
            WORKER[Worker<br/>1 replica]
            
            META_SVC[Metadata PG Service]
            META[Metadata PostgreSQL]
            META_PVC[(Meta PVC<br/>10Gi)]
            
            SAND_SVC[Sandbox PG Service]
            SAND[Sandbox PostgreSQL]
            SAND_PVC[(Sandbox PVC<br/>100Gi)]
            
            UPLOAD_PVC[(Upload PVC<br/>50Gi)]
            
            CRON[TTL Cleanup CronJob]
        end
    end

    Users --> Ingress
    Ingress --> FE
    Ingress --> API_SVC
    API_SVC --> API
    
    API --> META_SVC
    API --> UPLOAD_PVC
    WORKER --> META_SVC
    WORKER --> SAND_SVC
    WORKER --> UPLOAD_PVC
    
    META_SVC --> META
    META --> META_PVC
    SAND_SVC --> SAND
    SAND --> SAND_PVC
    
    CRON --> META_SVC
    CRON --> SAND_SVC
```

---

## 11. ER Diagram Generation Flow

```mermaid
flowchart LR
    subgraph Introspection
        A[List Tables] --> B[List Columns]
        B --> C[List Foreign Keys]
    end
    
    subgraph Processing
        C --> D[Build Schema Graph]
        D --> E[Cache in MetaDB]
    end
    
    subgraph Rendering
        E --> F[Generate Mermaid Syntax]
        F --> G[Apply Filters]
        G --> H[Render in Browser]
    end
```

---

## 12. Data Flow Summary

| Flow          | Source           | Destination          | Data                  |
| ------------- | ---------------- | -------------------- | --------------------- |
| Upload        | Browser          | API → Storage        | Dump file             |
| Restore       | Worker → Storage | Sandbox DB           | SQL data              |
| Introspection | Sandbox DB       | Metadata DB          | Schema graph          |
| View          | Metadata DB      | API → Browser        | ER diagram, tables    |
| Query         | Sandbox DB       | API → Browser        | Row data              |
| Compare       | Sandbox DB x2    | API → Browser        | Schema diff           |
| Data Diff     | Sandbox DB x2    | API → Browser        | Row-level diff        |
| Cleanup       | CronJob          | Sandbox DB + Storage | Drop DB, delete files |

---

## 13. Technology Stack

```mermaid
mindmap
  root((PgDumpLens))
    Backend
      Rust
        Axum
        SQLx
        Tokio
      PostgreSQL
        Metadata
        Sandbox
    Frontend
      Next.js 14
      React 18
      TailwindCSS
      Mermaid.js
    Infrastructure
      Kubernetes
        Deployments
        Services
        PVC
        CronJob
      Docker
```

---

## Quick Start Commands

### Docker Compose (推奨)
```bash
# 標準起動
docker compose up -d

# ホットリロード開発
docker compose -f docker-compose.dev.yml up

# 本番環境
docker compose -f docker-compose.prod.yml up -d
```

### Backend (ローカル開発)
```bash
cd backend
cargo build --release
cargo test --workspace
cargo run --bin api-server
```

### Frontend (ローカル開発)

```bash
cd frontend
yarn install
yarn dev
yarn test
```

### Kubernetes
```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/
```

---

*PgDumpLens - PostgreSQL Dump Visualization & Risk-Aware Explorer v0.1.0*
