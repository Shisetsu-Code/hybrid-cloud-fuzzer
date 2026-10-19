param([Parameter(Mandatory=$true)][ValidateSet('Capture','Sync')][string]$Role)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
$config = Get-Content -Raw -LiteralPath (Join-Path $repo '.local-state/collector-control.json') | ConvertFrom-Json
$node = (Get-Command node.exe -ErrorAction Stop).Source
if ($Role -eq 'Capture') {
    $env:PLAYWRIGHT_BROWSERS_PATH = $config.browserPath
    $arguments = @((Join-Path $repo 'local/capture.mjs'), "--manifest=$($config.manifest)", "--out=$($config.outbox)", "--rate=$($config.rate)", "--wait-ms=$($config.waitMs)", "--har=$($config.har)", "--speed=$($config.speed)")
    if ($config.adultConfirmed -eq $true) { $arguments += '--confirm-adult' }
    & $node @arguments
} else {
    $secrets = Import-Clixml -LiteralPath (Join-Path $repo '.wrangler/deployment-secrets.xml')
    $env:HYBRID_FUZZER_URL = $config.workerUrl
    $env:HYBRID_INGEST_TOKEN = [Net.NetworkCredential]::new('', $secrets['INGEST_TOKEN']).Password
    if (-not $env:HYBRID_INGEST_TOKEN) { throw 'Falta la credencial privada de subida.' }
    Remove-Variable secrets
    & $node (Join-Path $repo 'local/sync.mjs') "--out=$($config.outbox)" --watch --interval-ms=10000
}
exit $LASTEXITCODE
