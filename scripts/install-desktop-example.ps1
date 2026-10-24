#requires -Version 5.1
[CmdletBinding()]
param(
    [string] $HarnessDirectory,
    [switch] $CheckOnly,
    [switch] $VerifyOnly,
    [string] $HostInstallerPath
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install-desktop.ps1') @PSBoundParameters
