#requires -Version 5.1
<#
.SYNOPSIS
Install dsh-noemaloom and migrate the former @local/dsh-nexus registration.
.EXAMPLE
.\install-desktop.ps1 -HarnessDirectory 'D:\Program Files\DeepSeek Harness' -CheckOnly
.EXAMPLE
.\install-desktop.ps1 -HarnessDirectory 'D:\Program Files\DeepSeek Harness'
.EXAMPLE
.\install-desktop.ps1 -HarnessDirectory 'D:\Program Files\DeepSeek Harness' -VerifyOnly
#>
[CmdletBinding()]
param(
    [string] $HarnessDirectory,
    [switch] $CheckOnly,
    [switch] $VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($CheckOnly -and $VerifyOnly) {
    throw 'Use either -CheckOnly or -VerifyOnly, not both.'
}

$manifestPath = Join-Path $PSScriptRoot 'install-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.packageName -ne 'dsh-noemaloom') {
    throw 'Unexpected installation manifest.'
}
if ([IO.Path]::GetFileName($manifest.packageFile) -ne $manifest.packageFile -or
    $manifest.packageSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $manifest.packageFile -ne "dsh-noemaloom-$($manifest.version)-$($manifest.packageSha256).tgz") {
    throw 'Expected a content-addressed .tgz filename and a SHA-256 digest.'
}
$packagePath = Join-Path $PSScriptRoot $manifest.packageFile
$actualPackageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualPackageHash -cne $manifest.packageSha256) {
    throw 'Package SHA-256 mismatch. Installation was not attempted.'
}

if ([string]::IsNullOrWhiteSpace($HarnessDirectory)) {
    $candidates = @('D:\Program Files\DeepSeek Harness')
    if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'DeepSeek Harness' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness' }
    $installationMatches = @($candidates | Sort-Object -Unique | Where-Object {
        Test-Path -LiteralPath (Join-Path $_ 'resources\runtime\cli\bin\dsh.cmd') -PathType Leaf
    })
    if ($installationMatches.Count -ne 1) {
        throw 'Specify -HarnessDirectory with the actual DeepSeek Harness installation directory.'
    }
    $HarnessDirectory = $installationMatches[0]
}
$HarnessDirectory = (Resolve-Path -LiteralPath $HarnessDirectory).ProviderPath
$cliPath = Join-Path $HarnessDirectory 'resources\runtime\cli\bin\dsh.cmd'
$exePath = Join-Path $HarnessDirectory 'DeepSeek Harness.exe'
if (!(Test-Path -LiteralPath $cliPath -PathType Leaf) -or
    !(Test-Path -LiteralPath $exePath -PathType Leaf)) {
    throw 'The selected directory does not contain the Desktop executable and its bundled CLI.'
}
$reportedVersion = @(& $cliPath --version)
if ($LASTEXITCODE -ne 0) { throw "Bundled CLI version check failed: exit $LASTEXITCODE" }
$hostVersion = ($reportedVersion -join "`n").Trim()
if ($hostVersion -cne $manifest.hostVersion) {
    throw "Expected DeepSeek Harness $($manifest.hostVersion); found $hostVersion."
}

# Match the official DSH_HOME resolution without modifying the environment.
$harnessHome = $env:DSH_HOME
$userDirectory = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($harnessHome)) {
    $harnessHome = Join-Path $userDirectory '.dsh'
} elseif ($harnessHome -eq '~') {
    $harnessHome = $userDirectory
} elseif ($harnessHome.StartsWith('~\') -or $harnessHome.StartsWith('~/')) {
    $harnessHome = Join-Path $userDirectory $harnessHome.Substring(2)
}
$harnessHome = [IO.Path]::GetFullPath($harnessHome)
$profileDirectory = Join-Path $harnessHome 'profiles\desktop'
$profileManifestPath = Join-Path $profileDirectory 'package.json'
$packageRoot = Join-Path $profileDirectory 'node_modules\dsh-noemaloom'
$legacyPackage = '@local/dsh-nexus'
$desktopProcesses = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)

