<#
.SYNOPSIS
    Re-runs the FraudGuard development environment audit.

.DESCRIPTION
    Detects required tooling and hardware capacity, and reports each item as
    INSTALLED or MISSING with the detected version. Produces the same shape of
    data as docs/DEVELOPMENT_ENVIRONMENT.md so the document can be verified
    rather than trusted.

    Exits 1 if any REQUIRED tool is missing, so it can gate CI or a setup script.

.EXAMPLE
    pwsh -File scripts/audit-environment.ps1
#>

[CmdletBinding()]
param(
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

$required = @(
    @{ Name = 'git';    Command = 'git --version';            Min = '2.40'; Why = 'Version control' }
    @{ Name = 'node';   Command = 'node --version';           Min = '22.0'; Why = 'Backend runtime' }
    @{ Name = 'npm';    Command = 'npm --version';            Min = '10.0'; Why = 'Bootstraps pnpm' }
    @{ Name = 'pnpm';   Command = 'pnpm --version';           Min = '9.0';  Why = 'Monorepo workspaces' }
    @{ Name = 'docker'; Command = 'docker --version';         Min = '24.0'; Why = 'Infrastructure containers' }
    @{ Name = 'python'; Command = 'python --version';         Min = '3.11'; Why = 'ML phase' }
    @{ Name = 'pip';    Command = 'pip --version';            Min = '23.0'; Why = 'Python dependencies' }
    @{ Name = 'k6';     Command = 'k6 version';               Min = '0.50'; Why = 'Load testing' }
)

$optional = @(
    @{ Name = 'gh';        Command = 'gh --version';        Why = 'GitHub convenience' }
    @{ Name = 'psql';      Command = 'psql --version';      Why = 'Optional - container provides it' }
    @{ Name = 'redis-cli'; Command = 'redis-cli --version'; Why = 'Optional - container provides it' }
    @{ Name = 'code';      Command = 'code --version';      Why = 'Recommended IDE' }
    @{ Name = 'choco';     Command = 'choco --version';     Why = 'Windows package manager' }
    @{ Name = 'winget';    Command = 'winget --version';    Why = 'Windows package manager' }
)

function Get-ToolStatus {
    param([hashtable]$Tool)

    $found = Get-Command $Tool.Name -ErrorAction SilentlyContinue
    if (-not $found) {
        return [pscustomobject]@{
            Tool = $Tool.Name; Status = 'MISSING'; Version = '-'; Why = $Tool.Why
        }
    }

    $version = '(unknown)'
    try {
        $raw = Invoke-Expression $Tool.Command 2>$null | Select-Object -First 1
        if ($raw) { $version = ($raw -replace '[^\x20-\x7E]', '').Trim() }
    } catch {
        $version = '(detection failed)'
    }

    return [pscustomobject]@{
        Tool = $Tool.Name; Status = 'INSTALLED'; Version = $version; Why = $Tool.Why
    }
}

Write-Output ''
Write-Output 'FraudGuard - Development Environment Audit'
Write-Output ('Run at: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Output ''

Write-Output '== REQUIRED =='
$requiredResults = $required | ForEach-Object { Get-ToolStatus $_ }
$requiredResults | Format-Table Tool, Status, Version, Why -AutoSize

Write-Output '== OPTIONAL =='
$optional | ForEach-Object { Get-ToolStatus $_ } | Format-Table Tool, Status, Version, Why -AutoSize

if (-not $Quiet) {
    Write-Output '== HARDWARE =='
    $cs  = Get-CimInstance Win32_ComputerSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1

    [pscustomobject]@{
        CPU               = $cpu.Name.Trim()
        PhysicalCores     = $cpu.NumberOfCores
        LogicalProcessors = $cpu.NumberOfLogicalProcessors
        RamGB             = [math]::Round($cs.TotalPhysicalMemory / 1GB, 2)
        HypervisorPresent = $cs.HypervisorPresent
    } | Format-List

    Write-Output '== DISK =='
    Get-PSDrive -PSProvider FileSystem |
        Where-Object { $null -ne $_.Used } |
        Select-Object Name,
            @{ n = 'UsedGB'; e = { [math]::Round($_.Used / 1GB, 1) } },
            @{ n = 'FreeGB'; e = { [math]::Round($_.Free / 1GB, 1) } } |
        Format-Table -AutoSize

    # Docker's default disk image location is on C:. The capacity analysis in
    # DEVELOPMENT_ENVIRONMENT.md 5.3 calls for relocating it when C: is tight.
    $systemDrive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':')) -ErrorAction SilentlyContinue
    if ($systemDrive -and ($systemDrive.Free / 1GB) -lt 50) {
        Write-Warning ('System drive has only {0} GB free. See docs/SETUP.md 2.3 for relocating Docker data.' -f [math]::Round($systemDrive.Free / 1GB, 1))
    }
}

$missing = @($requiredResults | Where-Object { $_.Status -eq 'MISSING' })

Write-Output ''
if ($missing.Count -eq 0) {
    Write-Output 'RESULT: all required tooling present.'
    exit 0
}

Write-Output ('RESULT: {0} required tool(s) MISSING -> {1}' -f $missing.Count, ($missing.Tool -join ', '))
Write-Output 'Remediation: docs/SETUP.md'
exit 1
