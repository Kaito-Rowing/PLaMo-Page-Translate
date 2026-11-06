# Run in PowerShell from any directory. Installs HF CLI and downloads only the required assets.
$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$modelDir = Join-Path $repositoryRoot "models\plamo-3-translate-2b-GGUF"
New-Item -Path $modelDir -ItemType Directory -Force | Out-Null

Write-Host "Installing/updating Hugging Face CLI..." -ForegroundColor Cyan
python -m pip install --upgrade huggingface_hub
if ($LASTEXITCODE -ne 0) { throw "pip failed. Install Python 3.10+ and check your PATH." }

$hf = Get-Command hf -ErrorAction SilentlyContinue
if (-not $hf) {
  throw "'hf' command not found. Restart PowerShell after installing Python / huggingface_hub, or add the Python Scripts directory to PATH."
}

Write-Host "Downloading PLaMo 3 Translate 2B Q4_K_M (~1.81 GB)..." -ForegroundColor Cyan
& $hf.Source download pfnet/plamo-3-translate-2b-GGUF `
  plamo-3-translate-2b-Q4_K_M.gguf chat_template.jinja `
  --local-dir $modelDir
if ($LASTEXITCODE -ne 0) { throw "Hugging Face download failed." }
Write-Host "Model and chat_template.jinja saved to: $modelDir" -ForegroundColor Green
