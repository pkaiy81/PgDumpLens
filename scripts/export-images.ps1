# =============================================================================
# PgDumpLens - オフライン環境向けイメージエクスポートスクリプト (Windows)
# =============================================================================
#
# 使い方:
#   .\export-images.ps1 [-OutputDir <出力ディレクトリ>]
#
# 例:
#   .\export-images.ps1
#   .\export-images.ps1 -OutputDir "D:\offline-bundle"
#
# =============================================================================

param(
    [string]$OutputDir = ".\offline-bundle"
)

$ErrorActionPreference = "Stop"

# イメージ一覧
$Images = @(
    "ghcr.io/pkaiy81/pgdumplens/api:latest",
    "ghcr.io/pkaiy81/pgdumplens/frontend:latest",
    "postgres:16-alpine",
    "nginx:alpine"
)

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  PgDumpLens - オフライン環境向けイメージエクスポート         ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# 出力ディレクトリを作成
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
$OutputDir = (Resolve-Path $OutputDir).Path

Write-Host "Step 1: Docker イメージを取得" -ForegroundColor Yellow
Write-Host "------------------------------------------------------------"

foreach ($Image in $Images) {
    Write-Host "  Pulling: $Image" -ForegroundColor Green
    docker pull $Image
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to pull $Image"
        exit 1
    }
}

Write-Host ""
Write-Host "Step 2: イメージをエクスポート" -ForegroundColor Yellow
Write-Host "------------------------------------------------------------"

# API イメージ
Write-Host "  Exporting: api" -ForegroundColor Green
docker save ghcr.io/pkaiy81/pgdumplens/api:latest | gzip > "$OutputDir\pgdumplens-api.tar.gz"

# Frontend イメージ
Write-Host "  Exporting: frontend" -ForegroundColor Green
docker save ghcr.io/pkaiy81/pgdumplens/frontend:latest | gzip > "$OutputDir\pgdumplens-frontend.tar.gz"

# PostgreSQL イメージ
Write-Host "  Exporting: postgres" -ForegroundColor Green
docker save postgres:16-alpine | gzip > "$OutputDir\postgres.tar.gz"

# Nginx イメージ
Write-Host "  Exporting: nginx" -ForegroundColor Green
docker save nginx:alpine | gzip > "$OutputDir\nginx.tar.gz"

Write-Host ""
Write-Host "Step 3: 設定ファイルをコピー" -ForegroundColor Yellow
Write-Host "------------------------------------------------------------"

# docker-compose ファイル
Copy-Item "docker-compose.offline.yml" -Destination $OutputDir -Force
Write-Host "  Copied: docker-compose.offline.yml" -ForegroundColor Green

# nginx 設定
$NginxDir = Join-Path $OutputDir "deploy\nginx"
if (-not (Test-Path $NginxDir)) {
    New-Item -ItemType Directory -Path $NginxDir -Force | Out-Null
}
Copy-Item "deploy\nginx\nginx.conf" -Destination $NginxDir -Force
Write-Host "  Copied: deploy\nginx\nginx.conf" -ForegroundColor Green

# マイグレーション
$MigrationsDir = Join-Path $OutputDir "backend\migrations"
if (-not (Test-Path $MigrationsDir)) {
    New-Item -ItemType Directory -Path $MigrationsDir -Force | Out-Null
}
Copy-Item "backend\migrations\*.sql" -Destination $MigrationsDir -Force
Write-Host "  Copied: backend\migrations\*.sql" -ForegroundColor Green

# アップロードスクリプト
$ScriptsDir = Join-Path $OutputDir "scripts"
if (-not (Test-Path $ScriptsDir)) {
    New-Item -ItemType Directory -Path $ScriptsDir -Force | Out-Null
}
if (Test-Path "scripts\upload-dump.sh") {
    Copy-Item "scripts\upload-dump.sh" -Destination $ScriptsDir -Force
}
if (Test-Path "scripts\upload-dump.ps1") {
    Copy-Item "scripts\upload-dump.ps1" -Destination $ScriptsDir -Force
}
Write-Host "  Copied: scripts\upload-dump.*" -ForegroundColor Green

