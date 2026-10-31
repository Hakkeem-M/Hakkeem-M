<#
.SYNOPSIS
    ROLLBACK for Phase 1. Deletes every Intune policy whose name starts with the prefix.

.DESCRIPTION
    Lists matches first. Deletes only after you type YES (or pass -Force).
    Note: removing a policy does NOT decrypt BitLocker drives or roll back installed updates;
    it stops enforcing the settings.

.EXAMPLE
    .\Remove-Phase1SafePolicies.ps1 -TenantId <tenant-guid>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [string]$Prefix = 'P1-Safe',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$Beta = 'https://graph.microsoft.com/beta'
Import-Module Microsoft.Graph.Authentication
Connect-MgGraph -TenantId $TenantId -Scopes 'DeviceManagementConfiguration.ReadWrite.All' -NoWelcome

$targets = @()
foreach ($t in @(
        @{ Path = 'configurationPolicies';    Field = 'name' }
        @{ Path = 'deviceConfigurations';     Field = 'displayName' }
        @{ Path = 'deviceCompliancePolicies'; Field = 'displayName' }
    )) {
    $next = "$Beta/deviceManagement/$($t.Path)?`$select=id,$($t.Field)"
    while ($next) {
        $r = Invoke-MgGraphRequest -Method GET -Uri $next
        foreach ($p in $r.value) {
            if ($p[$t.Field] -like "$Prefix - *") {
                $targets += [pscustomobject]@{ Name = $p[$t.Field]; Path = $t.Path; Id = $p.id }
            }
        }
        $next = $r.'@odata.nextLink'
    }
}

if (-not $targets) { Write-Host "No policies found with prefix '$Prefix - '."; return }
$targets | Format-Table Name, Path, Id -AutoSize

if (-not $Force) {
    if ((Read-Host "Delete these $($targets.Count) policies? Type YES") -cne 'YES') { Write-Host 'Cancelled.'; return }
}
foreach ($t in $targets) {
    Invoke-MgGraphRequest -Method DELETE -Uri "$Beta/deviceManagement/$($t.Path)/$($t.Id)"
    Write-Host "Deleted: $($t.Name)" -ForegroundColor Yellow
}
