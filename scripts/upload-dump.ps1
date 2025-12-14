# PgDumpLens CLI Upload Script (PowerShell)
# Usage: .\scripts\upload-dump.ps1 -DumpFile <path> [-Name <name>] [-ServerUrl <url>]

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$DumpFile,

    [Parameter(Position = 1)]
    [string]$Name,

    [Parameter(Position = 2)]
    [string]$ServerUrl = "http://localhost:8080"
)

$ErrorActionPreference = "Stop"

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

try {
    # Create multipart form data
    $boundary = [System.Guid]::NewGuid().ToString()
    $fileBytes = [System.IO.File]::ReadAllBytes($FileInfo.FullName)
    $fileEnc = [System.Text.Encoding]::GetEncoding("iso-8859-1").GetString($fileBytes)
    
    $bodyLines = @(
        "--$boundary",
        "Content-Disposition: form-data; name=`"name`"",
        "",
        $Name,
        "--$boundary",
        "Content-Disposition: form-data; name=`"file`"; filename=`"$($FileInfo.Name)`"",
        "Content-Type: application/octet-stream",
        "",
        $fileEnc,
        "--$boundary--"
    )
    $body = $bodyLines -join "`r`n"

    # Upload
    $response = Invoke-RestMethod -Uri "$ServerUrl/api/dumps" `
        -Method Post `
        -ContentType "multipart/form-data; boundary=$boundary" `
        -Body $body

    Write-Info "Upload successful!"
    $dumpId = $response.id
    if (-not $dumpId) { $dumpId = $response.dump_id }
    
    Write-Info "Dump ID: $dumpId"
    Write-Info "View in browser: $ServerUrl/?dump=$dumpId"

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
