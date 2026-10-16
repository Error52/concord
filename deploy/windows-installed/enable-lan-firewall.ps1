param([switch]$Remove,[switch]$Check)
$ErrorActionPreference='Stop'
$taskData=Join-Path $PSScriptRoot 'local-data'
$taskLog=Join-Path $taskData 'lan-firewall.log'
try {
    $admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if(-not $Check -and -not $admin){throw 'Windows administrator approval is required for LAN firewall rules.'}
    $lan=Get-Content -LiteralPath (Join-Path $taskData 'lan.json') -Raw | ConvertFrom-Json
    $ip=[Net.IPAddress]::Parse($lan.ip)
    if($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $lan.ip -notmatch '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)'){throw 'Invalid private LAN address'}
    if($lan.prefix -lt 8 -or $lan.prefix -gt 30){throw 'Unsupported LAN subnet prefix'}
    $bytes=$ip.GetAddressBytes();$remaining=[int]$lan.prefix
    for($i=0;$i -lt 4;$i++){$bits=[Math]::Min(8,[Math]::Max(0,$remaining));$bytes[$i]=$bytes[$i] -band ((255 -shl (8-$bits)) -band 255);$remaining-=8}
    $subnet=([Net.IPAddress]::new($bytes)).ToString()+"/$($lan.prefix)"
    $tcpMedia=if($lan.mediaTcpPort){[int]$lan.mediaTcpPort}else{7881}
    $udpMedia=if($lan.mediaUdpPort){[int]$lan.mediaUdpPort}else{7882}
    if($tcpMedia -lt 1 -or $tcpMedia -gt 65535 -or $udpMedia -lt 1 -or $udpMedia -gt 65535){throw 'Invalid media port'}
    $rules=@(
        @{suffix='HTTPS';port=8443;protocol='TCP';exe='caddy\caddy.exe'},
        @{suffix='Media-TCP';port=$tcpMedia;protocol='TCP';exe='livekit-new\livekit-server.exe'},
        @{suffix='Media-UDP';port=$udpMedia;protocol='UDP';exe='livekit-new\livekit-server.exe'}
    )
    foreach($r in $rules){
        $name='Concord-LAN-01a117ec-'+$r.suffix
        if($Check){Write-Output "$name : $($r.protocol)/$($r.port), local $($lan.ip), remote $subnet, interface $($lan.interfaceAlias)";continue}
        Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        if(-not $Remove){
            $exe=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot ('runtime\'+$r.exe))).Path
            New-NetFirewallRule -Name $name -DisplayName $name -Direction Inbound -Action Allow -Protocol $r.protocol -LocalPort $r.port -LocalAddress $lan.ip -RemoteAddress $subnet -InterfaceAlias $lan.interfaceAlias -Program $exe -Profile Any | Out-Null
        }
    }
    if($Check){exit 0}
    $status=if($Remove){'Removed'}else{'Enabled'}
    "$status Concord LAN rules: $($lan.ip), $subnet, TCP 8443/$tcpMedia + UDP $udpMedia only." | Set-Content -LiteralPath $taskLog -Encoding UTF8
    exit 0
}catch{$_ | Out-String | Set-Content -LiteralPath $taskLog -Encoding UTF8;exit 1}
