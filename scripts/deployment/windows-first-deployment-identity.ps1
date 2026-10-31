function Read-AgentsChatFirstDeploymentIdentity([string]$Text) {
    $fields = Read-AgentsChatMaintenanceFields $Text @('source', 'build', 'dependencies', 'config')
    $result = @{}
    foreach ($name in @('source', 'build', 'dependencies', 'config')) {
        $value = $fields[$name].GetString()
        $pattern = if ($name -ceq 'source') { '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' } else { '^[a-f0-9]{64}$' }
        if ($value -cnotmatch $pattern) { throw 'Invalid original first deployment identity.' }
        $result[$name] = $value
    }
    return $result
}
