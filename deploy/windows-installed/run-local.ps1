param([switch]$Stop, [switch]$OpenBrowser, [switch]$Lan, [string]$LanIP)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskApp = Join-Path $taskRoot 'concord'
$taskRuntime = Join-Path $taskRoot 'runtime'
$taskState = Join-Path $taskRoot 'local-data'
$taskLogs = Join-Path $taskState 'logs'
$taskPgBin = Join-Path $taskRuntime 'postgres\pgsql\bin'
$taskPgData = Join-Path $taskState 'postgres'
$taskNode = $env:CONCORD_NODE
if (-not $taskNode) { $taskNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $taskNode -or -not (Test-Path -LiteralPath $taskNode)) { throw 'Node.js 24+ is required. Install Node on PATH or set CONCORD_NODE to node.exe.' }
$taskTcpMedia = if($env:LIVEKIT_TCP_PORT){[int]$env:LIVEKIT_TCP_PORT}else{7881}
$taskUdpMedia = if($env:LIVEKIT_UDP_PORT){[int]$env:LIVEKIT_UDP_PORT}else{7882}
if($taskTcpMedia -lt 1 -or $taskTcpMedia -gt 65535 -or $taskUdpMedia -lt 1 -or $taskUdpMedia -gt 65535){throw 'Invalid media port'}
$taskPidFile = Join-Path $taskState 'processes.json'
$taskUrl = 'http://localhost:5173'
$taskLanFile = Join-Path $taskState 'lan.json'
$taskLan = $null
if ($Lan) {
    $taskAdapters = [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object {
        $_.OperationalStatus -eq 'Up' -and $_.GetIPProperties().GatewayAddresses.Count -gt 0
    }
    $taskCandidates = foreach($adapter in $taskAdapters) {
        foreach($address in $adapter.GetIPProperties().UnicastAddresses) {
            $ip=$address.Address.ToString()
            if($ip -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)') {
                [pscustomobject]@{ip=$ip;interfaceAlias=$adapter.Name;prefix=$address.PrefixLength}
            }
        }
    }
    if($LanIP){$taskCandidate=$taskCandidates | Where-Object ip -eq $LanIP | Select-Object -First 1}
    else{$taskCandidate=$taskCandidates | Select-Object -First 1}
    if(-not $taskCandidate){throw 'No private IPv4 address with a gateway found. Use -Lan -LanIP <Wi-Fi IP>.'}
    $taskLan=@{ip=$taskCandidate.ip;interfaceAlias=$taskCandidate.interfaceAlias;prefix=$taskCandidate.prefix;httpsPort=8443;mediaTcpPort=$taskTcpMedia;mediaUdpPort=$taskUdpMedia}
    New-Item -ItemType Directory -Path $taskState -Force | Out-Null
    $taskLan | ConvertTo-Json | Set-Content -LiteralPath $taskLanFile -Encoding UTF8
}
if(Test-Path -LiteralPath $taskLanFile){$taskLan=Get-Content -LiteralPath $taskLanFile -Raw | ConvertFrom-Json}
if($taskLan){
    $taskLanIP=[Net.IPAddress]::Parse($taskLan.ip)
    if($taskLanIP.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $taskLan.ip -notmatch '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)'){throw 'Invalid LAN IPv4 configuration'}
    $assigned=@([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object {$_.GetIPProperties().UnicastAddresses} | ForEach-Object {$_.Address.ToString()})
    if(-not $Stop -and $taskLan.ip -notin $assigned){throw 'Wi-Fi IP changed. Stop Concord, then run Start-Concord-LAN.cmd to detect the new IP.'}
    $taskUrl="https://$($taskLan.ip):8443"
}
$taskDatabase = 'concord'
$taskDbConfig = Join-Path $taskState 'database.json'
if (Test-Path -LiteralPath $taskDbConfig) { $taskDatabase = (Get-Content -LiteralPath $taskDbConfig -Raw | ConvertFrom-Json).name }
if ($taskDatabase -notin @('concord','concord_utf8')) { throw 'Unknown local database name' }
New-Item -ItemType Directory -Path $taskState,$taskLogs,(Join-Path $taskState 'uploads'),(Join-Path $taskState 'redis') -Force | Out-Null

function Get-LocalProcess($entry) {
    $p = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if ($p -and $p.Path -eq $entry.path -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $entry.startTicks) { return $p }
    return $null
}
function Start-LocalProcess([string]$name,[string]$exe,[string[]]$arguments,[string]$directory) {
    $p = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $directory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs "$name.log") -RedirectStandardError (Join-Path $taskLogs "$name.err.log") -PassThru
    $taskProcesses.Add([pscustomobject]@{ name=$name; id=$p.Id; path=$exe; startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString() })
    $taskProcesses | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $taskPidFile -Encoding UTF8
    Write-Host "Started $name"
}
function Wait-LocalPort([int]$port,[string]$name) {
    for ($i=0; $i -lt 60; $i++) {
        $client = New-Object Net.Sockets.TcpClient
        try { $client.Connect('127.0.0.1',$port); return } catch { Start-Sleep -Milliseconds 500 } finally { $client.Dispose() }
    }
    throw "$name did not start. See $taskLogs"
}

