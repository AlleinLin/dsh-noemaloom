#requires -Version 5.1
<#
.SYNOPSIS
Install dsh-noemaloom and migrate the former @local/dsh-nexus registration.
Older Desktop versions are upgraded with the pinned official Windows installer first.
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
    [switch] $VerifyOnly,
    [string] $HostInstallerPath
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

function Compare-VersionNumber([string] $Left, [string] $Right) {
    if ($Left.Length -ne $Right.Length) { return [Math]::Sign($Left.Length - $Right.Length) }
    return [Math]::Sign([string]::CompareOrdinal($Left, $Right))
}

function Compare-HostVersion([string] $Left, [string] $Right) {
    $pattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
    $leftMatch = [regex]::Match($Left, $pattern)
    $rightMatch = [regex]::Match($Right, $pattern)
    if (!$leftMatch.Success -or !$rightMatch.Success) {
        throw "Cannot compare Desktop versions '$Left' and '$Right'; no automatic upgrade was attempted."
    }
    foreach ($match in @($leftMatch, $rightMatch)) {
        foreach ($part in $match.Groups[4].Value.Split('.')) {
            if ($part -match '^0[0-9]+$') { throw 'Invalid numeric prerelease identifier; no automatic upgrade was attempted.' }
        }
    }
    foreach ($index in 1..3) {
        $comparison = Compare-VersionNumber $leftMatch.Groups[$index].Value $rightMatch.Groups[$index].Value
        if ($comparison -ne 0) { return $comparison }
    }
    $leftPre = $leftMatch.Groups[4].Value
    $rightPre = $rightMatch.Groups[4].Value
    if (!$leftPre -and !$rightPre) { return 0 }
    if (!$leftPre) { return 1 }
    if (!$rightPre) { return -1 }
    $leftParts = $leftPre.Split('.')
    $rightParts = $rightPre.Split('.')
    for ($index = 0; $index -lt [Math]::Min($leftParts.Length, $rightParts.Length); $index++) {
        $leftPart = $leftParts[$index]
        $rightPart = $rightParts[$index]
        $leftNumeric = $leftPart -match '^[0-9]+$'
        $rightNumeric = $rightPart -match '^[0-9]+$'
        if ($leftNumeric -and $rightNumeric) { $comparison = Compare-VersionNumber $leftPart $rightPart }
        elseif ($leftNumeric -ne $rightNumeric) { $comparison = $(if ($leftNumeric) { -1 } else { 1 }) }
        else { $comparison = [Math]::Sign([string]::CompareOrdinal($leftPart, $rightPart)) }
        if ($comparison -ne 0) { return $comparison }
    }
    return [Math]::Sign($leftParts.Length - $rightParts.Length)
}

$versionComparison = Compare-HostVersion $hostVersion $manifest.hostVersion
$hostUpgradeRequired = $versionComparison -lt 0
if ($versionComparison -gt 0 -or ($versionComparison -eq 0 -and $hostVersion -cne $manifest.hostVersion)) {
    throw "This package requires exactly DeepSeek Harness $($manifest.hostVersion); found $hostVersion. Automatic downgrade was not attempted."
}
if ($VerifyOnly -and $hostUpgradeRequired) {
    throw "Expected DeepSeek Harness $($manifest.hostVersion); found $hostVersion. VerifyOnly never upgrades Desktop."
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
$originalHostVersion = $hostVersion
$hostUpgraded = $false

function Get-HostUpgrade {
    $property = $manifest.PSObject.Properties['hostUpgrade']
    if ($null -eq $property -or $null -eq $property.Value) {
        throw 'This delivery is missing its pinned official Desktop upgrade identity.'
    }
    $upgrade = $property.Value
    $expectedUrl = "https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-$($manifest.hostVersion)-win-x64.exe"
    if ($upgrade.version -cne $manifest.hostVersion -or $upgrade.platform -cne 'win32-x64' -or
        $upgrade.url -cne $expectedUrl -or $upgrade.publisher -cne 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.' -or
        $upgrade.sha512 -cnotmatch '^[A-Za-z0-9+/]{86}==$' -or
        [Convert]::FromBase64String($upgrade.sha512).Length -ne 64 -or
        $upgrade.size -le 0) {
        throw 'Invalid pinned official Desktop upgrade identity.'
    }
    return $upgrade
}

function Assert-HostInstaller([string] $Path, $Upgrade) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Desktop installer missing: $Path" }
    if ((Get-Item -LiteralPath $Path).Length -ne $Upgrade.size) { throw 'Desktop installer size mismatch.' }
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA512).Hash
    $expectedHash = [BitConverter]::ToString([Convert]::FromBase64String($Upgrade.sha512)).Replace('-', '')
    if ($hash -cne $expectedHash) { throw 'Desktop installer SHA-512 mismatch.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne $Upgrade.publisher) {
        throw 'Desktop installer does not have a valid DeepSeek publisher signature.'
    }
}

