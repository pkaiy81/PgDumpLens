# PgDumpLens

> Visualize and analyze PostgreSQL dump files - ER diagrams, data browsing, and impact risk assessment

PostgreSQL のダンプファイルをアップロードし、データベース構造を可視化・分析するWebアプリケーション。

## 📋 機能

- **ダンプアップロード**: `pg_dump` で作成したダンプファイルをアップロード
- **ER図生成**: テーブル間のリレーションを Mermaid.js で自動可視化
- **データ閲覧**: 各テーブルのデータをブラウザで確認
- **リレーション解説**: FK 関係を自然言語で説明
- **影響リスク評価**: データ変更時の影響範囲をスコア化 (CASCADE 依存などを考慮)
- **TTL 付き自動削除**: 一定時間後にダンプを自動クリーンアップ

### 📦 対応ファイル形式

| 形式      | 拡張子                | 説明                 |
| --------- | --------------------- | -------------------- |
| Plain SQL | `.sql`                | `pg_dump -Fp` で生成 |
| Custom    | `.dump`, `.backup`    | `pg_dump -Fc` で生成 |
| Gzip 圧縮 | `.sql.gz`, `.dump.gz` | 上記の gzip 圧縮版   |

> **Note**: 拡張子ではなく、ファイル内容（マジックバイト）で自動判別します。

## 🏗️ アーキテクチャ

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

## 🚀 クイックスタート（開発環境）

### 必要なもの

