function Open-AgentsChatManagedTaskDefinition([hashtable]$Context) {
    $TaskName = $Context.TaskName
    $Project = $Context.Project
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or
        $TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$') { throw 'Unsupported managed task discovery.' }
    $Context.Files.Add([Deployment.WindowsPrivateFile]::OpenSourceDirectory($Project))
    $Context.Stage = 'task-action'
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $Context.Folder = $scheduler.GetFolder('\')
    $task = $Context.Folder.GetTask($TaskName)
    if ($task.Path -cne "\$TaskName" -or $task.Definition.Actions.Count -ne 1) { throw 'Ambiguous managed task action.' }
    $action = $task.Definition.Actions.Item(1)
    $arguments = [string]$action.Arguments
    if ([int]$action.Type -ne 0 -or -not [IO.Path]::IsPathRooted([string]$action.Path) -or
        ([string]$action.Path + $arguments + [string]$action.WorkingDirectory) -match '%|\$\(|[\x00\r\n]' -or
        $arguments -cnotmatch '^(-NoProfile -NonInteractive -File "([^"]+)" -Configuration "([^"]+)" -Sha256 ([a-f0-9]{64}))$') {
        throw 'Task is not a literal installed managed runtime.'
    }
    $hostFile = $Matches[2]
    $configuration = $Matches[3]
    $sha256 = $Matches[4]
    $bundle = [IO.Path]::GetDirectoryName($configuration)
    if ([IO.Path]::GetFileName($configuration) -cne 'configuration.json' -or
        $hostFile -cne (Join-Path $bundle 'windows-runtime-host.ps1') -or
        [string]$action.WorkingDirectory -cne $bundle) { throw 'Managed task does not use one installed bundle.' }
    $Context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($bundle))
    $Context.NativeDefinition = [string]$task.Xml
    $Context.SecurityDescriptor = [string]$task.GetSecurityDescriptor(7)
    $Context.Enabled = [bool]$task.Enabled
    $Context.Configuration = $configuration
    $Context.ConfigurationSha256 = $sha256
    return $task
}
