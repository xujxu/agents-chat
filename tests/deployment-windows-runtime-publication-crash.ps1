param(
    [Parameter(Mandatory)][string]$Script,
    [Parameter(Mandatory)][string]$Configuration,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)][string]$Directory,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Runtime publisher fixture could not parse the original script.' }
$boundary = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
        $node.Left.VariablePath.UserPath -ceq 'copy' -and
        $node.Extent.Text -cmatch '^\$copy = \[Deployment\.WindowsPrivateFile\]::CopyTrustedSource\('
}, $true))
if ($boundary.Count -ne 2) { throw 'Runtime publisher fixture requires helper and configuration copy boundaries.' }
# Pause the unchanged publisher immediately after its first actual helper copy.
$null = Set-PSBreakpoint -Script $Script -Line ($boundary[0].Extent.EndLineNumber + 1) -Action {
    [Console]::Out.WriteLine((@{
        type='publication-held'; pid=$PID
        processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    while ($true) { Start-Sleep -Seconds 1 }
}
& $Script -Configuration $Configuration -Sha256 $Sha256 -Directory $Directory `
    -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
