param(
  [string]$PackagePath,
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'PLaMoPageTranslate'),
  [string[]]$AlsoUpdatePath = @()
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$destination = Join-Path $InstallRoot 'extension'
$configFile = Join-Path $InstallRoot 'install.json'
$stage = Join-Path $InstallRoot ('.staging-' + [Guid]::NewGuid().ToString('N'))
$oldLocation = $null
$installed = $false

function Read-ExtensionManifest([string]$Directory) {
  $manifest = Get-Content -LiteralPath (Join-Path $Directory 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.name -ne 'PLaMo Page Translate' -or $manifest.manifest_version -ne 3) {
    throw "Not a PLaMo Page Translate extension: $Directory"
  }
  [void][version]$manifest.version
  return $manifest
}

try {
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $archive = Join-Path $stage 'package.zip'
  if ($PackagePath) {
    Copy-Item -LiteralPath ([IO.Path]::GetFullPath($PackagePath)) -Destination $archive
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $api = 'https://api.github.com/repos/Kaito-Rowing/PLaMo-Page-Translate/releases/latest'
    $release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'PLaMo-Page-Translate-Updater' } -TimeoutSec 60
    $asset = @($release.assets | Where-Object name -eq 'plamo-page-translate-webgpu.zip')
    $checksum = @($release.assets | Where-Object name -eq 'SHA256SUMS.txt')
    if ($asset.Count -ne 1 -or $checksum.Count -ne 1) { throw 'The release package or checksum is missing.' }
    Write-Host "Downloading $($release.tag_name)..."
    Invoke-WebRequest -UseBasicParsing -Uri $asset[0].browser_download_url -OutFile $archive -TimeoutSec 120
    $checksumPath = Join-Path $stage 'SHA256SUMS.txt'
    Invoke-WebRequest -UseBasicParsing -Uri $checksum[0].browser_download_url -OutFile $checksumPath -TimeoutSec 60
    $sums = Get-Content -LiteralPath $checksumPath -Raw -Encoding UTF8
    $expected = [regex]::Match($sums, '(?im)^([a-f0-9]{64})\s+\*?plamo-page-translate-webgpu\.zip\s*$')
    if (!$expected.Success -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected.Groups[1].Value) {
      throw 'Package checksum verification failed. The installed version was not changed.'
    }
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)') { throw 'Invalid archive path.' }
    }
  } finally { $zip.Dispose() }
  $unpacked = Join-Path $stage 'extension'
  Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
  $manifest = Read-ExtensionManifest $unpacked
  foreach ($required in @('background.js', 'content.js', 'core.js', 'popup.html', 'popup.js', 'engine.bundle.js', 'offscreen.html', 'wllama/wllama.wasm', 'wllama/llama-worker.js', 'wllama/module.js', 'wllama/opfs-worker.js', 'Update-PLaMo.ps1', 'Update-PLaMo.cmd')) {
    if (!(Test-Path -LiteralPath (Join-Path $unpacked $required) -PathType Leaf)) { throw "Incomplete release package: $required" }
  }
  $legacyPaths = @()
  if (Test-Path -LiteralPath $configFile) { $legacyPaths = @((Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json).legacyPaths) }
  $legacyPaths = @(@($legacyPaths) + @($AlsoUpdatePath) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_) } | Select-Object -Unique)
  # Validate every existing target before changing either installation.
  foreach ($target in @($destination) + $legacyPaths) {
    if (Test-Path -LiteralPath $target) {
      $previous = Read-ExtensionManifest $target
      if ([version]$previous.version -gt [version]$manifest.version) { throw "Refusing to downgrade $target" }
    }
  }
  if (Test-Path -LiteralPath $destination) {
    $backupRoot = Join-Path $InstallRoot 'backups'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $oldLocation = Join-Path $backupRoot ([DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
    # Both absolute paths are fixed children of this application's installation root.
    Move-Item -LiteralPath $destination -Destination $oldLocation
  }
  Move-Item -LiteralPath $unpacked -Destination $destination
  $installed = $true
  foreach ($target in $legacyPaths) {
    if ($target -ne $destination -and (Test-Path -LiteralPath $target)) {
      Get-ChildItem -LiteralPath $destination | Copy-Item -Destination $target -Recurse -Force
      Write-Host "Updated existing Chrome folder: $target"
    }
  }
  foreach ($script in @('Update-PLaMo.ps1', 'Update-PLaMo.cmd')) {
    Copy-Item -LiteralPath (Join-Path $destination $script) -Destination (Join-Path $InstallRoot $script) -Force
  }
  @{ version = $manifest.version; legacyPaths = @($legacyPaths) } | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding UTF8
  Write-Host "Installed PLaMo Page Translate $($manifest.version)"
  Write-Host "Chrome extension folder: $destination"
  Write-Host 'Reload the extension at chrome://extensions/ and reload the web page.'
} catch {
  if (!$installed -and $oldLocation -and !(Test-Path -LiteralPath $destination)) {
    Move-Item -LiteralPath $oldLocation -Destination $destination
  }
  throw
} finally {
  if (Test-Path -LiteralPath $stage) {
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    if ($resolvedStage -eq $stage -and $resolvedStage.StartsWith($InstallRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
  }
}
