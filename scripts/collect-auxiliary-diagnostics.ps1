#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$HarnessHome,
    [string]$HarnessDirectory,
    [string]$DatabasePath,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (!$HarnessHome) { $HarnessHome = $env:DSH_HOME }
if (!$HarnessHome) { $HarnessHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
if ($HarnessHome -eq '~') { $HarnessHome = [Environment]::GetFolderPath('UserProfile') }
if ($HarnessHome.StartsWith('~\') -or $HarnessHome.StartsWith('~/')) {
    $HarnessHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) $HarnessHome.Substring(2)
}
$HarnessHome = [IO.Path]::GetFullPath($HarnessHome)
$profilePath = Join-Path $HarnessHome 'profiles\desktop'
$pluginPath = Join-Path $profilePath 'node_modules\@local\dsh-nexus'
if (!$OutputDirectory) {
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    if (!$desktopPath) { $desktopPath = $env:TEMP }
    $OutputDirectory = Join-Path $desktopPath ('dsh-nexus-diagnostics-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$report = [ordered]@{
    schemaVersion = 2; collectorVersion = '2.0'; collectedAt = [DateTimeOffset]::Now.ToString('o')
    powershell = $PSVersionTable.PSVersion.ToString()
    os = [Environment]::OSVersion.VersionString
    profileFound = (Test-Path -LiteralPath $profilePath)
    pluginFound = (Test-Path -LiteralPath $pluginPath)
    processes = @(); installedFiles = @(); logSignals = @()
    privacy = 'No credentials, configuration values, session content, database copies or raw logs are exported.'
}
$running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
foreach ($process in $running) {
    try {
        $report.processes += [ordered]@{
            pid = $process.Id; cpuSeconds = $process.CPU
            workingSetMB = [Math]::Round($process.WorkingSet64 / 1MB, 1)
            privateMemoryMB = [Math]::Round($process.PrivateMemorySize64 / 1MB, 1)
            handles = $process.HandleCount; threads = $process.Threads.Count
        }
        if (!$HarnessDirectory -and $process.Path) { $HarnessDirectory = Split-Path -Parent $process.Path }
    } catch {}
}
if (!$HarnessDirectory) {
    foreach ($candidate in @('D:\Program Files\DeepSeek Harness', "$env:ProgramFiles\DeepSeek Harness", "$env:LOCALAPPDATA\Programs\DeepSeek Harness")) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'DeepSeek Harness.exe')) { $HarnessDirectory = $candidate; break }
    }
}
$metadataPath = Join-Path $pluginPath 'package.json'
if (Test-Path -LiteralPath $metadataPath) {
    try {
        $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($metadata.version -match '^\d+\.\d+\.\d+[-+a-zA-Z0-9.]*$') { $report.pluginVersion = $metadata.version }
        $hostEngine = [string]$metadata.engines.dsh
        if ($hostEngine -match '^[0-9a-zA-Z.*^~+<>=| -]{1,100}$') { $report.hostEngine = $hostEngine }
    } catch { $report.packageMetadataError = 'UNREADABLE_PACKAGE_METADATA' }
}
foreach ($relative in @('lib\index.js', 'lib\client.js', 'lib\workers\storage-worker.js', 'lib\workers\storage-reader-worker.js')) {
    $file = Join-Path $pluginPath $relative
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        $item = Get-Item -LiteralPath $file
        $report.installedFiles += [ordered]@{ path = $relative; bytes = $item.Length; modifiedUtc = $item.LastWriteTimeUtc.ToString('o'); sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
}
if (!$DatabasePath) { $DatabasePath = Join-Path $profilePath 'data\nexus\database\nexus.sqlite' }
$report.databaseFiles = @()
foreach ($suffix in @('', '-wal', '-shm')) {
    if (Test-Path -LiteralPath ($databasePath + $suffix) -PathType Leaf) {
        $item = Get-Item -LiteralPath ($databasePath + $suffix)
        $report.databaseFiles += [ordered]@{ name = 'nexus.sqlite' + $suffix; bytes = $item.Length; modifiedUtc = $item.LastWriteTimeUtc.ToString('o') }
    }
}
$probeSource = @'
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
const file=Buffer.from(process.argv[2],'base64').toString('utf8');
const emit=value=>console.log(JSON.stringify(value));
const failure=e=>({code:/^[A-Z_0-9]+$/.test(e.code??'')?e.code:'PROBE_ERROR',errcode:Number.isInteger(e.errcode)?e.errcode:null});
const collectionName=name=>/^[a-z][a-z0-9_-]{0,80}$/.test(name)?name:'other-'+createHash('sha256').update(String(name)).digest('hex').slice(0,12);
emit({type:'runtime',node:process.version,exists:existsSync(file),readOnly:true});
if(!existsSync(file)) process.exit(0);
let DatabaseSync;
try{({DatabaseSync}=await import('node:sqlite'))}catch(e){emit({type:'error',stage:'load-sqlite',error:failure(e)});process.exit(1)}
let db;
try{
  emit({type:'stage-start',stage:'open'});
  const started=performance.now();
  db=new DatabaseSync(file,{readOnly:true});
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;');
  const pragma=name=>Object.values(db.prepare('PRAGMA '+name).get())[0];
  const pageSize=pragma('page_size'),pageCount=pragma('page_count'),freePages=pragma('freelist_count');
  emit({type:'database',elapsedMs:Math.round(performance.now()-started),sqliteVersion:db.prepare('SELECT sqlite_version() AS v').get().v,
    journalMode:pragma('journal_mode'),pageSize,pageCount,freePages,freeBytes:freePages*pageSize,
    allocatedBytes:pageCount*pageSize,userVersion:pragma('user_version')});
  emit({type:'query-plan',details:db.prepare("EXPLAIN QUERY PLAN SELECT revision FROM nexus_records WHERE collection='scope-settings' AND id='global/auxiliary'").all().map(r=>r.detail)});
  for(let i=0;i<4;i++){
    const start=performance.now();
    try{
      const rows=db.prepare("SELECT id,revision,deleted,octet_length(value) AS bytes,checksum,CASE WHEN octet_length(value)<=65536 THEN value END AS smallValue FROM nexus_records WHERE collection='scope-settings' AND id IN ('global/companion','global/auxiliary','global/insights','global/autonomy')").all();
      emit({type:'settings-sample',sample:i+1,elapsedMs:Math.round(performance.now()-start),
        settings:rows.map(r=>{let jsonValid=null,checksumValid=null;if(r.smallValue!==null){try{JSON.parse(r.smallValue);jsonValid=true}catch{jsonValid=false}
          checksumValid=createHash('sha256').update(r.smallValue).digest('hex')===r.checksum}
          return {key:r.id,revision:r.revision,deleted:!!r.deleted,bytes:r.bytes,jsonValid,checksumValid}})});
    }catch(e){emit({type:'error',stage:'settings-read',sample:i+1,elapsedMs:Math.round(performance.now()-start),error:failure(e)})}
    if(i<3)await new Promise(r=>setTimeout(r,750));
  }
  emit({type:'stage-start',stage:'collection-sizes'});
  const aggregateStart=performance.now();
  const collections=db.prepare("SELECT collection,COUNT(*) AS records,SUM(deleted) AS deletedRecords,SUM(octet_length(value)) AS valueBytes,MAX(octet_length(value)) AS largestValueBytes FROM nexus_records GROUP BY collection ORDER BY valueBytes DESC LIMIT 30").all();
  emit({type:'collection-sizes',elapsedMs:Math.round(performance.now()-aggregateStart),
    collections:collections.map(r=>({...r,collection:collectionName(r.collection)}))});
  emit({type:'complete'});
}catch(e){emit({type:'error',stage:'database-probe',error:failure(e)});process.exitCode=1}
finally{try{db?.close()}catch{}}
'@
$probeFile = Join-Path $OutputDirectory 'sqlite-readonly-probe.mjs'
[IO.File]::WriteAllText($probeFile, $probeSource, (New-Object Text.UTF8Encoding($false)))
$nodePath = $null
if ($HarnessDirectory) {
    $candidate = Join-Path $HarnessDirectory 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $candidate) { $nodePath = $candidate }
}
if (!$nodePath) { $command = Get-Command node.exe -ErrorAction SilentlyContinue; if ($command) { $nodePath = $command.Source } }
if ($nodePath) {
    $helper = $null
    try {
        $encodedPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($databasePath))
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $nodePath
        $startInfo.Arguments = '--no-warnings "' + $probeFile + '" ' + $encodedPath
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $helper = New-Object System.Diagnostics.Process
        $helper.StartInfo = $startInfo
        $null = $helper.Start()
        $stdoutTask = $helper.StandardOutput.ReadToEndAsync()
        $stderrTask = $helper.StandardError.ReadToEndAsync()
        $timedOut = !$helper.WaitForExit(15000)
        if ($timedOut) {
            $helper.Kill()
            $null = $helper.WaitForExit(2000)
        }
        $probeOutput = $stdoutTask.GetAwaiter().GetResult()
        $probeErrors = $stderrTask.GetAwaiter().GetResult()
        $events = @()
        foreach ($line in ($probeOutput -split '\r?\n')) {
            if ($line.Trim()) { try { $events += ($line | ConvertFrom-Json) } catch {} }
        }
        $runtimeCodes = @([regex]::Matches($probeErrors, '\b(?:ERR_[A-Z_0-9]+|SQLITE_[A-Z_0-9]+)\b') | ForEach-Object { $_.Value } | Select-Object -Unique)
        $status = if ($timedOut) { 'READ_ONLY_PROBE_TIMEOUT' } elseif ($helper.ExitCode -eq 0 -and $events.Count -gt 0) { 'PROBE_COMPLETED' } else { 'PROBE_RUNTIME_FAILED' }
        $report.sqliteProbe = @{ status = $status; exitCode = $helper.ExitCode; deadlineMs = 15000; events = $events; runtimeErrorCodes = $runtimeCodes }
    } catch { $report.sqliteProbe = @{ status = 'PROBE_UNAVAILABLE'; exceptionType = $_.Exception.GetType().Name } }
    finally { if ($helper) { $helper.Dispose() } }
} else { $report.sqliteProbe = @{ status = 'NODE_RUNTIME_NOT_FOUND' } }
$logRoots = @((Join-Path $profilePath 'logs'), (Join-Path $HarnessHome 'logs'), (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\logs'))
$logIndex = 0
foreach ($directory in $logRoots) {
    if (!(Test-Path -LiteralPath $directory -PathType Container)) { continue }
    $files = @(Get-ChildItem -LiteralPath $directory -File -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 5)
    foreach ($file in $files) {
        $logIndex++
        try {
            $tail = @(Get-Content -LiteralPath $file.FullName -Tail 1500 -Encoding UTF8 -ErrorAction Stop)
            $text = $tail -join "`n"
            $codes = @([regex]::Matches($text, '\b(?:SQLITE_[A-Z_]+|AUXILIARY_[A-Z_]+|INTEGRITY_FAILED|NX_[A-Z0-9_]+)\b|nexus/auxiliary-[a-z-]+') | ForEach-Object { $_.Value } | Group-Object | ForEach-Object { @{ code = $_.Name; count = $_.Count } })
            $report.logSignals += @{ index = $logIndex; modifiedUtc = $file.LastWriteTimeUtc.ToString('o'); examinedTailLines = $tail.Count; errorCodes = $codes
                storageMentions = ([regex]::Matches($text, 'storage-worker|scope-settings|SQLite|database is locked')).Count
                rpcMentions = ([regex]::Matches($text, 'nexus/rpc|companion.settings|auxiliary-settings')).Count }
        } catch { $report.logSignals += @{ index = $logIndex; status = 'LOG_UNREADABLE' } }
    }
}
$reportPath = Join-Path $OutputDirectory 'diagnostics.json'
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$readmePath = Join-Path $OutputDirectory 'README.txt'
'Captured while the settings page is failing. Read-only SQLite probe; no database contents, configuration values, credentials or raw logs exported. No Harness process is stopped. A successful standalone SQLite read does not prove the live plugin worker queue is responsive. Missing files may mean a custom data directory; tell the investigator if Nexus dataDir was customized.' | Set-Content -LiteralPath $readmePath -Encoding UTF8
foreach ($temporaryName in @('probe-output.tmp', 'probe-error.tmp', 'sqlite-readonly-probe.mjs')) {
    $temporaryFile = Join-Path $OutputDirectory $temporaryName
    if (Test-Path -LiteralPath $temporaryFile -PathType Leaf) { Remove-Item -LiteralPath $temporaryFile }
}
$zipPath = $OutputDirectory.TrimEnd('\', '/') + '.zip'
Compress-Archive -LiteralPath @($reportPath, $readmePath) -DestinationPath $zipPath -Force
Write-Host ('Diagnostic archive: ' + $zipPath)
