#!/bin/bash
# =============================================================================
# PgDumpLens - オフライン環境向けイメージエクスポートスクリプト
# =============================================================================
#
# 使い方:
#   ./export-images.sh [出力ディレクトリ]
#
# 例:
#   ./export-images.sh ./offline-bundle
#   ./export-images.sh /media/usb/pgdumplens
#
# =============================================================================

set -e

# カラー出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 出力ディレクトリ
OUTPUT_DIR="${1:-./offline-bundle}"

# イメージ一覧
IMAGES=(
    "ghcr.io/pkaiy81/pgdumplens/api:latest"
    "ghcr.io/pkaiy81/pgdumplens/frontend:latest"
    "postgres:16-alpine"
    "nginx:alpine"
)

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  PgDumpLens - オフライン環境向けイメージエクスポート         ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# 出力ディレクトリを作成
mkdir -p "$OUTPUT_DIR"

echo -e "${YELLOW}Step 1: Docker イメージを取得${NC}"
echo "------------------------------------------------------------"

for IMAGE in "${IMAGES[@]}"; do
    echo -e "  Pulling: ${GREEN}$IMAGE${NC}"
    docker pull "$IMAGE"
done

echo ""
echo -e "${YELLOW}Step 2: イメージをエクスポート${NC}"
echo "------------------------------------------------------------"

# API イメージ
echo -e "  Exporting: ${GREEN}api${NC}"
docker save ghcr.io/pkaiy81/pgdumplens/api:latest | gzip > "$OUTPUT_DIR/pgdumplens-api.tar.gz"

# Frontend イメージ
echo -e "  Exporting: ${GREEN}frontend${NC}"
docker save ghcr.io/pkaiy81/pgdumplens/frontend:latest | gzip > "$OUTPUT_DIR/pgdumplens-frontend.tar.gz"

# PostgreSQL イメージ
echo -e "  Exporting: ${GREEN}postgres${NC}"
docker save postgres:16-alpine | gzip > "$OUTPUT_DIR/postgres.tar.gz"

# Nginx イメージ
echo -e "  Exporting: ${GREEN}nginx${NC}"
docker save nginx:alpine | gzip > "$OUTPUT_DIR/nginx.tar.gz"

echo ""
echo -e "${YELLOW}Step 3: 設定ファイルをコピー${NC}"
echo "------------------------------------------------------------"

# docker-compose ファイル
cp docker-compose.offline.yml "$OUTPUT_DIR/"
echo -e "  Copied: ${GREEN}docker-compose.offline.yml${NC}"

# nginx 設定
mkdir -p "$OUTPUT_DIR/deploy/nginx"
cp deploy/nginx/nginx.conf "$OUTPUT_DIR/deploy/nginx/"
echo -e "  Copied: ${GREEN}deploy/nginx/nginx.conf${NC}"

# マイグレーション
mkdir -p "$OUTPUT_DIR/backend/migrations"
cp backend/migrations/*.sql "$OUTPUT_DIR/backend/migrations/"
echo -e "  Copied: ${GREEN}backend/migrations/*.sql${NC}"

# アップロードスクリプト
mkdir -p "$OUTPUT_DIR/scripts"
cp scripts/upload-dump.sh "$OUTPUT_DIR/scripts/" 2>/dev/null || true
cp scripts/upload-dump.ps1 "$OUTPUT_DIR/scripts/" 2>/dev/null || true
echo -e "  Copied: ${GREEN}scripts/upload-dump.*${NC}"

echo ""
echo -e "${YELLOW}Step 4: インポートスクリプトを作成${NC}"
echo "------------------------------------------------------------"

cat > "$OUTPUT_DIR/import-and-start.sh" << 'IMPORT_SCRIPT'
#!/bin/bash
# PgDumpLens - オフライン環境用インポート＆起動スクリプト

set -e

echo "=== PgDumpLens イメージインポート ==="

echo "Importing: api"
gunzip -c pgdumplens-api.tar.gz | docker load

echo "Importing: frontend"
gunzip -c pgdumplens-frontend.tar.gz | docker load

echo "Importing: postgres"
gunzip -c postgres.tar.gz | docker load

echo "Importing: nginx"
gunzip -c nginx.tar.gz | docker load

echo ""
echo "=== イメージ確認 ==="
docker images | grep -E "pgdumplens|postgres|nginx"

echo ""
echo "=== PgDumpLens 起動 ==="
# デフォルトパスワードを設定（本番では変更してください）
export DB_PASSWORD="${DB_PASSWORD:-secret}"
export SANDBOX_PASSWORD="${SANDBOX_PASSWORD:-secret}"

docker compose -f docker-compose.offline.yml up -d

echo ""
echo "=== 起動確認 ==="
sleep 5
docker compose -f docker-compose.offline.yml ps

echo ""
echo "=== 完了 ==="
echo "ブラウザで http://localhost にアクセスしてください"
IMPORT_SCRIPT

chmod +x "$OUTPUT_DIR/import-and-start.sh"
echo -e "  Created: ${GREEN}import-and-start.sh${NC}"

# README を作成
cat > "$OUTPUT_DIR/README.txt" << 'README'
==============================================================================
 PgDumpLens オフラインバンドル
==============================================================================

このバンドルには、PgDumpLens をオフライン環境で実行するために必要な
すべてのファイルが含まれています。

【必要条件】
- Docker Engine がインストールされていること
- docker compose (または docker-compose) が使えること

【ファイル一覧】
- pgdumplens-api.tar.gz      : API サーバーイメージ
- pgdumplens-frontend.tar.gz : フロントエンドイメージ
- postgres.tar.gz            : PostgreSQL 16 イメージ
- nginx.tar.gz               : Nginx イメージ
- docker-compose.offline.yml : 起動設定
- import-and-start.sh        : インポート＆起動スクリプト (Linux/Mac)
- deploy/nginx/nginx.conf    : Nginx 設定
- backend/migrations/        : DBマイグレーション

【使い方】

■ Linux / Mac の場合:
  $ chmod +x import-and-start.sh
  $ ./import-and-start.sh

■ Windows の場合:
  > gunzip -c pgdumplens-api.tar.gz | docker load
  > gunzip -c pgdumplens-frontend.tar.gz | docker load
  > gunzip -c postgres.tar.gz | docker load
  > gunzip -c nginx.tar.gz | docker load
  > docker compose -f docker-compose.offline.yml up -d

【確認】
  $ curl http://localhost/health
  または
  ブラウザで http://localhost にアクセス

【停止】
  $ docker compose -f docker-compose.offline.yml down

【パスワード変更】
  起動前に環境変数を設定:
  $ export DB_PASSWORD=your_secure_password
  $ export SANDBOX_PASSWORD=your_secure_password

==============================================================================
README

echo -e "  Created: ${GREEN}README.txt${NC}"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  エクスポート完了！                                          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "出力先: ${BLUE}$OUTPUT_DIR${NC}"
echo ""
echo "ファイルサイズ:"
ls -lh "$OUTPUT_DIR"/*.tar.gz
echo ""
echo "合計:"
du -sh "$OUTPUT_DIR"
echo ""
echo -e "${YELLOW}次のステップ:${NC}"
echo "  1. $OUTPUT_DIR をオフライン環境に転送"
echo "  2. オフライン環境で import-and-start.sh を実行"
