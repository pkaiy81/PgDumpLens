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

    subgraph "Kubernetes Cluster"
        subgraph "Frontend Pod"
            FE[Next.js Frontend]
        end

        subgraph "API Pod"
            API[Rust API Server]
        end

        subgraph "Worker Pod"
            WORKER[Rust Worker]
        end

        subgraph "Storage"
            META[(Metadata PostgreSQL)]
            SANDBOX[(Sandbox PostgreSQL)]
            PVC[Upload PVC]
        end
    end

    UI --> FE
    CLI --> API
    FE --> API
    API --> META
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
        Pages[Pages]
        Components[Components]
        Types[Types]
        Lib[Utils]
    end

    subgraph Backend
        direction TB
        subgraph Core
            Domain[Domain Models]
            Adapter[DB Adapters]
            Risk[Risk Calculator]
            Schema[Schema Tools]
            SqlGen[SQL Generator]
        end

        subgraph API
            Handlers[Handlers]
            Routes[Routes]
            State[App State]
        end

        subgraph Worker
            Jobs[Job Processor]
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
    ANALYZING --> READY: Analysis Done
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
    Worker->>SandboxDB: pg_restore
    Worker->>MetaDB: Update status=ANALYZING
    
    Worker->>SandboxDB: Introspect schema
    Worker->>SandboxDB: Build FK graph
    Worker->>MetaDB: Store schema_graph
    Worker->>MetaDB: Update status=READY
```

---

## 5. Request Flow - Relationship Exploration

```mermaid
sequenceDiagram
    actor User
    participant Frontend
    participant API
    participant MetaDB as Metadata DB
    participant SandboxDB as Sandbox DB

    User->>Frontend: Click cell value
    Frontend->>API: POST /api/dumps/{id}/relation/explain
    API->>MetaDB: Fetch schema_graph
    API->>API: Calculate risk score
    API->>API: Generate SQL examples
    API-->>Frontend: {explanations, sql_examples}
    
    Frontend->>Frontend: Display relationship panel
    Frontend->>Frontend: Show risk badge
    Frontend->>Frontend: Render SQL examples
```

---

## 6. Risk Assessment Model

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

## 7. Kubernetes Deployment Architecture

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

## 8. ER Diagram Generation Flow

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

## 9. Data Flow Summary

| Flow | Source | Destination | Data |
|------|--------|-------------|------|
| Upload | Browser | API → Storage | Dump file |
| Restore | Worker → Storage | Sandbox DB | SQL data |
| Introspection | Sandbox DB | Metadata DB | Schema graph |
| View | Metadata DB | API → Browser | ER diagram, tables |
| Query | Sandbox DB | API → Browser | Row data |
| Cleanup | CronJob | Sandbox DB + Storage | Drop DB, delete files |

---

## 10. Technology Stack

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

### Backend
```bash
cd backend
cargo build --release
cargo test --workspace
```

### Frontend

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

*Generated for DB Dump Visualization & Risk-Aware Explorer v1*