function Get-ProfileManifest {
    if (!(Test-Path -LiteralPath $profileManifestPath -PathType Leaf)) {
        throw 'Open DeepSeek Harness Desktop once to initialize its profile, then fully exit it before installing.'
    }
    Get-Content -LiteralPath $profileManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Test-Dependency($ProfileManifest, [string] $Name) {
    $dependencies = $ProfileManifest.PSObject.Properties['dependencies']
    return ($null -ne $dependencies -and $null -ne $dependencies.Value -and
        $null -ne $dependencies.Value.PSObject.Properties[$Name])
}

function Assert-NoLegacyRegistration {
    $current = Get-ProfileManifest
    if (Test-Dependency $current $legacyPackage) {
        throw 'The old @local/dsh-nexus dependency is still registered. Keep Desktop closed and rerun this installer.'
    }
    $dsh = $current.PSObject.Properties['dsh']
    if ($null -ne $dsh -and $null -ne $dsh.Value) {
        $profile = $dsh.Value.PSObject.Properties['profile']
        if ($null -ne $profile -and $null -ne $profile.Value) {
            $bundles = $profile.Value.PSObject.Properties['bundles']
            if ($null -ne $bundles -and @($bundles.Value) -contains $legacyPackage) {
                throw 'The Desktop bundle selection still contains @local/dsh-nexus. Remove that stale selection before starting Desktop.'
            }
        }
    }
}

function Assert-InstalledFiles {
    $installedManifest = Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($installedManifest.name -cne $manifest.packageName -or $installedManifest.version -cne $manifest.version) {
        throw 'Installed package identity differs from the delivered package.'
    }
    if (@($manifest.keyFiles).Count -lt 7) { throw 'Expected the delivered runtime file identities.' }
    $rootPrefix = [IO.Path]::GetFullPath($packageRoot).TrimEnd('\') + '\'
    foreach ($entry in $manifest.keyFiles) {
        $target = [IO.Path]::GetFullPath((Join-Path $packageRoot $entry.path))
        if (!$target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            $entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
            throw 'Invalid installed file identity in manifest.'
        }
        if (!(Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "Installed file missing: $($entry.path)"
        }
        $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -cne $entry.sha256) {
            throw "Installed file differs from the delivered package: $($entry.path)"
        }
        [pscustomobject]@{ path = $entry.path; sha256 = $actual; matched = $true }
    }
}

$before = Get-ProfileManifest
$hadLegacy = Test-Dependency $before $legacyPackage
$hadNoemaloom = Test-Dependency $before $manifest.packageName

if ($CheckOnly) {
    [pscustomobject]@{
        status = 'PRECHECK_OK'
        package = $packagePath
        packageSha256 = $actualPackageHash
        hostVersion = $hostVersion
        cli = $cliPath
        profile = 'desktop'
        profileDirectory = $profileDirectory
        packageName = $manifest.packageName
        legacyMigrationRequired = $hadLegacy
        desktopRunning = ($desktopProcesses.Count -gt 0)
        readyToInstall = ($desktopProcesses.Count -eq 0)
        profileModified = $false
    } | ConvertTo-Json -Depth 4
    return
}

if (!$VerifyOnly) {
    if ($desktopProcesses.Count -gt 0) {
        throw 'Exit DeepSeek Harness completely, including its tray process, then rerun. No processes were stopped.'
    }
    try {
        # Install and verify the replacement BEFORE removing the former package.
        # The native CLI reconciles dsh.profile.bundles and rolls back failed
        # individual pnpm operations. Preserve the stable `nexus` entry ID/data.
        & $cliPath plugin --profile desktop add $packagePath
        if ($LASTEXITCODE -ne 0) { throw "Desktop plugin installation failed: exit $LASTEXITCODE" }
        $null = @(Assert-InstalledFiles)
        if ($hadLegacy) {
            & $cliPath plugin --profile desktop remove $legacyPackage
            if ($LASTEXITCODE -ne 0) { throw "Legacy plugin removal failed: exit $LASTEXITCODE" }
        }
        Assert-NoLegacyRegistration
    } catch {
        $failure = $_
        # If the old registration remains, withdraw a newly added replacement.
        # Never remove a replacement which was already present before this run.
        if ($hadLegacy -and !$hadNoemaloom) {
            $current = Get-ProfileManifest
            if ((Test-Dependency $current $legacyPackage) -and (Test-Dependency $current $manifest.packageName)) {
                & $cliPath plugin --profile desktop remove $manifest.packageName
                if ($LASTEXITCODE -ne 0) {
                    throw "Migration failed and rollback could not remove the new registration. Keep Desktop closed and rerun this installer. Original failure: $failure"
                }
                throw "Migration failed; the old registration was retained and the new registration was withdrawn. Original failure: $failure"
            }
        }
        throw $failure
    }
}

Assert-NoLegacyRegistration
$verified = @(Assert-InstalledFiles)
[pscustomobject]@{
    status = $(if ($VerifyOnly) { 'INSTALLED_FILES_VERIFIED' } else { 'INSTALLED_AND_FILES_VERIFIED' })
    packageName = $manifest.packageName
    version = $manifest.version
    packageSha256 = $actualPackageHash
    hostVersion = $hostVersion
    profile = 'desktop'
    installedDirectory = $packageRoot
    legacyRegistrationRemoved = $hadLegacy
    files = $verified
    activationVerified = $false
    next = 'Open DeepSeek Harness, confirm dsh-noemaloom in Plugin Manager, then verify the UI and diagnostics.'
} | ConvertTo-Json -Depth 5
