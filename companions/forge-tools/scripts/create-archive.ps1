param([Parameter(Mandatory = $true)][string]$DeliveryPath, [Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = 'Stop'
$resolvedDelivery = (Resolve-Path -LiteralPath $DeliveryPath).Path
$archiveName = "dsh-forge-tools-$Version-win-x64.zip"
$archivePath = Join-Path $resolvedDelivery $archiveName
$paths = Get-ChildItem -LiteralPath $resolvedDelivery -File |
    Where-Object { $_.Extension -ne '.zip' -and $_.Extension -ne '.sha256' } |
    Select-Object -ExpandProperty FullName
Compress-Archive -LiteralPath $paths -DestinationPath $archivePath -Force
$digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$archivePath.sha256" -Value "$digest  $archiveName" -Encoding utf8NoBOM
Write-Output "Delivery: $archivePath"
