param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$')][string]$TaskName,
    [Parameter(Mandatory)][ValidateSet('true', 'false')][string]$Enabled
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$task = $folder.GetTask($TaskName)
$security = [string]$task.GetSecurityDescriptor(7)
$task.Enabled = $Enabled -ceq 'true'
$task = $folder.GetTask($TaskName)
if ([bool]$task.Enabled -ne ($Enabled -ceq 'true') -or [string]$task.GetSecurityDescriptor(7) -cne $security) {
    throw 'Discovery policy fixture changed task security or failed to set enabled policy.'
}