if ($Stop) {
    if (Test-Path -LiteralPath $taskPidFile) {
        $entries = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
        foreach ($entry in $entries | Where-Object name -ne 'postgres') {
            $p = Get-LocalProcess $entry
            if ($p) { Stop-Process -Id $p.Id -Force }
        }
        $pgEntry = $entries | Where-Object name -eq 'postgres' | Select-Object -First 1
        if ($pgEntry -and (Get-LocalProcess $pgEntry)) {
            & (Join-Path $taskPgBin 'pg_ctl.exe') -D $taskPgData stop -m fast -w
            if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL stop failed' }
        }
        Remove-Item -LiteralPath $taskPidFile
    }
    Write-Host 'Concord stopped. Your data is preserved.'
    exit 0
}

if (Test-Path -LiteralPath $taskPidFile) {
    $entries = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
    $live = @($entries | Where-Object { Get-LocalProcess $_ })
    $taskExpectedCount=if($taskLan){7}else{6}
    if ($live.Count -eq $taskExpectedCount) {
        try {
            $health = Invoke-RestMethod -Uri 'http://localhost:5173/api/health' -TimeoutSec 3
            if ($health.ok) {
                Write-Host "Concord is running: $taskUrl"
                if ($OpenBrowser) { Start-Process $taskUrl }
                exit 0
            }
        } catch { }
    }
    if ($live.Count -gt 0) { throw 'An incomplete Concord stack is running. Use the stop shortcut, then start again.' }
}

foreach ($port in @(5173,4000,55432,56379,7880,$taskTcpMedia,51025,58025)) {
    $client = New-Object Net.Sockets.TcpClient
    $busy = $false
    try { $client.Connect('127.0.0.1',$port); $busy=$true } catch { } finally { $client.Dispose() }
    if ($busy) { throw "Port $port is already in use." }
}
if($taskLan){
    foreach($port in @(8443,52019)){
        $probe=New-Object Net.Sockets.TcpClient
        try{$probe.Connect('127.0.0.1',$port);throw "LAN port $port is already in use."}catch [Net.Sockets.SocketException]{}finally{$probe.Dispose()}
    }
}

$taskSecretsFile = Join-Path $taskState 'secrets.json'
if (-not (Test-Path -LiteralPath $taskSecretsFile)) {
    function New-LocalSecret {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($bytes); $rng.Dispose()
        return -join ($bytes | ForEach-Object { $_.ToString('x2') })
    }
    @{ postgres=(New-LocalSecret); jwt=(New-LocalSecret); livekit=(New-LocalSecret) } | ConvertTo-Json | Set-Content -LiteralPath $taskSecretsFile -Encoding UTF8
}
$taskSecrets = Get-Content -LiteralPath $taskSecretsFile -Raw | ConvertFrom-Json
$taskProcesses = New-Object 'System.Collections.Generic.List[object]'

if (-not (Test-Path -LiteralPath (Join-Path $taskPgData 'PG_VERSION'))) {
    $taskPwFile = Join-Path $taskState 'pg-init-password.txt'
    [IO.File]::WriteAllText($taskPwFile,$taskSecrets.postgres,[Text.Encoding]::ASCII)
    try {
        & (Join-Path $taskPgBin 'initdb.exe') -D $taskPgData -U concord "--pwfile=$taskPwFile" --auth=scram-sha-256 --encoding=UTF8 --locale=C
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed' }
    } finally { Remove-Item -LiteralPath $taskPwFile }
    Add-Content -LiteralPath (Join-Path $taskPgData 'postgresql.conf') -Value "`nlisten_addresses = '127.0.0.1'`nport = 55432"
}

