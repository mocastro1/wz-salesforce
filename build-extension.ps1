# ============================================================
# build-extension.ps1 — Empacota a extensão para a Chrome Web Store
# Usa uma ALLOWLIST: só os arquivos de runtime entram no zip.
# Tudo que não estiver listado (.keys, visual_base, docs, .git) fica de fora.
# ============================================================

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$distDir = Join-Path $root 'dist'

# --- Arquivos/pastas de runtime (devem casar com o que o manifest referencia) ---
$include = @(
  'manifest.json',   # manifest (service_worker, content_scripts, web_accessible_resources)
  'background.js',   # service worker — faz importScripts('config.js','auth.js')
  'config.js',       # importado pelo background
  'auth.js',         # importado pelo background (OAuth PKCE)
  'content.js',      # content script
  'styles.css',      # CSS do content script
  'inject.js',       # injetado na página (web_accessible_resource)
  'fonts',           # 3 fontes Geist (web_accessible_resources)
  'icons'            # ícones 16/32/48/128 (manifest.icons + action.default_icon)
)

# --- Validação: todos os itens existem? ---
$missing = @()
foreach ($item in $include) {
  if (-not (Test-Path (Join-Path $root $item))) { $missing += $item }
}
if ($missing.Count -gt 0) {
  Write-Error "Arquivos de runtime ausentes: $($missing -join ', ')"
  exit 1
}

# --- Versão (lida do manifest) para nomear o zip ---
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$zipName = "wz-salesforce-v$version.zip"

if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
$zipPath = Join-Path $distDir $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# --- Empacota (allowlist) ---
# Usa a API .NET (não Compress-Archive) para garantir separador "/" nas entradas.
# Chrome/CWS espera barras normais; o Compress-Archive do PS 5.1 grava "\" e pode
# quebrar o carregamento de subpastas (fonts/, icons/).
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# --- Manifest sanitizado para a loja ---
# A Chrome Web Store REJEITA manifests com o campo "key" ("O campo key não é
# permitido no manifesto"). O "key" fica só no manifest local (mantém o ID
# estável no modo dev); no zip vai uma cópia sem ele.
$storeManifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$storeManifest.PSObject.Properties.Remove('key')
$tmpManifest = Join-Path $env:TEMP "wzsf-manifest-store.json"
# WriteAllText com UTF8 sem BOM (Out-File -Encoding utf8 no PS 5.1 grava BOM)
[System.IO.File]::WriteAllText($tmpManifest, ($storeManifest | ConvertTo-Json -Depth 10),
  (New-Object System.Text.UTF8Encoding($false)))

# Coleta (arquivo, nomeNoZip) com "/" — expande pastas recursivamente.
$entries = @()
foreach ($item in $include) {
  if ($item -eq 'manifest.json') {
    $entries += [pscustomobject]@{ File = $tmpManifest; Name = 'manifest.json' }
    continue
  }
  $full = Join-Path $root $item
  if (Test-Path $full -PathType Container) {
    Get-ChildItem $full -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($root.Length + 1).Replace('\','/')
      $entries += [pscustomobject]@{ File = $_.FullName; Name = $rel }
    }
  } else {
    $entries += [pscustomobject]@{ File = $full; Name = $item }
  }
}

$fs = [System.IO.File]::Open($zipPath,[System.IO.FileMode]::CreateNew)
$archive = New-Object System.IO.Compression.ZipArchive($fs,[System.IO.Compression.ZipArchiveMode]::Create)
foreach ($e in $entries) {
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $archive, $e.File, $e.Name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
$archive.Dispose()
$fs.Dispose()
Remove-Item $tmpManifest -Force -ErrorAction SilentlyContinue

# --- Relatório ---
Write-Output "OK  -> $zipPath"
Write-Output "Versao: $version"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
Write-Output "Conteudo do zip ($($zip.Entries.Count) entradas):"
$zip.Entries | Sort-Object FullName | ForEach-Object {
  Write-Output ("  {0,-28} {1,8} bytes" -f $_.FullName, $_.Length)
}
$zip.Dispose()
