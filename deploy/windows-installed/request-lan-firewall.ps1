param([switch]$Remove)
$ErrorActionPreference='Stop'
try{
    $script=Join-Path $PSScriptRoot 'enable-lan-firewall.ps1'
    $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$script+'"'))
    if($Remove){$arguments+='-Remove'}
    $helper=Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -PassThru
    $helper.WaitForExit()
    exit $helper.ExitCode
}catch{Write-Error $_;exit 1}