$taskPgControl = Start-Process -FilePath (Join-Path $taskPgBin 'pg_ctl.exe') -ArgumentList @('-D',('"'+$taskPgData+'"'),'-l',('"'+(Join-Path $taskLogs 'postgres.log')+'"'),'start','-w') -WindowStyle Hidden -PassThru
$taskPgControl.WaitForExit()
if ($taskPgControl.ExitCode -ne 0) { throw 'PostgreSQL startup failed. See postgres.log.' }
$taskPgPid = [int](Get-Content -LiteralPath (Join-Path $taskPgData 'postmaster.pid') -TotalCount 1)
$taskPgProcess = Get-Process -Id $taskPgPid
$taskProcesses.Add([pscustomobject]@{name='postgres'; id=$taskPgPid; path=$taskPgProcess.Path; startTicks=$taskPgProcess.StartTime.ToUniversalTime().Ticks.ToString()})
$taskProcesses | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $taskPidFile -Encoding UTF8
$env:PGPASSWORD = $taskSecrets.postgres
try {
    $dbExists = & (Join-Path $taskPgBin 'psql.exe') -h 127.0.0.1 -p 55432 -U concord -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$taskDatabase'"
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL connection failed' }
    if ($dbExists -ne '1') {
        & (Join-Path $taskPgBin 'createdb.exe') -h 127.0.0.1 -p 55432 -U concord -T template0 -E UTF8 --locale-provider=libc --lc-collate=Russian_Russia.1251 --lc-ctype=Russian_Russia.1251 $taskDatabase
        if ($LASTEXITCODE -ne 0) { throw 'Database creation failed' }
    }
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }

