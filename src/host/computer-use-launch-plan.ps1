# A read-only, exact launch plan. This is generated into the runtime worker;
# immutable upstream sources remain in vendor/computer-use.
function Assert-NexusNoReparsePath([string]$path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    while ($null -ne $item) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "[NX_COMPUTER_TARGET_UNVERIFIABLE] Reparse-point launch paths cannot be identified exactly. Nothing was launched."
        }
        $parentPath = [System.IO.Path]::GetDirectoryName($item.FullName.TrimEnd('\'))
        if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -eq $item.FullName) { break }
        $item = Get-Item -LiteralPath $parentPath -Force -ErrorAction Stop
    }
}

function Get-NexusFileIdentity([string]$path) {
    if (-not [System.IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "[NX_COMPUTER_TARGET_UNVERIFIABLE] No existing absolute file identifies '$path'. Nothing was launched."
    }
    Assert-NexusNoReparsePath $path
    $canonical = (Get-Item -LiteralPath $path -ErrorAction Stop).FullName
    return [ordered]@{ path = $canonical; sha256 = (Get-FileHash -LiteralPath $canonical -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
}

function Get-NexusLaunchPlan([object]$Arg) {
    $resolved = Resolve-LaunchTarget ([string]$Arg.target) ($Arg.refresh -eq $true)
    $arguments = @()
    if ($null -ne $Arg.arguments) { $arguments = @($Arg.arguments | ForEach-Object { [string]$_ }) }
    $cwd = [string]$Arg.cwd
    if (-not [System.IO.Path]::IsPathRooted($cwd) -or -not (Test-Path -LiteralPath $cwd -PathType Container)) {
        throw "[NX_COMPUTER_TARGET_UNVERIFIABLE] A known absolute session cwd is required. Nothing was launched."
    }
    Assert-NexusNoReparsePath $cwd
    $cwd = (Get-Item -LiteralPath $cwd -ErrorAction Stop).FullName
    $shell = $false
    $targetIdentity = $null
    $shortcut = $null
    $target = [string]$resolved.file
    if ($resolved.kind -eq 'store') {
        if ($target -notmatch '^shell:AppsFolder\\[^\x00-\x1f]+$' -or $arguments.Count -gt 0) {
            throw "[NX_COMPUTER_TARGET_UNVERIFIABLE] This Store activation or its extra arguments cannot be verified. Nothing was launched."
        }
        $shell = $true
    } else {
        $targetIdentity = Get-NexusFileIdentity $target
        $target = [string]$targetIdentity.path
        $extension = [System.IO.Path]::GetExtension($target).ToLowerInvariant()
        if (@('.bat', '.cmd', '.ps1', '.vbs', '.js', '.wsf') -contains $extension) {
            throw "[NX_COMPUTER_TARGET_UNVERIFIABLE] Script interpreter dispatch cannot be identified exactly. Launch an explicit executable and argv instead. Nothing was launched."
        }
        $shell = @('.exe', '.com') -notcontains $extension
        if ($extension -eq '.lnk') {
            $link = (New-Object -ComObject WScript.Shell).CreateShortcut($target)
            $linkTarget = [string]$link.TargetPath
            if ([string]::IsNullOrWhiteSpace($linkTarget)) {
                throw "[NX_COMPUTER_TARGET_UNVERIFIABLE] The shortcut has no verifiable target. Nothing was launched."
            }
            $shortcut = [ordered]@{ target = (Get-NexusFileIdentity $linkTarget); arguments = [string]$link.Arguments; cwd = [string]$link.WorkingDirectory }
        }
    }
    $program = if ($shell) { Get-NexusFileIdentity (Join-Path $env:SystemRoot 'explorer.exe') } else { $targetIdentity }
    $argv = if ($shell) { @($target) + @($arguments) } else { @($arguments) }
    $encodedArgv = @($argv | ForEach-Object {
        $text = [string]$_
        if ($text -notmatch '[\s"]' -and $text.Length -gt 0) { $text }
        else {
            # Windows native argv encoding: protect quotes and the trailing
            # backslashes before the closing quote. No shell is involved.
            '"' + ([regex]::Replace([regex]::Replace($text, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
        }
    })
    return [ordered]@{
        version = 1
        executable = [string]$program.path
        executableSha256 = [string]$program.sha256
        argv = @($argv)
        windowsArgumentLine = [string]::Join(' ', $encodedArgv)
        cwd = $cwd
        target = $target
        targetIdentity = $targetIdentity
        shortcut = $shortcut
        shellActivation = [bool]$shell
        resolution = [ordered]@{ kind = [string]$resolved.kind; file = [string]$resolved.file; label = [string]$resolved.label }
    }
}

function Assert-NexusLaunchPlan([object]$Arg) {
    if ($null -eq $Arg.nexusExpectedPlan) {
        throw "[NX_COMPUTER_AUTHORITY_UNAVAILABLE] No native-approved launch plan accompanies this request. Nothing was launched."
    }
    $current = Get-NexusLaunchPlan $Arg
    $expectedJson = $Arg.nexusExpectedPlan | ConvertTo-Json -Compress -Depth 12
    $currentJson = $current | ConvertTo-Json -Compress -Depth 12
    if ($expectedJson -cne $currentJson) {
        throw "[NX_COMPUTER_TARGET_CHANGED] The actual launch target, argv, cwd or file bytes changed after native approval. Nothing was launched."
    }
    Assert-CanSend 'before the native-approved process launch'
    return $current
}