- [Docker](https://www.docker.com/) & Docker Compose
- [Rust](https://rustup.rs/) (1.75+)
- [Node.js](https://nodejs.org/) (20+)
- [Yarn](https://yarnpkg.com/) (4.x)

### 1. リポジトリをクローン

```bash
git clone https://github.com/your-username/pgdumplens.git
cd pgdumplens
```

### 2. データベースを起動

```bash
docker-compose up -d
```

これにより以下が起動します:

- **Metadata DB**: localhost:5432 (ダンプ情報、スキーマキャッシュ)
- **Sandbox DB**: localhost:5433 (リストアされたダンプ)

### 3. 環境変数を設定

```bash
# バックエンド
cp backend/.env.example backend/.env

# フロントエンド
cp frontend/.env.example frontend/.env.local
```

### 4. バックエンドを起動

```bash
cd backend
cargo run --bin api-server
```

API サーバーが <http://localhost:8080> で起動します。

### 5. Worker を起動（別ターミナル）

Worker はダンプのリストアとスキーマ解析を非同期で処理します。

```bash
cd backend
cargo run --bin worker
```

または、すべてのサービスを一度に起動する場合：

```bash
# API + Worker + Frontend を同時起動
docker-compose up -d  # データベースのみ起動
cd backend && cargo run --bin api-server &
cd backend && cargo run --bin worker &
cd frontend && yarn dev
```

### 6. フロントエンドを起動

```bash
cd frontend
yarn install
yarn dev
```

アプリが <http://localhost:3000> で起動します。

## 📁 プロジェクト構成

```bash
pgdumplens/
├── backend/                 # Rust バックエンド
│   ├── api/                 # API サーバー (Axum)
│   ├── core/                # コアロジック (ドメイン、アダプター)
│   ├── worker/              # 非同期ジョブワーカー
│   └── migrations/          # DBマイグレーション
├── frontend/                # Next.js フロントエンド
│   ├── src/app/             # App Router ページ
│   ├── src/components/      # React コンポーネント
│   └── src/lib/             # ユーティリティ
├── deploy/                  # デプロイ設定
│   ├── k8s/                 # Kubernetes マニフェスト
│   └── nginx/               # Nginx 設定
├── scripts/                 # CLI ツール
│   ├── upload-dump.sh       # Linux/Mac 用アップロードスクリプト
│   └── upload-dump.ps1      # Windows 用アップロードスクリプト
├── docs/                    # ドキュメント
│   └── architecture.md      # アーキテクチャ図
├── docker-compose.yml       # 開発用 Docker Compose
└── docker-compose.prod.yml  # 本番用 Docker Compose
```

## 🖥️ CLI アップロード

ブラウザを使わずにコマンドラインからダンプをアップロードできます。

### Linux / Mac

```bash
./scripts/upload-dump.sh ./backup.sql "Production DB" http://localhost:8080
```

### Windows (PowerShell)

```powershell
.\scripts\upload-dump.ps1 -DumpFile .\backup.sql -Name "Production DB" -ServerUrl http://localhost:8080
```

### 機能

- ファイルアップロード
- 分析完了まで自動待機
- テーブル数・リスクレベル表示

## 🧪 テスト

### バックエンドテスト

```bash
cd backend
cargo test
```

### フロントエンドテスト

```bash
cd frontend
yarn test        # ユニットテスト (vitest)
yarn test:e2e    # E2E テスト (playwright)
```

## 🔧 開発コマンド

### Backend コマンド

```bash
# ビルド
cargo build

# フォーマット
cargo fmt

# リント
cargo clippy

# Worker を起動
cargo run --bin worker
```

### Frontend コマンド

```bash
# 開発サーバー
yarn dev

# プロダクションビルド
yarn build

# リント
yarn lint

# テスト (watch モード)
yarn test
```

## � ロギング

### バックエンド

`tracing` クレートを使用した構造化ログ。

```bash
# ログレベル設定
RUST_LOG=info cargo run --bin api-server

# デバッグログを有効化
RUST_LOG=debug cargo run --bin api-server

# 特定モジュールのみデバッグ
RUST_LOG=db_viewer_api=debug,db_viewer_core=info cargo run --bin api-server
```

### Nginx (本番環境)

`deploy/nginx/nginx.conf` でアクセスログを設定済み：

- リクエスト時間
- アップストリーム応答時間
- クライアントIP

## � Docker ビルド

```bash
# API サーバー
docker build -t pgdumplens-api ./backend

# フロントエンド
docker build -t pgdumplens-frontend ./frontend
```

## 🚀 本番デプロイ

### デプロイ方法の選択

| 方法                    | 用途                 | 複雑さ     | インターネット |
| ----------------------- | -------------------- | ---------- | -------------- |
| **GHCR イメージ使用**   | 制限環境・オフライン | ⭐ 最も簡単 | 初回のみ       |
| Docker Compose (ビルド) | 開発・小規模         | ⭐⭐ 簡単    | 必要           |
| Kubernetes              | エンタープライズ     | ⭐⭐⭐ 複雑   | 初回のみ       |

---

### 🏢 制限環境・オフライン環境向けデプロイ（推奨）

**npm/yarn/cargo が使えない環境、インターネット制限がある環境向け**

CI/CD で自動ビルドされた Docker イメージを GitHub Container Registry (GHCR) から取得します。
ソースコードのビルドは**不要**です。

#### 前提条件

- Docker Engine がインストール済み
- GHCR (`ghcr.io`) への一時的なアクセス（イメージ取得時のみ）

#### Step 1: Docker イメージを取得

インターネットに接続できる環境で実行：

```bash
# PgDumpLens のイメージを取得
docker pull ghcr.io/pkaiy81/pgdumplens/api:latest
docker pull ghcr.io/pkaiy81/pgdumplens/frontend:latest

# 依存イメージも取得
docker pull postgres:16-alpine
docker pull nginx:alpine
```

#### Step 2: オフライン環境向けエクスポート（必要な場合）

エアギャップ環境などインターネット完全遮断の場合：

```bash
# イメージをファイルにエクスポート
docker save ghcr.io/pkaiy81/pgdumplens/api:latest | gzip > pgdumplens-api.tar.gz
docker save ghcr.io/pkaiy81/pgdumplens/frontend:latest | gzip > pgdumplens-frontend.tar.gz
docker save postgres:16-alpine | gzip > postgres.tar.gz
docker save nginx:alpine | gzip > nginx.tar.gz

# ファイルサイズ確認（合計約 500MB 程度）
ls -lh *.tar.gz
```

USB メモリや社内ファイルサーバー経由でオフライン環境に転送。

#### Step 3: オフライン環境でインポート

```bash
# イメージをインポート
gunzip -c pgdumplens-api.tar.gz | docker load
gunzip -c pgdumplens-frontend.tar.gz | docker load
gunzip -c postgres.tar.gz | docker load
gunzip -c nginx.tar.gz | docker load

# 確認
docker images | grep -E "pgdumplens|postgres|nginx"
```

#### Step 4: docker-compose.offline.yml を作成

```yaml
# docker-compose.offline.yml
version: '3.8'

services:
  api:
    image: ghcr.io/pkaiy81/pgdumplens/api:latest
    restart: unless-stopped
    environment:
      - HOST=0.0.0.0
      - PORT=8080
      - DATABASE_URL=postgres://dbviewer:${DB_PASSWORD:-secret}@metadata-db:5432/dbviewer_metadata
      - SANDBOX_HOST=sandbox-db
      - SANDBOX_PORT=5432
      - SANDBOX_USER=sandbox
      - SANDBOX_PASSWORD=${SANDBOX_PASSWORD:-secret}
      - DUMP_STORAGE_PATH=/dumps
    volumes:
      - dump-files:/dumps
    depends_on:
      - metadata-db
      - sandbox-db
    networks:
      - pgdumplens-net

  frontend:
    image: ghcr.io/pkaiy81/pgdumplens/frontend:latest
    restart: unless-stopped
    environment:
      - API_URL=http://api:8080
    depends_on:
      - api
    networks:
      - pgdumplens-net

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
    volumes:
      - ./deploy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - api
      - frontend
    networks:
      - pgdumplens-net

  metadata-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: dbviewer
      POSTGRES_PASSWORD: ${DB_PASSWORD:-secret}
      POSTGRES_DB: dbviewer_metadata
    volumes:
      - metadata-data:/var/lib/postgresql/data
    networks:
      - pgdumplens-net

  sandbox-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: sandbox
      POSTGRES_PASSWORD: ${SANDBOX_PASSWORD:-secret}
      POSTGRES_DB: sandbox_template
    volumes:
      - sandbox-data:/var/lib/postgresql/data
    networks:
      - pgdumplens-net

volumes:
  metadata-data:
  sandbox-data:
  dump-files:

networks:
  pgdumplens-net:
    driver: bridge
```

#### Step 5: 起動

```bash
# 環境変数ファイルを作成
cat > .env << 'EOF'
# 外部公開ポート（制限環境に合わせて変更）
HTTP_PORT=8080

# DB 認証（デフォルト値は避けて安全なパスワードを設定）
DB_PASSWORD=your_secure_password
SANDBOX_PASSWORD=your_secure_password

# アップロード先ディレクトリ
UPLOAD_DIR=/dumps
EOF

# 起動
docker compose -f docker-compose.offline.yml up -d

# 確認
docker compose -f docker-compose.offline.yml ps
curl http://localhost:${HTTP_PORT}/health
```

> **📝 Note:** `.env` ファイルは環境に応じて以下の項目をカスタマイズしてください：
> - `HTTP_PORT`: 制限環境でポート80が使用できない場合に変更（例: 8080）
> - `DB_PASSWORD` / `SANDBOX_PASSWORD`: 本番環境では必ずデフォルト値から変更
> - `UPLOAD_DIR`: ダンプファイルの保存先パス

#### 必要なファイル一覧（オフライン環境向け）

| ファイル                     | 説明                                 | 必須       |
| ---------------------------- | ------------------------------------ | ---------- |
| `pgdumplens-api.tar.gz`      | API サーバーイメージ                 | ✅          |
| `pgdumplens-frontend.tar.gz` | フロントエンドイメージ               | ✅          |
| `postgres.tar.gz`            | PostgreSQL イメージ                  | ✅          |
| `nginx.tar.gz`               | Nginx イメージ                       | ✅          |
| `docker-compose.offline.yml` | 起動設定                             | ✅          |
| `deploy/nginx/nginx.conf`    | Nginx 設定                           | ✅          |
| `.env`                       | 環境変数設定（ポート、パスワード等） | 環境による |

---

### Docker Compose デプロイ (ソースビルド)

**インターネット接続があり、ソースからビルドする場合**

```bash
# 1. ソースコードをクローン
git clone <repo-url> pgdumplens && cd pgdumplens

# 2. 環境変数を設定
cp .env.example .env
vi .env  # パスワード等を設定

# 3. 本番環境を起動
docker compose -f docker-compose.prod.yml up -d --build

# 4. 確認
docker compose -f docker-compose.prod.yml ps
curl http://localhost/health

# 5. ログ確認
docker compose -f docker-compose.prod.yml logs -f api
```

**含まれるサービス**:

- API Server (Rust/Axum)
- Frontend (Next.js)
- Worker (非同期ジョブ)
- Metadata DB (PostgreSQL)
- Sandbox DB (PostgreSQL)
- Nginx (リバースプロキシ)

---

## ☸️ Kubernetes デプロイ

**エンタープライズ・クラウド向け**。AWS EKS / GCP GKE / Azure AKS などで運用。

### Docker Compose vs Kubernetes

| 項目                       | Docker Compose | Kubernetes       |
| -------------------------- | -------------- | ---------------- |
| **スケーリング**           | 手動           | 自動スケーリング |
| **可用性**                 | 単一マシン     | 複数ノード分散   |
| **ロードバランシング**     | Nginx で手動   | 組み込み         |
| **ローリングアップデート** | なし           | 自動             |
| **セルフヒーリング**       | なし           | Pod 自動再起動   |

### Kubernetes を使うべき場合

- 複数ユーザーが同時アクセス
- 高可用性（99.9%+）が必要
- オートスケーリングが必要
- クラウドマネージドサービスを使用

### オフライン/制限環境での Kubernetes デプロイ

プライベートレジストリを使用してオフライン環境で Kubernetes にデプロイする方法です。

```bash
# 1. イメージを取得 (インターネット接続可能な環境で)
docker pull ghcr.io/pkaiy81/pgdumplens/api:latest
docker pull ghcr.io/pkaiy81/pgdumplens/frontend:latest

# 2. プライベートレジストリにタグ付け
docker tag ghcr.io/pkaiy81/pgdumplens/api:latest your-registry.local/pgdumplens/api:latest
docker tag ghcr.io/pkaiy81/pgdumplens/frontend:latest your-registry.local/pgdumplens/frontend:latest

# 3. プライベートレジストリにプッシュ
docker push your-registry.local/pgdumplens/api:latest
docker push your-registry.local/pgdumplens/frontend:latest

# 4. Kubernetes マニフェストのイメージ名を変更
# deploy/k8s/api.yaml と frontend.yaml の image: を編集
#   image: ghcr.io/pkaiy81/pgdumplens/api:latest
#   ↓
#   image: your-registry.local/pgdumplens/api:latest
```

### デプロイ手順

```bash
# 1. 名前空間を作成
kubectl apply -f deploy/k8s/namespace.yaml

# 2. シークレットを作成
cp deploy/k8s/secret.template.yaml deploy/k8s/secret.yaml
# secret.yaml を編集して実際のパスワードを Base64 エンコードで設定
kubectl apply -f deploy/k8s/secret.yaml

# 3. ConfigMap をデプロイ
kubectl apply -f deploy/k8s/configmap.yaml

# 4. 永続ボリュームを作成
kubectl apply -f deploy/k8s/pvc.yaml

# 5. データベースをデプロイ
kubectl apply -f deploy/k8s/metadata-postgres.yaml
kubectl apply -f deploy/k8s/sandbox-postgres.yaml

# 6. アプリケーションをデプロイ
kubectl apply -f deploy/k8s/api.yaml
kubectl apply -f deploy/k8s/frontend.yaml
kubectl apply -f deploy/k8s/worker.yaml

# 7. Ingress を設定
kubectl apply -f deploy/k8s/ingress.yaml

# 8. クリーンアップジョブを設定
kubectl apply -f deploy/k8s/cronjob-cleanup.yaml

# 確認
kubectl get pods -n pgdumplens
kubectl get svc -n pgdumplens
```

### マニフェスト一覧

| ファイル                 | 説明                            |
| ------------------------ | ------------------------------- |
| `namespace.yaml`         | pgdumplens 名前空間             |
| `secret.template.yaml`   | DB パスワード等のシークレット   |
| `configmap.yaml`         | 環境設定                        |
| `pvc.yaml`               | 永続ボリューム (dumps, DB data) |
| `metadata-postgres.yaml` | メタデータDB StatefulSet        |
| `sandbox-postgres.yaml`  | サンドボックスDB StatefulSet    |
| `api.yaml`               | API サーバー Deployment         |
| `frontend.yaml`          | フロントエンド Deployment       |
| `worker.yaml`            | Worker Deployment               |
| `ingress.yaml`           | Ingress (外部アクセス設定)      |
| `cronjob-cleanup.yaml`   | 期限切れダンプ削除 CronJob      |

## 📊 API エンドポイント

| エンドポイント                            | メソッド | 説明                   |
| ----------------------------------------- | -------- | ---------------------- |
| `/health`                                 | GET      | ヘルスチェック         |
| `/api/dumps`                              | GET      | ダンプ一覧取得         |
| `/api/dumps`                              | POST     | 新規ダンプアップロード |
| `/api/dumps/{id}`                         | GET      | ダンプ詳細取得         |
| `/api/dumps/{id}/schema`                  | GET      | スキーマ情報取得       |
| `/api/dumps/{id}/tables/{schema}/{table}` | GET      | テーブルデータ取得     |
| `/api/dumps/{id}/relation/explain`        | POST     | リレーション解説       |
| `/api/dumps/{id}/risk/{schema}/{table}`   | GET      | テーブルリスク評価     |

## 📄 ライセンス

MIT
