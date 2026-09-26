$ErrorActionPreference = 'Stop'
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$target = $current
if ($env:VOICE_SERVICE_USER) {
    if ($env:VOICE_SERVICE_USER -match '^S-1-') {
        $target = [System.Security.Principal.SecurityIdentifier]::new($env:VOICE_SERVICE_USER)
    } else {
        $target = [System.Security.Principal.NTAccount]::new($env:VOICE_SERVICE_USER).Translate(
            [System.Security.Principal.SecurityIdentifier])
    }
}
$userRoot = [Microsoft.Win32.Registry]::Users.OpenSubKey($target.Value)
if ($null -eq $userRoot) {
    throw 'Target account registry hive is not loaded. Sign in as the service account before configuring voice; no settings changed.'
}
function Read-VoiceRegistry {
    param($Root, [string]$SubKey)
    $result = @{}
    $key = $Root.OpenSubKey($SubKey)
    if ($null -ne $key) {
        try {
            foreach ($name in $key.GetValueNames()) {
                if ($name.StartsWith('VOICE_', [StringComparison]::OrdinalIgnoreCase)) {
                    $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                    if ($value -isnot [string]) { throw 'Voice registry override must be a string.' }
                    $result[$name] = $value
                }
            }
        } finally { $key.Dispose() }
    }
    return $result
}
try {
    $result = @{
        currentSid = $current.Value
        serviceSid = $target.Value
        machine = Read-VoiceRegistry ([Microsoft.Win32.Registry]::LocalMachine) 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
        user = Read-VoiceRegistry $userRoot 'Environment'
        volatile = Read-VoiceRegistry $userRoot 'Volatile Environment'
    }
    $null = [Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions')
    $serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::WriteLine($serializer.Serialize($result))
} finally { $userRoot.Dispose() }
