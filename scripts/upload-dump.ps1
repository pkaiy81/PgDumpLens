# PgDumpLens CLI Upload Script (PowerShell)
# Usage: .\scripts\upload-dump.ps1 -DumpFile <path> [-Name <name>] [-ServerUrl <url>] [-Public] [-ExcludeTables <list>] [-PreviewTables]
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

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$DumpFile,

    [Parameter(Position = 1)]
    [string]$Name,

    [Parameter(Position = 2)]
    [string]$ServerUrl = "http://localhost:8080",

    [Parameter()]
    [switch]$Public,  # Default to private; use -Public to show in Recent Dumps

    [Parameter()]
    [string[]]$ExcludeTables,  # Tables to exclude (format: "schema.table")

    [Parameter()]
    [switch]$PreviewTables  # Show available tables before restore
)

$ErrorActionPreference = "Stop"

# Default to private for script uploads
$IsPrivate = -not $Public

# Colors
function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Green }
function Write-Warn { param($Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }
function Write-Step { param($Message) Write-Host "[STEP] $Message" -ForegroundColor Cyan }

# Get file info
$FileInfo = Get-Item $DumpFile
$FileSizeMB = [math]::Round($FileInfo.Length / 1MB, 2)

if (-not $Name) {
    $Name = $FileInfo.Name
}

Write-Info "Uploading dump file..."
Write-Info "  File: $DumpFile"
Write-Info "  Name: $Name"
Write-Info "  Size: ${FileSizeMB}MB"
Write-Info "  Server: $ServerUrl"
Write-Info "  Private: $IsPrivate"
if ($ExcludeTables) {
    Write-Info "  Exclude: $($ExcludeTables -join ', ')"
}
Write-Host ""

# Determine total steps
$hasExclusions = ($ExcludeTables -and $ExcludeTables.Count -gt 0) -or $PreviewTables
$totalSteps = if ($hasExclusions) { 4 } else { 3 }
$currentStep = 0

function Next-Step {
    param($Message)
    $script:currentStep++
    Write-Step "$($script:currentStep)/$totalSteps $Message"
}

try {
    # Step: Create dump session
    Next-Step "Creating dump session..."
    $createBody = @{
        name = $Name
        is_private = $IsPrivate
    } | ConvertTo-Json

    $createResponse = Invoke-RestMethod -Uri "$ServerUrl/api/dumps" `
        -Method Post `
        -ContentType "application/json" `
        -Body $createBody

    $dumpId = $createResponse.id
    $uploadUrl = $createResponse.upload_url
    $slug = $createResponse.slug

    if (-not $dumpId -or -not $uploadUrl) {
        Write-Err "Failed to create dump session"
        exit 1
    }

    Write-Info "Dump ID: $dumpId"
    Write-Info "Slug: $slug"

    # Step: Upload file using multipart (PUT /api/dumps/:id/upload)
    Next-Step "Uploading file..."
    $boundary = [System.Guid]::NewGuid().ToString()
    $fileBytes = [System.IO.File]::ReadAllBytes($FileInfo.FullName)
    $fileEnc = [System.Text.Encoding]::GetEncoding("iso-8859-1").GetString($fileBytes)

    $uploadBodyLines = @(
        "--$boundary",
        "Content-Disposition: form-data; name=`"file`"; filename=`"$($FileInfo.Name)`"",
        "Content-Type: application/octet-stream",
        "",
        $fileEnc,
        "--$boundary--"
    )
    $uploadBody = $uploadBodyLines -join "`r`n"

    $uploadResponse = Invoke-RestMethod -Uri "$ServerUrl$uploadUrl" `
        -Method Put `
        -ContentType "multipart/form-data; boundary=$boundary" `
        -Body $uploadBody

    Write-Info "Upload status: $($uploadResponse.status)"

    # Step (optional): Preview tables
    if ($PreviewTables -or ($ExcludeTables -and $ExcludeTables.Count -gt 0)) {
        Next-Step "Fetching table preview..."
        try {
            $previewResponse = Invoke-RestMethod -Uri "$ServerUrl/api/dumps/$dumpId/preview" -Method Get
            Write-Info "Tables found in dump: $($previewResponse.total_count)"

            if ($PreviewTables) {
                Write-Host ""
                Write-Host "Available tables:"
                foreach ($table in $previewResponse.tables) {
                    $rows = if ($table.estimated_rows) { " (est. $($table.estimated_rows) rows)" } else { "" }
                    Write-Host "  - $($table.schema_name).$($table.table_name)$rows"
                }
                Write-Host ""
            }
        }
        catch {
            Write-Warn "Failed to preview tables: $_"
        }
    }

    # Step: Trigger restore & analysis
    Next-Step "Triggering restore & analysis..."

    if ($ExcludeTables -and $ExcludeTables.Count -gt 0) {
        # Use restore-with-exclusions endpoint
        Write-Info "Excluding tables: $($ExcludeTables -join ', ')"
        $restoreBody = @{
            excluded_tables = $ExcludeTables
        } | ConvertTo-Json

        try {
            $restoreResponse = Invoke-RestMethod -Uri "$ServerUrl/api/dumps/$dumpId/restore-with-exclusions" `
                -Method Post `
                -ContentType "application/json" `
                -Body $restoreBody
            Write-Info "Restore status: $($restoreResponse.status)"
        }
        catch {
            Write-Warn "Failed to trigger restore, but upload was successful"
            Write-Warn "The dump must be restored manually."
        }
    }
    else {
        # Use standard restore endpoint
        try {
            $restoreResponse = Invoke-RestMethod -Uri "$ServerUrl/api/dumps/$dumpId/restore" -Method Post
            Write-Info "Restore status: $($restoreResponse.status)"
        }
        catch {
            Write-Warn "Failed to trigger restore, but upload was successful"
            Write-Warn "The dump must be restored manually."
        }
    }

    Write-Host ""
    Write-Info "Upload successful!"
    if ($slug) {
        Write-Info "View in browser: $ServerUrl/d/$slug"
    }

    # Wait for analysis to complete (poll GET /api/dumps/:id)
    Write-Host ""
    Write-Info "Waiting for analysis to complete..."
    $maxAttempts = 120
    $attempt = 0

    while ($attempt -lt $maxAttempts) {
        try {
            $statusResponse = Invoke-RestMethod -Uri "$ServerUrl/api/dumps/$dumpId" -Method Get
            $status = $statusResponse.status

            switch ($status) {
                "READY" {
                    Write-Host ""
                    Write-Info "Analysis complete! Status: READY"
                    Write-Info "View in browser: $ServerUrl/d/$slug"
                    exit 0
                }
                "ERROR" {
                    Write-Host ""
                    $errorMsg = if ($statusResponse.error_message) { $statusResponse.error_message } else { "Unknown error" }
                    Write-Err "Analysis failed: $errorMsg"
                    exit 1
                }
                default {
                    Write-Host "." -NoNewline
                    Start-Sleep -Seconds 2
                    $attempt++
                }
            }
        }
        catch {
            Write-Host "?" -NoNewline
            Start-Sleep -Seconds 2
            $attempt++
        }
    }

    Write-Host ""
    Write-Warn "Timeout waiting for analysis (${maxAttempts}x2s). Check status manually:"
    Write-Warn "  Invoke-RestMethod -Uri '$ServerUrl/api/dumps/$dumpId' | Select-Object -ExpandProperty status"
}
catch {
    Write-Err "Upload failed: $_"
    exit 1
}

Write-Host ""
Write-Info "Done!"