Write-Host ""
Write-Host "Step 4: インポートスクリプトを作成" -ForegroundColor Yellow
Write-Host "------------------------------------------------------------"

# Windows 用インポートスクリプト
$ImportScript = @'
# PgDumpLens - オフライン環境用インポート＆起動スクリプト

$ErrorActionPreference = "Stop"

Write-Host "=== PgDumpLens イメージインポート ===" -ForegroundColor Cyan

Write-Host "Importing: api"
Get-Content pgdumplens-api.tar.gz -Raw | docker load

Write-Host "Importing: frontend"
Get-Content pgdumplens-frontend.tar.gz -Raw | docker load

Write-Host "Importing: postgres"
Get-Content postgres.tar.gz -Raw | docker load

Write-Host "Importing: nginx"
Get-Content nginx.tar.gz -Raw | docker load

Write-Host ""
Write-Host "=== イメージ確認 ===" -ForegroundColor Cyan
docker images | Select-String -Pattern "pgdumplens|postgres|nginx"

Write-Host ""
Write-Host "=== PgDumpLens 起動 ===" -ForegroundColor Cyan
# デフォルトパスワードを設定（本番では変更してください）
if (-not $env:DB_PASSWORD) { $env:DB_PASSWORD = "secret" }
if (-not $env:SANDBOX_PASSWORD) { $env:SANDBOX_PASSWORD = "secret" }

docker compose -f docker-compose.offline.yml up -d

Write-Host ""
Write-Host "=== 起動確認 ===" -ForegroundColor Cyan
Start-Sleep -Seconds 5
docker compose -f docker-compose.offline.yml ps

Write-Host ""
Write-Host "=== 完了 ===" -ForegroundColor Green
Write-Host "ブラウザで http://localhost にアクセスしてください"
'@

$ImportScriptPath = Join-Path $OutputDir "import-and-start.ps1"
Set-Content -Path $ImportScriptPath -Value $ImportScript -Encoding UTF8
Write-Host "  Created: import-and-start.ps1" -ForegroundColor Green

# README を作成
$Readme = @'
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
- import-and-start.ps1       : インポート＆起動スクリプト (Windows)
- deploy/nginx/nginx.conf    : Nginx 設定
- backend/migrations/        : DBマイグレーション

【使い方】

■ Windows (PowerShell) の場合:
  > .\import-and-start.ps1

■ Linux / Mac の場合:
  $ gunzip -c pgdumplens-api.tar.gz | docker load
  $ gunzip -c pgdumplens-frontend.tar.gz | docker load
  $ gunzip -c postgres.tar.gz | docker load
  $ gunzip -c nginx.tar.gz | docker load
  $ docker compose -f docker-compose.offline.yml up -d

【確認】
  curl http://localhost/health
  または
  ブラウザで http://localhost にアクセス

【停止】
  docker compose -f docker-compose.offline.yml down

【パスワード変更】
  起動前に環境変数を設定:
  > $env:DB_PASSWORD = "your_secure_password"
  > $env:SANDBOX_PASSWORD = "your_secure_password"

==============================================================================
'@

$ReadmePath = Join-Path $OutputDir "README.txt"
Set-Content -Path $ReadmePath -Value $Readme -Encoding UTF8
Write-Host "  Created: README.txt" -ForegroundColor Green

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  エクスポート完了！                                          ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "出力先: $OutputDir" -ForegroundColor Cyan
Write-Host ""
Write-Host "ファイルサイズ:"
Get-ChildItem -Path $OutputDir -Filter "*.tar.gz" | ForEach-Object {
    $SizeMB = [math]::Round($_.Length / 1MB, 2)
    Write-Host "  $($_.Name): $SizeMB MB"
}
Write-Host ""
$TotalSize = (Get-ChildItem -Path $OutputDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("合計: {0:N2} MB" -f $TotalSize)
Write-Host ""
Write-Host "次のステップ:" -ForegroundColor Yellow
Write-Host "  1. $OutputDir をオフライン環境に転送"
Write-Host "  2. オフライン環境で import-and-start.ps1 を実行"
