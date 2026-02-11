#!/bin/bash
# PgDumpLens CLI Upload Script
# Usage: ./scripts/upload-dump.sh <dump_file> [name] [server_url] [options]
#
# API Flow:
#   1. POST /api/dumps                        - Create dump session
#   2. PUT  /api/dumps/:id/upload              - Upload file (multipart)
#   3. GET  /api/dumps/:id/preview             - (optional) Preview tables
#   4. POST /api/dumps/:id/restore             - Trigger restore (no exclusions)
#      POST /api/dumps/:id/restore-with-exclusions - Trigger restore (with exclusions)
#   5. GET  /api/dumps/:id                     - Poll status until READY
#
# Status transitions: CREATED -> UPLOADED -> RESTORING -> ANALYZING -> READY (or ERROR)

set -e

# Configuration
DEFAULT_SERVER="http://localhost:8080"
IS_PRIVATE="true"  # Default to private for script uploads
EXCLUDE_TABLES=""  # Comma-separated list of tables to exclude
PREVIEW_TABLES=false  # Show table preview before restore

# Parse arguments
POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --public)
            IS_PRIVATE="false"
            shift
            ;;
        --exclude-tables)
            EXCLUDE_TABLES="$2"
            shift 2
            ;;
        --exclude-tables=*)
            EXCLUDE_TABLES="${1#*=}"
            shift
            ;;
        --preview-tables)
            PREVIEW_TABLES=true
            shift
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done
set -- "${POSITIONAL_ARGS[@]}"

SERVER_URL="${3:-$DEFAULT_SERVER}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${CYAN}[STEP]${NC} $1"
}

usage() {
    echo "Usage: $0 <dump_file> [name] [server_url] [options]"
    echo ""
    echo "Arguments:"
    echo "  dump_file    Path to the PostgreSQL dump file (required)"
    echo "  name         Name for the dump (optional, defaults to filename)"
    echo "  server_url   PgDumpLens API URL (optional, defaults to $DEFAULT_SERVER)"
    echo ""
    echo "Options:"
    echo "  --public                Show this dump in \"Recent Dumps\" list (default: private)"
    echo "  --exclude-tables LIST   Comma-separated tables to exclude (format: schema.table)"
    echo "  --preview-tables        Show available tables before restore"
    echo ""
    echo "Supported formats:"
    echo "  - Plain SQL (.sql)"
    echo "  - Custom format (.dump, .backup)"
    echo "  - Gzip compressed (.sql.gz, .dump.gz)"
    echo ""
    echo "Examples:"
    echo "  $0 ./backup.sql"
    echo "  $0 ./production.dump 'Production Backup' http://pgdumplens.example.com"
    echo "  $0 ./data.sql.gz 'Compressed Data' http://localhost:8080 --public"
    echo "  $0 ./backup.sql --exclude-tables 'public.large_logs,public.audit_trail'"
    echo "  $0 ./backup.sql --preview-tables"
    exit 1
}

check_dependencies() {
    if ! command -v curl &> /dev/null; then
        log_error "curl is required but not installed."
        exit 1
    fi

    if ! command -v jq &> /dev/null; then
        log_error "jq is required but not installed."
        exit 1
    fi
}

# Main
if [ $# -lt 1 ]; then
    usage
fi

DUMP_FILE="$1"
DUMP_NAME="${2:-$(basename "$DUMP_FILE")}"

# Validate file exists
if [ ! -f "$DUMP_FILE" ]; then
    log_error "File not found: $DUMP_FILE"
    exit 1
fi

check_dependencies

# Get file info (Linux: stat -c, macOS: stat -f)
FILE_SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE" 2>/dev/null)
FILE_SIZE_MB=$(echo "scale=2; $FILE_SIZE / 1048576" | bc)

log_info "Uploading dump file..."
log_info "  File: $DUMP_FILE"
log_info "  Name: $DUMP_NAME"
log_info "  Size: ${FILE_SIZE_MB}MB"
log_info "  Server: $SERVER_URL"
log_info "  Private: $IS_PRIVATE"
if [ -n "$EXCLUDE_TABLES" ]; then
    log_info "  Exclude: $EXCLUDE_TABLES"
fi
echo ""

# Determine total steps
if [ -n "$EXCLUDE_TABLES" ] || [ "$PREVIEW_TABLES" = true ]; then
    TOTAL_STEPS=4
else
    TOTAL_STEPS=3
fi
CURRENT_STEP=0

next_step() {
    CURRENT_STEP=$((CURRENT_STEP + 1))
    log_step "$CURRENT_STEP/$TOTAL_STEPS $1"
}

# Step: Create dump session
next_step "Creating dump session..."
CREATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$DUMP_NAME\", \"is_private\": $IS_PRIVATE}" \
    "${SERVER_URL}/api/dumps" 2>&1)

CREATE_HTTP_CODE=$(echo "$CREATE_RESPONSE" | tail -n1)
CREATE_BODY=$(echo "$CREATE_RESPONSE" | sed '$d')

if [ "$CREATE_HTTP_CODE" -lt 200 ] || [ "$CREATE_HTTP_CODE" -ge 300 ]; then
    log_error "Failed to create dump session (HTTP $CREATE_HTTP_CODE)"
    echo "$CREATE_BODY"
    exit 1
fi

DUMP_ID=$(echo "$CREATE_BODY" | jq -r '.id // empty')
UPLOAD_URL=$(echo "$CREATE_BODY" | jq -r '.upload_url // empty')
SLUG=$(echo "$CREATE_BODY" | jq -r '.slug // empty')

