param([Parameter(Mandatory = $true)][string]$PackagePath)
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('plamo-install-test-' + [Guid]::NewGuid().ToString('N'))
$appRoot = Join-Path $testRoot 'app'
$installer = Join-Path $PSScriptRoot '../install/Update-PLaMo.ps1'
try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  & $installer -PackagePath $PackagePath -InstallRoot $appRoot
  $manifestFile = Join-Path $appRoot 'extension/manifest.json'
  $before = (Get-FileHash -LiteralPath $manifestFile).Hash
  if (!(Test-Path -LiteralPath (Join-Path $appRoot 'Update-PLaMo.cmd'))) { throw 'Updater was not installed.' }
  $legacy = Join-Path $testRoot 'already-loaded-extension'
  Copy-Item -LiteralPath (Join-Path $appRoot 'extension') -Destination $legacy -Recurse
  & (Join-Path $appRoot 'Update-PLaMo.ps1') -PackagePath $PackagePath -InstallRoot $appRoot -AlsoUpdatePath $legacy
  $config = Get-Content -LiteralPath (Join-Path $appRoot 'install.json') -Raw | ConvertFrom-Json
  if ($config.legacyPaths -notcontains $legacy) { throw 'Existing Chrome location was not remembered.' }
  if (!(Get-ChildItem -LiteralPath (Join-Path $appRoot 'backups'))) { throw 'The previous version was not preserved.' }
  $badSource = Join-Path $testRoot 'incomplete'
  New-Item -ItemType Directory -Path $badSource | Out-Null
  Copy-Item -LiteralPath $manifestFile -Destination $badSource
  $badZip = Join-Path $testRoot 'incomplete.zip'
  Compress-Archive -Path (Join-Path $badSource '*') -DestinationPath $badZip
  $rejected = $false
  try { & $installer -PackagePath $badZip -InstallRoot $appRoot } catch { $rejected = $true }
  if (!$rejected -or (Get-FileHash -LiteralPath $manifestFile).Hash -ne $before) { throw 'An incomplete package changed the working installation.' }
  Write-Host 'PASS: first install, in-place update, existing Chrome folder, backup, invalid-package recovery.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and (Resolve-Path -LiteralPath $testRoot).Path -eq $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
