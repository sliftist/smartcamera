#Requires -Version 5.1

# Pauses or resumes Windows media sessions through SMTC, and reports which sessions it actually changed.
# Must run under Windows PowerShell 5.1 (powershell.exe) - PowerShell 7 dropped the WinRT type projection.
#
# This stays running and reads commands from stdin, one json object per line, answering each with one
# json line. It used to be spawned per command, and that was where smartpause's lag came from: starting
# powershell, loading the WindowsRuntime interop assembly, projecting the WinRT types, reflecting over
# AsTask and handshaking with the session manager is seconds of work, and every one of those seconds
# sat between the model deciding the headphones were off and the music actually stopping. None of it
# depends on the command, so all of it is done once, up here, and a pause afterwards is a line of text.

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

# The manager is live: GetSessions re-enumerates every call, so holding one across commands sees apps
# that opened and closed since. Only the handshake to get it is expensive, and that is what is saved.
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$playing = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
$paused = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Paused

function Send($payload) {
    # Written straight to the console and flushed, because the pipeline buffers and a caller waiting on
    # a line it cannot see is the same as the lag this was written to remove.
    [Console]::Out.WriteLine((ConvertTo-Json $payload -Compress -Depth 5))
    [Console]::Out.Flush()
}

# Says the setup finished, so a caller knows the expensive part is behind it rather than guessing.
Send @{ ready = $true }

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (-not $line.Trim()) {
        continue
    }
    $id = 0
    try {
        $request = ConvertFrom-Json $line
        $id = [int]$request.id
        $action = [string]$request.action
        $wanted = @()
        if ($request.PSObject.Properties.Name -contains "appIds" -and $request.appIds) {
            $wanted = @($request.appIds)
        }

        $changed = @()
        $skipped = @()
        $sessions = @()
        foreach ($session in $manager.GetSessions()) {
            $sessions += @{ appId = $session.SourceAppUserModelId; status = $session.GetPlaybackInfo().PlaybackStatus.ToString() }
        }

        if ($action -eq "pause") {
            foreach ($session in $manager.GetSessions()) {
                $appId = $session.SourceAppUserModelId
                if ($session.GetPlaybackInfo().PlaybackStatus -ne $playing) {
                    $skipped += $appId
                    continue
                }
                if (Await ($session.TryPauseAsync()) ([bool])) {
                    $changed += $appId
                }
            }
        } elseif ($action -eq "play") {
            foreach ($session in $manager.GetSessions()) {
                $appId = $session.SourceAppUserModelId
                if ($wanted -notcontains $appId) {
                    continue
                }
                # Anything that is no longer paused was resumed by someone else, so leave it alone.
                if ($session.GetPlaybackInfo().PlaybackStatus -ne $paused) {
                    $skipped += $appId
                    continue
                }
                if (Await ($session.TryPlayAsync()) ([bool])) {
                    $changed += $appId
                }
            }
        } elseif ($action -ne "status") {
            throw "unknown action $action"
        }

        Send @{ id = $id; changed = @($changed); skipped = @($skipped); sessions = @($sessions) }
    } catch {
        # Reported rather than thrown, so one bad command does not take the host down and make the
        # next pause pay the whole startup again.
        Send @{ id = $id; error = $_.Exception.Message }
    }
}