$taskRedisDir = (Join-Path $taskState 'redis').Replace('\','/')
$taskRedisConfig = Join-Path $taskState 'redis.conf'
@"
bind 127.0.0.1
port 56379
protected-mode yes
dir "$taskRedisDir"
appendonly yes
save 60 1
"@ | Set-Content -LiteralPath $taskRedisConfig -Encoding ASCII
Start-LocalProcess 'redis' (Join-Path $taskRuntime 'redis\redis-server.exe') @(('"'+$taskRedisConfig+'"')) $taskState
Wait-LocalPort 56379 'Redis'

$taskLkConfig = Join-Path $taskState 'livekit.yaml'
$taskMediaIP=if($taskLan){$taskLan.ip}else{'127.0.0.1'}
$taskMediaBind=if($taskLan){'["127.0.0.1", "'+$taskLan.ip+'"]'}else{'["127.0.0.1"]'}
@"
port: 7880
bind_addresses: $taskMediaBind
log_level: info
rtc:
  tcp_port: $taskTcpMedia
  udp_port: $taskUdpMedia
  use_external_ip: false
  node_ip: $taskMediaIP
  enable_loopback_candidate: true
keys:
  concordlocal: $($taskSecrets.livekit)
webhook:
  api_key: concordlocal
  urls:
    - http://127.0.0.1:4000/api/webhooks/livekit
room:
  empty_timeout: 30
"@ | Set-Content -LiteralPath $taskLkConfig -Encoding ASCII
Start-LocalProcess 'livekit' (Join-Path $taskRuntime 'livekit-new\livekit-server.exe') @('--config',('"'+$taskLkConfig+'"')) $taskState
Wait-LocalPort 7880 'LiveKit'

Start-LocalProcess 'mailpit' (Join-Path $taskRuntime 'mailpit\mailpit.exe') @('--listen','127.0.0.1:58025','--smtp','127.0.0.1:51025','--database',('"'+(Join-Path $taskState 'mailpit.db')+'"'),'--disable-version-check','--smtp-disable-rdns') $taskState
Wait-LocalPort 51025 'Local mail'

$env:NODE_ENV='development'
$env:HOST='127.0.0.1'
$env:PORT='4000'
$env:APP_URL=$taskUrl
$env:CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,$taskUrl,https://localhost:8443"
$env:TRUST_PROXY='1'
$env:COOKIE_SECURE=if($taskLan){'true'}else{'false'}
$env:DEMO_MAILBOX=if($taskLan){'true'}else{'false'}
$env:DATABASE_URL="postgres://concord:$($taskSecrets.postgres)@127.0.0.1:55432/$taskDatabase"
$env:REDIS_URL='redis://127.0.0.1:56379'
$env:JWT_SECRET=$taskSecrets.jwt
$env:STORAGE_DRIVER='local'
$env:STORAGE_LOCAL_DIR=Join-Path $taskState 'uploads'
$env:LIVEKIT_URL='http://127.0.0.1:7880'
$env:LIVEKIT_PUBLIC_URL='/livekit'
$env:LIVEKIT_API_KEY='concordlocal'
$env:LIVEKIT_API_SECRET=$taskSecrets.livekit
$env:GIF_PROVIDER='none'
$env:SMTP_HOST='127.0.0.1';$env:SMTP_PORT='51025';$env:SMTP_STARTTLS='false';$env:SMTP_TLS='false'
$env:REQUIRE_EMAIL_VERIFICATION='true'
$env:SEED_ON_START='1'
Start-LocalProcess 'backend' $taskNode @('--enable-source-maps','dist/index.js') (Join-Path $taskApp 'backend')
Wait-LocalPort 4000 'Backend'

$env:PORT='5173'
$env:BACKEND='http://127.0.0.1:4000'
$env:LIVEKIT='http://127.0.0.1:7880'
$env:FRONTEND_TRUST_PROXY=if($taskLan){'1'}else{'0'}
Start-LocalProcess 'frontend' $taskNode @('scripts/serve.mjs') (Join-Path $taskApp 'frontend')
Wait-LocalPort 5173 'Frontend'
$health = Invoke-RestMethod -Uri 'http://localhost:5173/api/health' -TimeoutSec 5
if (-not $health.ok) { throw 'API health check failed' }
if($taskLan){
    $taskCaddyData=(Join-Path $taskState 'caddy').Replace('\','/')
    $taskCaddyConfig=Join-Path $taskState 'Caddyfile'
@"
{
    admin 127.0.0.1:52019
    skip_install_trust
    auto_https disable_redirects
    default_sni $($taskLan.ip)
    storage file_system {
        root "$taskCaddyData"
    }
    pki {
        ca local {
            name "Concord LAN"
        }
    }
}
https://$($taskLan.ip):8443, https://localhost:8443 {
    bind 127.0.0.1 $($taskLan.ip)
    tls internal
    encode zstd gzip
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy same-origin
    }
    reverse_proxy 127.0.0.1:5173 {
        flush_interval -1
    }
}
"@ | Set-Content -LiteralPath $taskCaddyConfig -Encoding UTF8
    $taskCaddyExe=Join-Path $taskRuntime 'caddy\caddy.exe'
    & $taskCaddyExe validate --config $taskCaddyConfig --adapter caddyfile
    if($LASTEXITCODE -ne 0){throw 'Invalid LAN HTTPS configuration'}
    Start-LocalProcess 'caddy' $taskCaddyExe @('run','--config',('"'+$taskCaddyConfig+'"'),'--adapter','caddyfile') $taskState
    Wait-LocalPort 8443 'LAN HTTPS'
    $taskRootCert=Join-Path $taskState 'caddy\pki\authorities\local\root.crt'
    Copy-Item -LiteralPath $taskRootCert -Destination (Join-Path $taskRoot '..\outputs\Concord-LAN-root.crt') -Force
    "[InternetShortcut]`r`nURL=$taskUrl/`r`n" | Set-Content -LiteralPath (Join-Path $taskRoot '..\outputs\Concord-LAN.url') -Encoding ASCII
    $taskUrl | Set-Content -LiteralPath (Join-Path $taskRoot '..\outputs\LAN-address.txt') -Encoding ASCII
    Write-Host 'LAN HTTPS ready. Install outputs/Concord-LAN-root.crt on each client; enable the narrow LAN firewall rules.'
}
Write-Host "Concord: $taskUrl"
Write-Host 'Local mailbox: http://localhost:58025 (emails stay on this computer)'
Write-Host 'Demo login: alice@concord.local / demo12345 (also bob, carol, dave)'
if ($OpenBrowser) { Start-Process $taskUrl }
