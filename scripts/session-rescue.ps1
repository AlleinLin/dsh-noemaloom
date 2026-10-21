#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $HarnessDirectory,
    [ValidateSet('inspect', 'apply', 'undo')][string] $Mode = 'inspect',
    [string] $SessionId = 'session-e3efb768-0f91-4616-85c7-9a7ad155ce65',
    [string] $NexusDataDirectory,
    [string] $OutputDirectory = $PSScriptRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$harnessRoot = (Resolve-Path -LiteralPath $HarnessDirectory).ProviderPath
$executable = Join-Path $harnessRoot 'DeepSeek Harness.exe'
if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'DeepSeek Harness.exe was not found.' }
$dshRoot = $env:DSH_HOME
$userRoot = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($dshRoot)) { $dshRoot = Join-Path $userRoot '.dsh' }
elseif ($dshRoot -eq '~') { $dshRoot = $userRoot }
elseif ($dshRoot.StartsWith('~\') -or $dshRoot.StartsWith('~/')) { $dshRoot = Join-Path $userRoot $dshRoot.Substring(2) }
$profileRoot = Join-Path ([IO.Path]::GetFullPath($dshRoot)) 'profiles\desktop'
$packageRoot = Join-Path $profileRoot 'node_modules\@local\dsh-nexus'
if ([string]::IsNullOrWhiteSpace($NexusDataDirectory)) { $NexusDataDirectory = Join-Path $profileRoot 'data\nexus' }
if ($Mode -ne 'inspect' -and @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'Exit DeepSeek Harness from its tray menu before apply/undo. No process was stopped.'
}
if (!(Test-Path -LiteralPath $OutputDirectory -PathType Container)) { throw 'The output directory must already exist.' }
$outputPath = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ("nexus-session-diagnostics-" + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json')
$oldElectronNode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $helperPath = Join-Path $PSScriptRoot 'session-rescue.mjs'
    # Start-Process waits for the GUI executable's Node mode on Windows.
    # Every data argument is quoted for the Windows native argv parser.
    $nativeArguments = @('--expose-internals', $helperPath, $Mode, $packageRoot, $NexusDataDirectory, $SessionId, $outputPath) |
        ForEach-Object { '"' + $_.TrimEnd('\') + '"' }
    $runStdout = $outputPath + '.stdout.txt'
    $runStderr = $outputPath + '.stderr.txt'
    $child = Start-Process -FilePath $executable -ArgumentList $nativeArguments -WindowStyle Hidden -Wait -PassThru `
        -RedirectStandardOutput $runStdout -RedirectStandardError $runStderr
    if ($child.ExitCode -ne 0) {
        if (Test-Path -LiteralPath $runStderr) { Get-Content -LiteralPath $runStderr -Encoding UTF8 | Write-Host }
        throw "Session rescue failed (exit $($child.ExitCode)). No process was stopped. Diagnostic log: $runStderr"
    }
    Get-Content -LiteralPath $outputPath -Raw -Encoding UTF8 | Write-Output
    Remove-Item -LiteralPath $runStdout, $runStderr -Force
} finally {
    $env:ELECTRON_RUN_AS_NODE = $oldElectronNode
}
