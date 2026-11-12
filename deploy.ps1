#Requires -Version 5.1
# Packs the contents of extension/ into .deploy/label-chips-<version>.xpi (ASCII-only file: safe for Windows PowerShell 5.1).
$ErrorActionPreference = 'Stop'

$extensionDir = Join-Path $PSScriptRoot 'extension'
$deployDir = Join-Path $PSScriptRoot '.deploy'

$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $extensionDir 'manifest.json') | ConvertFrom-Json
$xpiPath = Join-Path $deployDir "label-chips-$($manifest.version).xpi"

if (-not (Test-Path $deployDir)) {
    New-Item -ItemType Directory -Path $deployDir | Out-Null
}
if (Test-Path $xpiPath) {
    Remove-Item $xpiPath -Force
}

# Compress-Archive on PS 5.1 can write '\' in entry paths, which breaks the xpi; use ZipArchive directly.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$baseLength = $extensionDir.TrimEnd('\', '/').Length + 1
$zip = [System.IO.Compression.ZipFile]::Open($xpiPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -Path $extensionDir -Recurse -File | ForEach-Object {
        $entryName = $_.FullName.Substring($baseLength).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $_.FullName, $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
}
finally {
    $zip.Dispose()
}

Write-Host "Created $xpiPath"
