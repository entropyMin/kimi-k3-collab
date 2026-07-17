[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Bridge = Join-Path $PSScriptRoot 'kimi-k3.ps1'
$tokens = $null
$parseErrors = $null
[Management.Automation.Language.Parser]::ParseFile($Bridge, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) {
    throw "Bridge script has $($parseErrors.Count) PowerShell parse error(s)."
}

$service = (& $Bridge -Action ensure | Out-String) | ConvertFrom-Json
if (-not $service.healthy -or $service.model -ne 'kimi-code/k3') {
    throw 'Kimi service health or model verification failed.'
}

$latestPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.kimi-code\codex-jobs\latest.json'
if (Test-Path -LiteralPath $latestPath) {
    $latest = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$latest.session_id)) {
        throw 'The durable latest-job record has no session_id.'
    }
}

Write-Output 'Kimi K3 bridge self-test passed.'
