#Requires -Version 5.1

# Pauses or resumes Windows media sessions through SMTC, and reports which sessions it actually changed.
# Must run under Windows PowerShell 5.1 (powershell.exe) — PowerShell 7 dropped the WinRT type projection.

param(
    [Parameter(Mandatory = $true)][ValidateSet("status", "pause", "play")][string]$Action,
    [string]$AppIds = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
})[0]

function Await($operation, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    return $task.Result
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$playing = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
$paused = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Paused

$changed = @()
$skipped = @()
$sessions = @()

foreach ($session in $manager.GetSessions()) {
    $sessions += @{ appId = $session.SourceAppUserModelId; status = $session.GetPlaybackInfo().PlaybackStatus.ToString() }
}

if ($Action -eq "status") {
    ConvertTo-Json @{ changed = @(); skipped = @(); sessions = @($sessions) } -Compress
    exit 0
}

if ($Action -eq "pause") {
    foreach ($session in $manager.GetSessions()) {
        $id = $session.SourceAppUserModelId
        if ($session.GetPlaybackInfo().PlaybackStatus -ne $playing) {
            $skipped += $id
            continue
        }
        if (Await ($session.TryPauseAsync()) ([bool])) {
            $changed += $id
        }
    }
} else {
    $wanted = @()
    if ($AppIds) {
        $wanted = @($AppIds.Split([char]0x0A) | Where-Object { $_ })
    }
    foreach ($session in $manager.GetSessions()) {
        $id = $session.SourceAppUserModelId
        if ($wanted -notcontains $id) {
            continue
        }
        # Anything that is no longer paused was resumed by someone else, so leave it alone.
        if ($session.GetPlaybackInfo().PlaybackStatus -ne $paused) {
            $skipped += $id
            continue
        }
        if (Await ($session.TryPlayAsync()) ([bool])) {
            $changed += $id
        }
    }
}

ConvertTo-Json @{ changed = @($changed); skipped = @($skipped); sessions = @($sessions) } -Compress
