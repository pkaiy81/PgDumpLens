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

| 形式 | 拡張子 | 説明 |
|------|--------|------|
| Plain SQL | `.sql` | `pg_dump -Fp` で生成 |
| Custom | `.dump`, `.backup` | `pg_dump -Fc` で生成 |
| Gzip 圧縮 | `.sql.gz`, `.dump.gz` | 上記の gzip 圧縮版 |

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

### 5. フロントエンドを起動

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

| 方法 | 用途 | 複雑さ |
|------|------|--------|
| Docker Compose | 個人利用・小規模チーム | ⭐ 簡単 |
| Kubernetes | エンタープライズ・クラウド | ⭐⭐⭐ 複雑 |

### Docker Compose デプロイ (推奨)

**個人利用・小規模チーム向け**。Linux サーバー1台で運用。

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

## ☸️ Kubernetes デプロイ

**エンタープライズ・クラウド向け**。AWS EKS / GCP GKE / Azure AKS などで運用。

### Docker Compose vs Kubernetes

| 項目 | Docker Compose | Kubernetes |
|------|----------------|------------|
| **スケーリング** | 手動 | 自動スケーリング |
| **可用性** | 単一マシン | 複数ノード分散 |
| **ロードバランシング** | Nginx で手動 | 組み込み |
| **ローリングアップデート** | なし | 自動 |
| **セルフヒーリング** | なし | Pod 自動再起動 |

### Kubernetes を使うべき場合

- 複数ユーザーが同時アクセス
- 高可用性（99.9%+）が必要
- オートスケーリングが必要
- クラウドマネージドサービスを使用

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

| ファイル | 説明 |
|----------|------|
| `namespace.yaml` | pgdumplens 名前空間 |
| `secret.template.yaml` | DB パスワード等のシークレット |
| `configmap.yaml` | 環境設定 |
| `pvc.yaml` | 永続ボリューム (dumps, DB data) |
| `metadata-postgres.yaml` | メタデータDB StatefulSet |
| `sandbox-postgres.yaml` | サンドボックスDB StatefulSet |
| `api.yaml` | API サーバー Deployment |
| `frontend.yaml` | フロントエンド Deployment |
| `worker.yaml` | Worker Deployment |
| `ingress.yaml` | Ingress (外部アクセス設定) |
| `cronjob-cleanup.yaml` | 期限切れダンプ削除 CronJob |

## 📊 API エンドポイント

| エンドポイント | メソッド | 説明 |
|--------------|---------|------|
| `/health` | GET | ヘルスチェック |
| `/api/dumps` | GET | ダンプ一覧取得 |
| `/api/dumps` | POST | 新規ダンプアップロード |
| `/api/dumps/{id}` | GET | ダンプ詳細取得 |
| `/api/dumps/{id}/schema` | GET | スキーマ情報取得 |
| `/api/dumps/{id}/tables/{schema}/{table}` | GET | テーブルデータ取得 |
| `/api/dumps/{id}/relation/explain` | POST | リレーション解説 |
| `/api/dumps/{id}/risk/{schema}/{table}` | GET | テーブルリスク評価 |

## 📄 ライセンス

MIT
