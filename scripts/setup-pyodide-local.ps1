# setup-pyodide-local.ps1
# Download Pyodide WASM runtime for local serving.
# Pyodide CDN is blocked by Intel firewall.
# Run once: powershell -ExecutionPolicy Bypass -File scripts/setup-pyodide-local.ps1

$ErrorActionPreference = 'Stop'
$VER = '0.26.4'
$TARGET = Join-Path $PSScriptRoot '..\public\pyodide'

$FILES = @(
    'pyodide.js'
    'pyodide.asm.js'
    'pyodide.asm.wasm'
    'python_stdlib.zip'
    'pyodide-lock.json'
)

Write-Host ''
Write-Host '  Pyodide Local Setup' -ForegroundColor Cyan
Write-Host "  Version: $VER" -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $TARGET)) {
    New-Item -ItemType Directory -Path $TARGET -Force | Out-Null
}

$marker = Join-Path $TARGET 'pyodide.js'
if (Test-Path $marker) {
    Write-Host '  Already downloaded. Delete public/pyodide/ to re-download.' -ForegroundColor Yellow
    exit 0
}

$URLS = @(
    "https://github.com/pyodide/pyodide/releases/download/$VER"
    "https://cdn.jsdelivr.net/pyodide/v$VER/full"
)

$ok = $false
foreach ($base in $URLS) {
    Write-Host "  Source: $base" -ForegroundColor Cyan
    $allGood = $true

    foreach ($f in $FILES) {
        $url = $base + '/' + $f
        $dest = Join-Path $TARGET $f
        Write-Host "    $f ... " -NoNewline
        try {
            $wc = New-Object System.Net.WebClient
            $wc.Headers.Add('User-Agent', 'ADA-Ingestion')
            $wc.DownloadFile($url, $dest)
            $len = (Get-Item $dest).Length
            $mb = [math]::Round($len / 1048576, 1)
            Write-Host "done ($mb MB)" -ForegroundColor Green
        }
        catch {
            Write-Host 'FAILED' -ForegroundColor Red
            $allGood = $false
            break
        }
    }

    if ($allGood) {
        $ok = $true
        break
    }
    else {
        Get-ChildItem $TARGET -ErrorAction SilentlyContinue | Remove-Item -Force
    }
}

if (-not $ok) {
    Write-Host ''
    Write-Host '  Download failed from all sources.' -ForegroundColor Red
    Write-Host "  Manual: https://github.com/pyodide/pyodide/releases/tag/$VER" -ForegroundColor Yellow
    exit 1
}

Set-Content -Path (Join-Path $TARGET 'VERSION') -Value $VER
Write-Host ''
Write-Host '  Done. Run: npm run dev' -ForegroundColor Green