function Get-HostInstaller($Upgrade) {
    if (![string]::IsNullOrWhiteSpace($HostInstallerPath)) {
        $localInstaller = (Resolve-Path -LiteralPath $HostInstallerPath).ProviderPath
        Assert-HostInstaller $localInstaller $Upgrade
        return $localInstaller
    }
    $cacheBase = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($cacheBase)) { $cacheBase = [IO.Path]::GetTempPath() }
    $cacheDirectory = Join-Path $cacheBase "dsh-noemaloom\host-installers\$($Upgrade.version)"
    $cachedInstaller = Join-Path $cacheDirectory ([IO.Path]::GetFileName(([uri]$Upgrade.url).AbsolutePath))
    if (Test-Path -LiteralPath $cachedInstaller -PathType Leaf) {
        try { Assert-HostInstaller $cachedInstaller $Upgrade; return $cachedInstaller }
        catch { Write-Host 'Cached Desktop installer is invalid; downloading the pinned official release again.' }
    }
    $null = New-Item -ItemType Directory -Path $cacheDirectory -Force
    $partial = Join-Path $cacheDirectory ("download-" + [Guid]::NewGuid().ToString('N') + '.exe')
    $savedProgress = $ProgressPreference
    $savedProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        $ProgressPreference = 'SilentlyContinue'
        [Net.ServicePointManager]::SecurityProtocol = $savedProtocol -bor [Net.SecurityProtocolType]::Tls12
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                Write-Host "Downloading official DeepSeek Harness $($Upgrade.version) (attempt $attempt/3)..."
                Invoke-WebRequest -UseBasicParsing -Uri $Upgrade.url -OutFile $partial -TimeoutSec 600
                break
            } catch {
                if ($attempt -eq 3) { throw "Official Desktop download failed after 3 attempts: $($_.Exception.Message)" }
                Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
            }
        }
        Assert-HostInstaller $partial $Upgrade
        Move-Item -LiteralPath $partial -Destination $cachedInstaller -Force
        return $cachedInstaller
    } finally {
        $ProgressPreference = $savedProgress
        [Net.ServicePointManager]::SecurityProtocol = $savedProtocol
        if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial -Force }
    }
}

function Update-DesktopHost {
    $upgrade = Get-HostUpgrade
    $installer = Get-HostInstaller $upgrade
    if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'DeepSeek Harness started while preparing the upgrade. Fully exit it and rerun; no processes were stopped.'
    }
    Write-Host "Upgrading DeepSeek Harness $hostVersion -> $($upgrade.version) in $HarnessDirectory ..."
    # NSIS requires /D= to be the final argument and its directory to be unquoted,
    # including directories containing spaces. Do not use --force-run.
    $process = Start-Process -FilePath $installer -ArgumentList "/S /D=$HarnessDirectory" -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Official Desktop upgrade failed: exit $($process.ExitCode). Plugin installation was not attempted." }
    $reported = @(& $cliPath --version)
    if ($LASTEXITCODE -ne 0 -or ($reported -join "`n").Trim() -cne $manifest.hostVersion) {
        throw 'Desktop upgrade did not produce the required bundled CLI version. Plugin installation was not attempted.'
    }
    if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Desktop started after upgrading. Fully exit it and rerun to install the plugin.'
    }
}

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
        targetHostVersion = $manifest.hostVersion
        hostUpgradeRequired = $hostUpgradeRequired
        hostUpgrade = $(if ($hostUpgradeRequired) { Get-HostUpgrade } else { $null })
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
    if ($hostUpgradeRequired) {
        Update-DesktopHost
        $hostVersion = $manifest.hostVersion
        $hostUpgraded = $true
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
    previousHostVersion = $originalHostVersion
    hostUpgraded = $hostUpgraded
    profile = 'desktop'
    installedDirectory = $packageRoot
    legacyRegistrationRemoved = $hadLegacy
    files = $verified
    activationVerified = $false
    next = 'Open DeepSeek Harness, confirm dsh-noemaloom in Plugin Manager, then verify the UI and diagnostics.'
} | ConvertTo-Json -Depth 5
