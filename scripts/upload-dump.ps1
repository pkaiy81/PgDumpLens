# PgDumpLens CLI Upload Script (PowerShell)
# Usage: .\scripts\upload-dump.ps1 -DumpFile <path> [-Name <name>] [-ServerUrl <url>] [-Public]

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
    [switch]$Public  # Default to private; use -Public to show in Recent Dumps
)

$ErrorActionPreference = "Stop"

# Default to private for script uploads
$IsPrivate = -not $Public

# Colors
function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Green }
function Write-Warn { param($Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

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

try {
    # Step 1: Create dump session
    Write-Info "Creating dump session..."
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

    # Step 2: Upload file using multipart
    Write-Info "Uploading file..."
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

    Invoke-RestMethod -Uri "$ServerUrl$uploadUrl" `
        -Method Put `
        -ContentType "multipart/form-data; boundary=$boundary" `
        -Body $uploadBody | Out-Null

    # Step 3: Trigger restore
    Write-Info "Triggering analysis..."
    try {
        Invoke-RestMethod -Uri "$ServerUrl/api/dumps/$dumpId/restore" -Method Post | Out-Null
    }
    catch {
        Write-Warn "Failed to trigger analysis, but upload was successful"
    }

    Write-Info "Upload successful!"
    if ($slug) {
        Write-Info "View in browser: $ServerUrl/d/$slug"
    }
    else {
        Write-Info "Dump ID: $dumpId"
    }

    # Wait for analysis
    Write-Info "Waiting for analysis to complete..."
    $maxAttempts = 60
    $attempt = 0

    while ($attempt -lt $maxAttempts) {
        try {
            $statusResponse = Invoke-RestMethod -Uri "$ServerUrl/api/dumps/$dumpId" -Method Get
            $status = $statusResponse.status

            switch ($status) {
                "analyzed" {
                    Write-Info "Analysis complete!"
                    
                    if ($statusResponse.schema_graph -and $statusResponse.schema_graph.tables) {
                        $tableCount = $statusResponse.schema_graph.tables.Count
                        Write-Info "Tables found: $tableCount"
                    }
                    
                    if ($statusResponse.risk_summary) {
                        Write-Info "Risk level: $($statusResponse.risk_summary.level)"
                    }
                    
                    exit 0
                }
                "failed" {
                    Write-Err "Analysis failed"
                    Write-Host ($statusResponse | ConvertTo-Json -Depth 5)
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
            Write-Host "." -NoNewline
            Start-Sleep -Seconds 2
            $attempt++
        }
    }

    Write-Warn "Timeout waiting for analysis. Check status manually."
}
catch {
    Write-Err "Upload failed: $_"
    exit 1
}

Write-Host ""
Write-Info "Done!"
