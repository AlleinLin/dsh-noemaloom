param(
    [ValidateSet('Tools', 'PowerShell')][string]$Variant = 'Tools',
    [string]$DshCommand,
    [switch]$Offline = $true
)
$ErrorActionPreference = 'Stop'
if ($Variant -eq 'PowerShell') {
    Write-Host '-Variant PowerShell is a backwards-compatible alias. Installing the complete Tools package, including file, search, and PowerShell replacements.'
}
$packageName = 'local-dsh-forge-tools-0.1.6.tgz'
$packagePath = Join-Path $PSScriptRoot $packageName
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw "Package missing: $packagePath" }
$checksums = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SHA256SUMS.txt')
$expectedLine = $checksums | Where-Object { $_.EndsWith("  $packageName") }
if (-not $expectedLine) { throw "Checksum missing: $packageName" }
$actualHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedLine.Substring(0, 64).ToLowerInvariant()) { throw 'Package checksum mismatch' }
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    throw 'Please fully exit DeepSeek Harness Desktop, then run this installer again.'
}
if (-not $DshCommand) {
    $candidateRoots = @(
        (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')
    )
    foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path -LiteralPath $registryRoot) {
            $entries = Get-ItemProperty -Path "$registryRoot\*" -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match 'DeepSeek Harness' -and $_.InstallLocation }
            foreach ($entry in $entries) { $candidateRoots += $entry.InstallLocation }
        }
    }
    foreach ($candidateRoot in $candidateRoots) {
        $candidate = Join-Path $candidateRoot 'resources\runtime\cli\bin\dsh.cmd'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $DshCommand = $candidate; break }
    }
}
if (-not $DshCommand -or -not (Test-Path -LiteralPath $DshCommand -PathType Leaf)) {
    throw 'Desktop plugin installer not found. Pass -DshCommand with the full path to the Desktop-bundled dsh.cmd.'
}
$versionOutput = & $DshCommand --version
if ($LASTEXITCODE -ne 0 -or "$versionOutput" -notmatch '0\.2\.1-rc\.5(?:\s|$)') {
    throw "This package targets DSH 0.2.1-rc.5. Found: $versionOutput"
}
# Match the installed Desktop's dsh-home-paths resolver: nonblank DSH_HOME
# (including supported tilde prefixes), otherwise the OS home's .dsh directory.
$osHome = if ($env:USERPROFILE) { $env:USERPROFILE } else {
    [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
}
if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    $selectedDshHome = Join-Path $osHome '.dsh'
} else {
    $selectedDshHome = $env:DSH_HOME
    if ($selectedDshHome -eq '~') {
        $selectedDshHome = $osHome
    } elseif ($selectedDshHome.StartsWith('~/') -or $selectedDshHome.StartsWith('~\')) {
        $selectedDshHome = Join-Path $osHome $selectedDshHome.Substring(2)
    }
}
$selectedDshHome = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($selectedDshHome)
$desktopProfile = Join-Path $selectedDshHome 'profiles\desktop'
$profileManifestPath = Join-Path $desktopProfile 'package.json'
$otherPackage = '@local/dsh-forge-pwsh'
if (Test-Path -LiteralPath $profileManifestPath -PathType Leaf) {
    $profileManifest = Get-Content -LiteralPath $profileManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    if (@($profileManifest.dsh.profile.bundles) -contains $otherPackage) {
        $quotedDsh = $DshCommand.Replace("'", "''")
        $quotedHome = $selectedDshHome.Replace("'", "''")
        throw @"
The legacy standalone Forge PowerShell package is enabled in Desktop: $otherPackage
Selected DSH home: $selectedDshHome
Forge 0.1.6 installs the complete Tools package only. Existing configuration was preserved; installation was not attempted. Exit Desktop, then uninstall this legacy package before retrying:
`$env:DSH_HOME = '$quotedHome'
& '$quotedDsh' plugin --profile desktop remove '$otherPackage'
"@
    }
}
$profilePatchPath = Join-Path $desktopProfile 'cordis.patch.yml'
if (Test-Path -LiteralPath $profilePatchPath -PathType Leaf) {
    $profilePatch = Get-Content -LiteralPath $profilePatchPath -Raw -Encoding utf8
    # Both block entries and inline YAML maps can target the official preset.
    $standardId = '(?:"id"|''id''|id)[ \t]*:[ \t]*(?:"preset-standard"|''preset-standard''|preset-standard)(?=[ \t]*(?:$|#|[,}\]]))'
    $blockEntry = '(?m)^[ \t]*(?:-[ \t]*)?' + $standardId
    $flowEntry = '(?m)^[ \t]*[^#\r\n]*[,{][ \t]*' + $standardId
    if ($profilePatch -match $blockEntry -or $profilePatch -match $flowEntry) {
        throw @"
Desktop already has a profile-level preset-standard customization:
$profilePatchPath
This layer takes precedence over the plugin and can override its tools. The existing customization was preserved; installation was not attempted. Back up this file, merge its standard preset settings with the Forge tool configuration, and remove the conflicting override before retrying. Do not delete your existing customizations without reviewing the merge.
"@
    }
}
$installArgs = @('plugin', '--profile', 'desktop', 'add', '--ignore-scripts', '--save-exact')
if ($Offline) { $installArgs += '--offline' }
$installArgs += $packagePath
& $DshCommand @installArgs
if ($LASTEXITCODE -ne 0) {
    throw 'Host package manager reported failure. No activation was claimed. If offline dependencies are missing, retry with -Offline:$false on an authorized network.'
}
Write-Host "Installed into DeepSeek Harness Desktop. Bundled installer: $DshCommand"
Write-Host 'Restart DeepSeek Harness Desktop and start a NEW conversation with the official default standard preset.'
