<#
.SYNOPSIS
    Start MoneyKal locally, from a known-good state.

.DESCRIPTION
    Exists because of a specific failure that is invisible when it happens: a
    uvicorn process left running from an earlier session keeps port 8000, the
    new one fails to bind, and the frontend — which targets that port — quietly
    talks to yesterday's build. Routers added since then return 404 and features
    disappear with no error anywhere on screen.

    So this always frees the port before starting, and it always runs migrations
    first, because the other way to lose an afternoon is a database that is
    behind the models (which returns 500 on login, not a useful message).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\dev.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 -ApiPort 8001 -WebPort 3000
#>
[CmdletBinding()]
param(
    [int]$ApiPort = 8000,
    [int]$WebPort = 3000,
    [switch]$SkipMigrations,
    [switch]$NoWeb
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "    $text" -ForegroundColor Yellow }

# --- 1. Free the port -------------------------------------------------------
Write-Step "Freeing port $ApiPort"
$owners = @()
try {
    $owners = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction Stop |
              Select-Object -ExpandProperty OwningProcess -Unique
} catch {
    # Get-NetTCPConnection throws when nothing is listening; that is the good case.
    $owners = @()
}

if ($owners.Count -eq 0) {
    Write-Ok "Nothing was listening."
} else {
    foreach ($processId in $owners) {
        try {
            $proc = Get-Process -Id $processId -ErrorAction Stop
            Write-Warn2 "Stopping $($proc.ProcessName) (PID $processId) which held port $ApiPort."
            Stop-Process -Id $processId -Force -ErrorAction Stop
        } catch {
            Write-Warn2 "Could not stop PID ${processId}: $($_.Exception.Message)"
        }
    }
    Start-Sleep -Milliseconds 600
    Write-Ok "Port $ApiPort is free."
}

# --- 2. Environment ---------------------------------------------------------
Write-Step "Checking configuration"
if (-not (Test-Path 'backend/.env')) {
    Write-Host "    backend/.env is missing. Copy backend/.env.example and fill in" -ForegroundColor Red
    Write-Host "    DATABASE_URL and JWT_SECRET, then run this again." -ForegroundColor Red
    exit 1
}
Write-Ok "backend/.env found."
$env:PYTHONPATH = $root

# --- 3. Migrations ----------------------------------------------------------
if ($SkipMigrations) {
    Write-Warn2 "Skipping migrations (-SkipMigrations)."
} else {
    Write-Step "Applying migrations"
    python -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) {
        Write-Host "    alembic upgrade head failed. The API would return 500 on login" -ForegroundColor Red
        Write-Host "    against a database behind the models, so stopping here." -ForegroundColor Red
        exit 1
    }
    Write-Ok "Database is at head."
}

# --- 4. Static frontend -----------------------------------------------------
if (-not $NoWeb) {
    Write-Step "Serving twin-app on http://127.0.0.1:$WebPort"
    # scripts/serve_web.py, not `python -m http.server`: the standard server
    # sends no Cache-Control, so a browser reuses cached HTML for hours without
    # asking, and a change to a page (the PIN gate in dashboard.html's <head>,
    # for one) silently does not reach anyone who has visited before.
    $webArgs = "scripts/serve_web.py", "--port", "$WebPort", "--bind", "127.0.0.1", "--directory", "twin-app"
    $web = Start-Process -FilePath "python" -ArgumentList $webArgs -PassThru -WindowStyle Hidden
    Write-Ok "Static server started (PID $($web.Id)). Open http://127.0.0.1:$WebPort/index.html"
}

# --- 5. API (foreground, so Ctrl+C stops everything the usual way) ----------
Write-Step "Starting the API on http://127.0.0.1:$ApiPort"
Write-Ok "Docs at http://127.0.0.1:$ApiPort/docs   Health at /health"
Write-Host ""
try {
    python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port $ApiPort
} finally {
    if (-not $NoWeb -and $web -and -not $web.HasExited) {
        Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue
        Write-Host "`nStopped the static server." -ForegroundColor Cyan
    }
}
