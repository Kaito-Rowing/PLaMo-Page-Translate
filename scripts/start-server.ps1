param(
  [string]$LlamaServer = "llama-server.exe",
  [int]$ContextSize = 8192,
  [int]$Parallel = 2
)
$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$modelDir = Join-Path $repositoryRoot "models\plamo-3-translate-2b-GGUF"
$modelFile = Join-Path $modelDir "plamo-3-translate-2b-Q4_K_M.gguf"
$templateFile = Join-Path $modelDir "chat_template.jinja"

if (-not (Test-Path $modelFile) -or -not (Test-Path $templateFile)) {
  throw "Model/template not found. Run .\scripts\setup-model.ps1 first."
}
if (-not (Get-Command $LlamaServer -ErrorAction SilentlyContinue)) {
  throw "llama-server.exe not found. Download a CUDA Windows build of llama.cpp and pass -LlamaServer 'C:\path\to\llama-server.exe'."
}

Write-Host "PLaMo 3 Translate 2B starting on http://127.0.0.1:8000" -ForegroundColor Green
Write-Host "Stop with Ctrl+C. Translation is processed locally." -ForegroundColor Cyan
& $LlamaServer `
  --host 127.0.0.1 `
  --port 8000 `
  -m $modelFile `
  --chat-template-file $templateFile `
  --no-prefill-assistant `
  --alias plamo-3-translate `
  -c $ContextSize `
  -ngl 99 `
  -np $Parallel
if ($LASTEXITCODE -ne 0) { throw "llama-server failed (exit code $LASTEXITCODE)." }
