#requires -Version 5.1
<#
Examples (save your work and fully exit DeepSeek Harness Desktop first):
  & 'D:\dshplugin\tools\build\Install-Example.ps1'
  & 'D:\dshplugin\tools\build\Install-Example.ps1' -DshCommand 'D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
The complete build folder or extracted release ZIP is portable.
Always installs the complete Tools package: file, search, and PowerShell replacements.
Default: offline, Desktop profile, official standard preset.
Legacy -Variant PowerShell remains an alias for the complete Tools package.
#>
[CmdletBinding()]
param(
    [ValidateSet('Tools', 'PowerShell')][string]$Variant = 'Tools',
    [string]$DshCommand,
    [switch]$Offline = $true
)
$ErrorActionPreference = 'Stop'
$installerPath = Join-Path $PSScriptRoot 'Install.ps1'
$checksumPath = Join-Path $PSScriptRoot 'SHA256SUMS.txt'
$packageFile = 'local-dsh-forge-tools-0.1.6.tgz'
foreach ($requiredFile in @($installerPath, $checksumPath, (Join-Path $PSScriptRoot $packageFile))) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Release file missing: $requiredFile. Copy the whole build folder or extract the whole release ZIP."
    }
}
# Verify the installer before invoking it. Install.ps1 also verifies the complete Tools tgz.
$installerChecksums = @(Get-Content -LiteralPath $checksumPath |
    Where-Object { $_ -match '^[a-fA-F0-9]{64}  Install\.ps1$' })
if ($installerChecksums.Count -ne 1) {
    throw 'Expected exactly one Install.ps1 checksum in SHA256SUMS.txt.'
}
$expectedInstallerHash = $installerChecksums[0].Substring(0, 64)
$actualInstallerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
if ($actualInstallerHash -ine $expectedInstallerHash) {
    throw 'Installer checksum mismatch. Obtain a complete release before retrying.'
}
$installerArguments = @{ Variant = $Variant; Offline = $Offline }
if ($PSBoundParameters.ContainsKey('DshCommand')) {
    if ([string]::IsNullOrWhiteSpace($DshCommand)) {
        throw 'DshCommand must be the full path to the Desktop-bundled dsh.cmd.'
    }
    $installerArguments.DshCommand = $DshCommand
}
Write-Host 'Installing Forge Tools 0.1.6 (file, search, and PowerShell replacements) into DeepSeek Harness Desktop.'
Write-Host 'Target profile: desktop. Start a NEW conversation using the official standard preset after restarting Desktop.'
& $installerPath @installerArguments
