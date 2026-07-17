[CmdletBinding()]
param(
    [ValidateSet('ensure', 'start', 'delegate', 'latest', 'status', 'result', 'cancel')]
    [string]$Action = 'ensure',

    [ValidateSet('analyze', 'execute')]
    [string]$Mode = 'analyze',

    [ValidateSet('general', 'engineering', 'visual')]
    [string]$Focus = 'general',

    [string]$Cwd = (Get-Location).Path,
    [string]$Prompt,
    [string]$PromptFile,
    [string]$AllowedPath,
    [string]$SessionId,

    [ValidateRange(0, 55)]
    [int]$WaitSeconds = 0,

    [ValidateRange(1, 3600)]
    [int]$MaxWaitSeconds = 1800
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$K3Model = 'kimi-code/k3'
$UserProfilePath = [Environment]::GetFolderPath('UserProfile')
$KimiRoot = Join-Path $UserProfilePath '.kimi-code'
$KimiExe = Join-Path $KimiRoot 'bin\kimi.exe'
$LockFile = Join-Path $KimiRoot 'server\lock'
$TokenFile = Join-Path $KimiRoot 'server.token'
$JobRoot = Join-Path $KimiRoot 'codex-jobs'

function Write-Json {
    param([Parameter(Mandatory = $true)]$Value)
    $Value | ConvertTo-Json -Depth 30
}

function Write-JobRecord {
    param([Parameter(Mandatory = $true)]$Value)

    [IO.Directory]::CreateDirectory($JobRoot) | Out-Null
    $json = $Value | ConvertTo-Json -Depth 30
    $recordPath = Join-Path $JobRoot "$($Value.session_id).json"
    $latestPath = Join-Path $JobRoot 'latest.json'

    foreach ($path in @($recordPath, $latestPath)) {
        $tempPath = "$path.$([Guid]::NewGuid().ToString('N')).tmp"
        try {
            [IO.File]::WriteAllText($tempPath, $json, $Utf8NoBom)
            Move-Item -LiteralPath $tempPath -Destination $path -Force
        }
        finally {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-KimiService {
    if (-not (Test-Path -LiteralPath $LockFile) -or -not (Test-Path -LiteralPath $TokenFile)) {
        return $null
    }

    try {
        $lock = Get-Content -Raw -LiteralPath $LockFile | ConvertFrom-Json
        $hostName = [string]$lock.host
        if ($hostName -notin @('127.0.0.1', 'localhost', '::1')) {
            throw "Refusing non-loopback Kimi server host: $hostName"
        }

        $token = (Get-Content -Raw -LiteralPath $TokenFile).Trim()
        if ([string]::IsNullOrWhiteSpace($token)) {
            return $null
        }

        $baseUri = "http://$hostName`:$($lock.port)"
        $headers = @{ Authorization = "Bearer $token" }
        $health = Invoke-RestMethod -Method Get -Uri "$baseUri/api/v1/healthz" -Headers $headers -TimeoutSec 3
        if ($health.code -ne 0) {
            return $null
        }

        return [pscustomobject]@{
            BaseUri = $baseUri
            Headers = $headers
            Host = $hostName
            Port = [int]$lock.port
            Pid = [int]$lock.pid
            Version = [string]$lock.version
        }
    }
    catch {
        if ($_.Exception.Message -like 'Refusing non-loopback*') {
            throw
        }
        return $null
    }
}

function Ensure-KimiService {
    $service = Get-KimiService
    if ($null -ne $service) {
        return $service
    }

    if (-not (Test-Path -LiteralPath $KimiExe)) {
        throw "Kimi CLI was not found at $KimiExe"
    }

    Start-Process -FilePath $KimiExe -ArgumentList @('server', 'run', '--keep-alive', '--log-level', 'warn') -WindowStyle Hidden | Out-Null

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $service = Get-KimiService
        if ($null -ne $service) {
            return $service
        }
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Kimi local server did not become healthy within 15 seconds.'
}

function Invoke-KimiApi {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        $Body
    )

    $service = Ensure-KimiService
    $invokeArgs = @{
        Method = $Method
        Uri = "$($service.BaseUri)$Path"
        Headers = $service.Headers
        TimeoutSec = 20
    }
    if ($null -ne $Body) {
        $invokeArgs.ContentType = 'application/json; charset=utf-8'
        $invokeArgs.Body = $Body | ConvertTo-Json -Depth 30 -Compress
    }

    $response = Invoke-RestMethod @invokeArgs
    if ($response.code -ne 0) {
        throw "Kimi API error $($response.code): $($response.msg)"
    }
    return $response.data
}

function Get-NormalizedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $candidate = if ([IO.Path]::IsPathRooted($Path)) {
        [IO.Path]::GetFullPath($Path)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $Root $Path))
    }

    $prefix = $Root.TrimEnd('\') + '\'
    if ($candidate -ne $Root -and -not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Allowed path is outside the working directory: $Path"
    }
    return $candidate
}

function Get-JobStatus {
    param([Parameter(Mandatory = $true)][string]$Id)

    $escapedId = [Uri]::EscapeDataString($Id)
    $session = Invoke-KimiApi -Method GET -Path "/api/v1/sessions/$escapedId" -Body $null
    $runtime = Invoke-KimiApi -Method GET -Path "/api/v1/sessions/$escapedId/status" -Body $null

    $state = if ($session.pending_interaction -and $session.pending_interaction -ne 'none') {
        'blocked'
    }
    elseif ($runtime.busy) {
        'running'
    }
    elseif ($session.last_turn_reason) {
        [string]$session.last_turn_reason
    }
    else {
        'idle'
    }

    $reportedModels = @([string]$session.agent_config.model, [string]$runtime.model)
    $verifiedK3 = @($reportedModels | Where-Object { $_ -match '(^|/)k3$' }).Count -gt 0

    return [pscustomobject]@{
        kind = 'kimi-k3-job-status'
        session_id = $Id
        state = $state
        busy = [bool]$runtime.busy
        pending_interaction = if ($session.pending_interaction) { [string]$session.pending_interaction } else { 'none' }
        last_turn_reason = [string]$session.last_turn_reason
        explicit_model = $K3Model
        session_model = [string]$session.agent_config.model
        server_reported_model = [string]$runtime.model
        thinking = [string]$runtime.thinking_level
        plan_mode = [bool]$runtime.plan_mode
        permission_mode = [string]$runtime.permission
        verified_k3 = $verifiedK3
        message_count = [int]$session.message_count
    }
}

switch ($Action) {
    'delegate' {
        $delegateArgs = @{
            Action = 'start'
            Mode = $Mode
            Focus = $Focus
            Cwd = $Cwd
        }
        if ($PromptFile) {
            $delegateArgs.PromptFile = $PromptFile
        }
        else {
            $delegateArgs.Prompt = $Prompt
        }
        if ($Mode -eq 'execute') {
            $delegateArgs.AllowedPath = $AllowedPath
        }

        $job = (& $PSCommandPath @delegateArgs | Out-String -Width 1000000) | ConvertFrom-Json
        $record = [ordered]@{
            kind = 'kimi-k3-native-delegation'
            session_id = [string]$job.session_id
            state = [string]$job.state
            complete = $false
            mode = $Mode
            focus = $Focus
            cwd = [IO.Path]::GetFullPath($Cwd)
            explicit_model = [string]$job.explicit_model
            server_reported_model = [string]$job.server_reported_model
            verified_k3 = [bool]$job.verified_k3
            started_at = [DateTime]::UtcNow.ToString('o')
            updated_at = [DateTime]::UtcNow.ToString('o')
            result = $null
        }
        Write-JobRecord -Value $record

        $deadline = [DateTime]::UtcNow.AddSeconds($MaxWaitSeconds)
        do {
            $remaining = [Math]::Max(0, [Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds))
            $pollSeconds = [int][Math]::Min(30, $remaining)
            $resultArgs = @{
                Action = 'result'
                SessionId = [string]$job.session_id
                WaitSeconds = $pollSeconds
            }
            $delegatedResult = (& $PSCommandPath @resultArgs | Out-String -Width 1000000) | ConvertFrom-Json

            $record.state = [string]$delegatedResult.status.state
            $record.complete = [bool]$delegatedResult.complete
            $record.server_reported_model = [string]$delegatedResult.status.server_reported_model
            $record.verified_k3 = [bool]$delegatedResult.status.verified_k3
            $record.updated_at = [DateTime]::UtcNow.ToString('o')
            $record.result = $delegatedResult.result
            Write-JobRecord -Value $record

            if ($record.complete -or [DateTime]::UtcNow -ge $deadline) {
                break
            }
        } while ($true)

        Write-Json ([pscustomobject]$record)
    }

    'latest' {
        $latestPath = Join-Path $JobRoot 'latest.json'
        if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) {
            throw 'No persisted Kimi K3 delegation record was found.'
        }
        Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath
    }

    'ensure' {
        $service = Ensure-KimiService
        $models = Invoke-KimiApi -Method GET -Path '/api/v1/models' -Body $null
        $k3 = @($models.items | Where-Object { $_.model -eq $K3Model }) | Select-Object -First 1
        if ($null -eq $k3) {
            throw "The local Kimi service does not advertise $K3Model"
        }
        Write-Json ([pscustomobject]@{
            kind = 'kimi-k3-service'
            healthy = $true
            persistent = $true
            host = $service.Host
            port = $service.Port
            pid = $service.Pid
            version = $service.Version
            model = $k3.model
            display_name = $k3.display_name
            max_context_size = $k3.max_context_size
        })
    }

    'start' {
        if ($Prompt -and $PromptFile) {
            throw 'Use either -Prompt or -PromptFile, not both.'
        }
        if ($PromptFile) {
            $Prompt = Get-Content -Raw -Encoding UTF8 -LiteralPath $PromptFile
        }
        if ([string]::IsNullOrWhiteSpace($Prompt)) {
            throw 'A non-empty -Prompt or -PromptFile is required.'
        }

        $root = [IO.Path]::GetFullPath($Cwd).TrimEnd('\')
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            throw "Working directory does not exist: $root"
        }

        $planMode = $Mode -eq 'analyze'
        $scopeText = ''
        if ($Mode -eq 'execute') {
            if ([string]::IsNullOrWhiteSpace($AllowedPath)) {
                throw 'Execution mode requires at least one -AllowedPath.'
            }
            $allowedItems = @($AllowedPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            $normalizedAllowed = @($allowedItems | ForEach-Object { Get-NormalizedPath -Root $root -Path $_.Trim() })
            $scopeText = "`nYou may edit only these paths:`n- " + ($normalizedAllowed -join "`n- ")
        }

        $focusPrompt = switch ($Focus) {
            'visual' {
                'Prefer visual hierarchy, composition, spacing, typography, color, responsive behavior, interaction polish, image quality, accessibility, and consistency with the product context.'
            }
            'engineering' {
                'Prefer architecture, API and data design, correctness, failure modes, security, reliability, performance, maintainability, testability, migration and rollback strategy, and operational simplicity.'
            }
            default {
                'Select the most relevant engineering, product, and visual criteria for the task. Treat the focus as a preference rather than a boundary.'
            }
        }

        $systemPrompt = if ($Mode -eq 'analyze') {
            @"
You are Kimi K3, collaborating with Codex as an independent engineering and design partner.
Primary preference for this task: $focusPrompt
ANALYSIS ONLY: do not create, edit, delete, move, or rename files. Inspect relevant project files and assets as needed.
Review the proposal or implementation, challenge assumptions, compare material tradeoffs, and identify concrete risks or defects. Return a concise verdict, ranked findings backed by evidence, recommended changes, and acceptance checks. Distinguish observed facts from inference.
"@
        }
        else {
            @"
You are Kimi K3, collaborating with Codex as an independent engineering and design partner.
Primary preference for this task: $focusPrompt
The user has authorized the scoped implementation described in the task. Inspect before editing, preserve unrelated user changes, and do not touch files outside the allowed paths.$scopeText
Implement the requested work, verify it with appropriate tests, static checks, or rendered evidence, and return the files changed, decisions made, and verification results.
"@
        }

        $sessionBody = @{
            title = "Codex K3 collaboration ($Focus, $Mode)"
            metadata = @{ cwd = $root; focus = $Focus }
        }
        $session = Invoke-KimiApi -Method POST -Path '/api/v1/sessions' -Body $sessionBody
        $escapedId = [Uri]::EscapeDataString([string]$session.id)

        # Kimi Server 0.26 accepts agent_config during session creation but does
        # not persist plan_mode there. Apply and verify the profile before the
        # prompt so analysis jobs are actually read-only at the server level.
        $profileBody = @{
            agent_config = @{
                model = $K3Model
                system_prompt = $systemPrompt.Trim()
                thinking = 'max'
                permission_mode = 'auto'
                plan_mode = $planMode
                swarm_mode = $false
            }
        }
        Invoke-KimiApi -Method POST -Path "/api/v1/sessions/$escapedId/profile" -Body $profileBody | Out-Null
        $configured = Invoke-KimiApi -Method GET -Path "/api/v1/sessions/$escapedId/status" -Body $null
        if ($configured.model -ne $K3Model -or $configured.thinking_level -ne 'max' -or [bool]$configured.plan_mode -ne $planMode) {
            throw "Kimi session configuration verification failed for $($session.id)."
        }

        $promptBody = @{
            content = @(@{ type = 'text'; text = $Prompt })
            metadata = @{ delegated_by = 'codex'; collaboration = $Focus }
            model = $K3Model
            thinking = 'max'
            permission_mode = 'auto'
            plan_mode = $planMode
            swarm_mode = $false
        }
        $submitted = Invoke-KimiApi -Method POST -Path "/api/v1/sessions/$escapedId/prompts" -Body $promptBody

        Write-Json ([pscustomobject]@{
            kind = 'kimi-k3-job'
            session_id = [string]$session.id
            prompt_id = [string]$submitted.prompt_id
            state = [string]$submitted.status
            mode = $Mode
            focus = $Focus
            explicit_model = $K3Model
            server_reported_model = [string]$configured.model
            thinking = [string]$configured.thinking_level
            plan_mode = [bool]$configured.plan_mode
            verified_k3 = [string]$configured.model -eq $K3Model
            persistent_server = $true
        })
    }

    'status' {
        if ([string]::IsNullOrWhiteSpace($SessionId)) {
            throw '-SessionId is required.'
        }
        Write-Json (Get-JobStatus -Id $SessionId)
    }

    'result' {
        if ([string]::IsNullOrWhiteSpace($SessionId)) {
            throw '-SessionId is required.'
        }

        $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
        do {
            $status = Get-JobStatus -Id $SessionId
            if (-not $status.busy -or [DateTime]::UtcNow -ge $deadline) {
                break
            }
            Start-Sleep -Seconds 1
        } while ($true)

        $escapedId = [Uri]::EscapeDataString($SessionId)
        $messages = Invoke-KimiApi -Method GET -Path "/api/v1/sessions/$escapedId/messages?page_size=100&role=assistant" -Body $null
        # The server returns assistant messages newest first. Return only the
        # latest text-bearing message instead of stitching progress chatter.
        $latestAssistant = $messages.items |
            Where-Object {
                @($_.content | Where-Object { $_.type -eq 'text' -and -not [string]::IsNullOrWhiteSpace([string]$_.text) }).Count -gt 0
            } |
            Select-Object -First 1
        $textBlocks = @(
            $latestAssistant.content |
                Where-Object { $_.type -eq 'text' -and -not [string]::IsNullOrWhiteSpace([string]$_.text) } |
                ForEach-Object { [string]$_.text }
        )

        Write-Json ([pscustomobject]@{
            kind = 'kimi-k3-job-result'
            session_id = $SessionId
            status = $status
            complete = (-not $status.busy) -and $status.pending_interaction -eq 'none'
            result = if ($textBlocks.Count -gt 0) { $textBlocks -join "`n`n" } else { $null }
        })
    }

    'cancel' {
        if ([string]::IsNullOrWhiteSpace($SessionId)) {
            throw '-SessionId is required.'
        }
        $escapedId = [Uri]::EscapeDataString($SessionId)
        $prompts = Invoke-KimiApi -Method GET -Path "/api/v1/sessions/$escapedId/prompts" -Body $null
        if ($null -eq $prompts.active) {
            Write-Json ([pscustomobject]@{
                kind = 'kimi-k3-job-cancel'
                session_id = $SessionId
                prompt_id = $null
                aborted = $false
                reason = 'no-active-prompt'
            })
            break
        }

        $promptId = [string]$prompts.active.prompt_id
        $escapedPromptId = [Uri]::EscapeDataString($promptId)
        $aborted = Invoke-KimiApi -Method POST -Path "/api/v1/sessions/$escapedId/prompts/$escapedPromptId`:abort" -Body @{}
        Write-Json ([pscustomobject]@{
            kind = 'kimi-k3-job-cancel'
            session_id = $SessionId
            prompt_id = $promptId
            aborted = [bool]$aborted.aborted
        })
    }
}