if [ -z "$DUMP_ID" ] || [ -z "$UPLOAD_URL" ]; then
    log_error "Failed to parse create response"
    echo "$CREATE_BODY"
    exit 1
fi

log_info "Dump ID: $DUMP_ID"
log_info "Slug: $SLUG"

# Step: Upload file (multipart PUT to /api/dumps/:id/upload)
next_step "Uploading file..."
UPLOAD_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X PUT \
    -F "file=@$DUMP_FILE" \
    "${SERVER_URL}${UPLOAD_URL}" 2>&1)

UPLOAD_HTTP_CODE=$(echo "$UPLOAD_RESPONSE" | tail -n1)
UPLOAD_BODY=$(echo "$UPLOAD_RESPONSE" | sed '$d')

if [ "$UPLOAD_HTTP_CODE" -lt 200 ] || [ "$UPLOAD_HTTP_CODE" -ge 300 ]; then
    log_error "Failed to upload file (HTTP $UPLOAD_HTTP_CODE)"
    echo "$UPLOAD_BODY"
    exit 1
fi

UPLOAD_STATUS=$(echo "$UPLOAD_BODY" | jq -r '.status // empty')
log_info "Upload status: $UPLOAD_STATUS"

# Step (optional): Preview tables
if [ "$PREVIEW_TABLES" = true ] || [ -n "$EXCLUDE_TABLES" ]; then
    next_step "Fetching table preview..."
    PREVIEW_RESPONSE=$(curl -s -w "\n%{http_code}" \
        "${SERVER_URL}/api/dumps/${DUMP_ID}/preview" 2>&1)

    PREVIEW_HTTP_CODE=$(echo "$PREVIEW_RESPONSE" | tail -n1)
    PREVIEW_BODY=$(echo "$PREVIEW_RESPONSE" | sed '$d')

    if [ "$PREVIEW_HTTP_CODE" -ge 200 ] && [ "$PREVIEW_HTTP_CODE" -lt 300 ]; then
        TOTAL_TABLES=$(echo "$PREVIEW_BODY" | jq -r '.total_count // 0')
        log_info "Tables found in dump: $TOTAL_TABLES"

        if [ "$PREVIEW_TABLES" = true ]; then
            echo ""
            echo "Available tables:"
            echo "$PREVIEW_BODY" | jq -r '.tables[] | "  - \(.schema_name).\(.table_name) (est. \(.estimated_rows // "?") rows)"' 2>/dev/null || \
            echo "$PREVIEW_BODY" | jq -r '.tables[] | "  - \(.schema_name).\(.table_name)"' 2>/dev/null
            echo ""
        fi
    else
        log_warn "Failed to preview tables (HTTP $PREVIEW_HTTP_CODE)"
    fi
fi

# Step: Trigger restore & analysis
next_step "Triggering restore & analysis..."

if [ -n "$EXCLUDE_TABLES" ]; then
    # Build JSON array from comma-separated list
    EXCLUDE_JSON=$(echo "$EXCLUDE_TABLES" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | jq -R . | jq -s .)
    log_info "Excluding tables: $(echo "$EXCLUDE_JSON" | jq -r 'join(", ")')"

    RESTORE_RESPONSE=$(curl -s -w "\n%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -d "{\"excluded_tables\": $EXCLUDE_JSON}" \
        "${SERVER_URL}/api/dumps/${DUMP_ID}/restore-with-exclusions" 2>&1)
else
    RESTORE_RESPONSE=$(curl -s -w "\n%{http_code}" \
        -X POST \
        "${SERVER_URL}/api/dumps/${DUMP_ID}/restore" 2>&1)
fi

RESTORE_HTTP_CODE=$(echo "$RESTORE_RESPONSE" | tail -n1)
RESTORE_BODY=$(echo "$RESTORE_RESPONSE" | sed '$d')

if [ "$RESTORE_HTTP_CODE" -lt 200 ] || [ "$RESTORE_HTTP_CODE" -ge 300 ]; then
    log_warn "Failed to trigger restore (HTTP $RESTORE_HTTP_CODE)"
    log_warn "The dump was uploaded but restore must be triggered manually."
    echo "$RESTORE_BODY"
fi

echo ""
log_info "Upload successful!"
if [ -n "$SLUG" ]; then
    log_info "View in browser: ${SERVER_URL}/d/${SLUG}"
fi

# Wait for analysis to complete (poll GET /api/dumps/:id)
echo ""
log_info "Waiting for analysis to complete..."
MAX_ATTEMPTS=120
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    STATUS_RESPONSE=$(curl -s "${SERVER_URL}/api/dumps/${DUMP_ID}")
    STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status // "unknown"')

    case "$STATUS" in
        "READY")
            echo ""
            log_info "Analysis complete! Status: READY"
            log_info "View in browser: ${SERVER_URL}/d/${SLUG}"
            exit 0
            ;;
        "ERROR")
            echo ""
            ERROR_MSG=$(echo "$STATUS_RESPONSE" | jq -r '.error_message // "Unknown error"')
            log_error "Analysis failed: $ERROR_MSG"
            exit 1
            ;;
        "RESTORING"|"ANALYZING"|"UPLOADED")
            echo -n "."
            sleep 2
            ATTEMPT=$((ATTEMPT + 1))
            ;;
        *)
            echo -n "?"
            sleep 2
            ATTEMPT=$((ATTEMPT + 1))
            ;;
    esac
done

echo ""
log_warn "Timeout waiting for analysis (${MAX_ATTEMPTS}x2s). Check status manually:"
log_warn "  curl -s ${SERVER_URL}/api/dumps/${DUMP_ID} | jq .status"

echo ""
log_info "Done!"
