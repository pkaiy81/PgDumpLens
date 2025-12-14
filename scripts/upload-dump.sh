#!/bin/bash
# PgDumpLens CLI Upload Script
# Usage: ./scripts/upload-dump.sh <dump_file> [name] [server_url]

set -e

# Configuration
DEFAULT_SERVER="http://localhost:8080"
SERVER_URL="${3:-$DEFAULT_SERVER}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

usage() {
    echo "Usage: $0 <dump_file> [name] [server_url]"
    echo ""
    echo "Arguments:"
    echo "  dump_file    Path to the PostgreSQL dump file (required)"
    echo "  name         Name for the dump (optional, defaults to filename)"
    echo "  server_url   PgDumpLens API URL (optional, defaults to $DEFAULT_SERVER)"
    echo ""
    echo "Supported formats:"
    echo "  - Plain SQL (.sql)"
    echo "  - Custom format (.dump, .backup)"
    echo "  - Gzip compressed (.sql.gz, .dump.gz)"
    echo ""
    echo "Examples:"
    echo "  $0 ./backup.sql"
    echo "  $0 ./production.dump 'Production Backup' http://pgdumplens.example.com"
    echo "  $0 ./data.sql.gz 'Compressed Data'"
    exit 1
}

check_dependencies() {
    if ! command -v curl &> /dev/null; then
        log_error "curl is required but not installed."
        exit 1
    fi

    if ! command -v jq &> /dev/null; then
        log_warn "jq is not installed. Response parsing will be limited."
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

# Get file info
FILE_SIZE=$(stat -f%z "$DUMP_FILE" 2>/dev/null || stat -c%s "$DUMP_FILE" 2>/dev/null)
FILE_SIZE_MB=$(echo "scale=2; $FILE_SIZE / 1048576" | bc)

log_info "Uploading dump file..."
log_info "  File: $DUMP_FILE"
log_info "  Name: $DUMP_NAME"
log_info "  Size: ${FILE_SIZE_MB}MB"
log_info "  Server: $SERVER_URL"

# Upload file
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -F "file=@$DUMP_FILE" \
    -F "name=$DUMP_NAME" \
    "${SERVER_URL}/api/dumps" 2>&1)

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    log_info "Upload successful!"
    
    if command -v jq &> /dev/null; then
        DUMP_ID=$(echo "$BODY" | jq -r '.id // .dump_id // "unknown"')
        log_info "Dump ID: $DUMP_ID"
        echo ""
        log_info "View in browser: ${SERVER_URL/api/}?dump=$DUMP_ID"
    else
        echo "$BODY"
    fi
else
    log_error "Upload failed (HTTP $HTTP_CODE)"
    echo "$BODY"
    exit 1
fi

# Wait for analysis to complete
log_info "Waiting for analysis to complete..."
if command -v jq &> /dev/null && [ -n "$DUMP_ID" ] && [ "$DUMP_ID" != "unknown" ]; then
    MAX_ATTEMPTS=60
    ATTEMPT=0
    
    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        STATUS_RESPONSE=$(curl -s "${SERVER_URL}/api/dumps/${DUMP_ID}")
        STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status // "unknown"')
        
        case "$STATUS" in
            "analyzed")
                log_info "Analysis complete!"
                
                # Get schema summary
                TABLE_COUNT=$(echo "$STATUS_RESPONSE" | jq -r '.schema_graph.tables | length // 0')
                log_info "Tables found: $TABLE_COUNT"
                
                # Get risk level
                RISK=$(echo "$STATUS_RESPONSE" | jq -r '.risk_summary.level // "unknown"')
                log_info "Risk level: $RISK"
                
                exit 0
                ;;
            "failed")
                log_error "Analysis failed"
                echo "$STATUS_RESPONSE" | jq '.error // .'
                exit 1
                ;;
            *)
                echo -n "."
                sleep 2
                ATTEMPT=$((ATTEMPT + 1))
                ;;
        esac
    done
    
    log_warn "Timeout waiting for analysis. Check status manually."
fi

echo ""
log_info "Done!"
