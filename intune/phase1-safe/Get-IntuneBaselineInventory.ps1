<#
.SYNOPSIS
    READ-ONLY inventory of existing Intune Windows policies, run BEFORE Phase 1.

.DESCRIPTION
    Makes no changes. Lists every settings-catalog policy, endpoint-security policy,
    device configuration (incl. update rings) and compliance policy with its assignments, then
    shows which Phase 1 areas are ALREADY configured, so Phase 1 does not create duplicate or
    conflicting settings.

    Output (next to the script):
      inventory-policies-<date>.csv      every policy + assignment targets
      inventory-phase1-overlap-<date>.csv Phase 1 area -> existing policies already setting it

.EXAMPLE
    .\Get-IntuneBaselineInventory.ps1 -TenantId <tenant-guid>
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$TenantId)

$ErrorActionPreference = 'Stop'
$Beta = 'https://graph.microsoft.com/beta'
Import-Module Microsoft.Graph.Authentication
Connect-MgGraph -TenantId $TenantId -Scopes 'DeviceManagementConfiguration.Read.All', 'Group.Read.All' -NoWelcome

function Get-All {
    param([string]$Uri)
    $out = @(); $next = $Uri
    while ($next) { $r = Invoke-MgGraphRequest -Method GET -Uri $next; $out += $r.value; $next = $r.'@odata.nextLink' }
    $out
}

$groupNames = @{}
function Get-TargetText {
    param($Assignments)
    if (-not $Assignments) { return 'UNASSIGNED' }
    ($Assignments | ForEach-Object {
            $t = $_.target
            $prefix = if ($t.'@odata.type' -like '*exclusion*') { 'EXCLUDE ' } else { '' }
            switch -Wildcard ($t.'@odata.type') {
                '*allDevicesAssignmentTarget'       { "${prefix}All devices" }
                '*allLicensedUsersAssignmentTarget' { "${prefix}All users" }
                default {
                    $g = $t.groupId
                    if ($g -and -not $groupNames.ContainsKey($g)) {
                        try { $groupNames[$g] = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/groups/$g`?`$select=displayName").displayName }
                        catch { $groupNames[$g] = $g }
                    }
                    "$prefix$($groupNames[$g])"
                }
            }
        }) -join '; '
}

# Phase 1 area -> keywords found in setting IDs / @odata.type
$areas = [ordered]@{
    'IN01 BitLocker'      = 'bitlocker'
    'IN05 Defender AV'    = 'defender_allowrealtimemonitoring|defender_allowcloudprotection|defender_puaprotection|antivirus'
    'N06 Firewall'        = 'firewall'
    'N07 ASR rules'       = 'attacksurfacereductionrules'
    'IN09 Windows LAPS'   = 'laps'
    'N04 OneDrive KFM'    = 'kfmsilentoptin|onedrivengsc'
    'N17 Edge SmartScreen'= 'microsoft_edge.*smartscreen'
    'N13 Update ring'     = 'windowsUpdateForBusinessConfiguration'
    'N23 Compliance'      = 'windows10CompliancePolicy'
}

$rows = [System.Collections.Generic.List[object]]::new()

Write-Host 'Reading settings catalog / endpoint security policies...' -ForegroundColor Cyan
foreach ($p in Get-All "$Beta/deviceManagement/configurationPolicies?`$select=id,name,platforms,technologies,templateReference&`$expand=assignments") {
    if ($p.platforms -notlike '*windows*') { continue }
    $ids = (Get-All "$Beta/deviceManagement/configurationPolicies/$($p.id)/settings" |
        ConvertTo-Json -Depth 50 -Compress)
    $rows.Add([pscustomobject]@{
            Type = if ($p.templateReference.templateFamily -and $p.templateReference.templateFamily -ne 'none') { "EndpointSecurity:$($p.templateReference.templateFamily)" } else { 'SettingsCatalog' }
            Name = $p.name; Id = $p.id; Assigned = Get-TargetText $p.assignments; Fingerprint = $ids.ToLower()
        })
}

Write-Host 'Reading device configuration profiles (incl. update rings)...' -ForegroundColor Cyan
foreach ($p in Get-All "$Beta/deviceManagement/deviceConfigurations?`$expand=assignments") {
    $rows.Add([pscustomobject]@{
            Type = $p.'@odata.type' -replace '#microsoft.graph.', ''
            Name = $p.displayName; Id = $p.id; Assigned = Get-TargetText $p.assignments
            Fingerprint = ($p | ConvertTo-Json -Depth 20 -Compress).ToLower()
        })
}

Write-Host 'Reading compliance policies...' -ForegroundColor Cyan
foreach ($p in Get-All "$Beta/deviceManagement/deviceCompliancePolicies?`$expand=assignments") {
    $rows.Add([pscustomobject]@{
            Type = $p.'@odata.type' -replace '#microsoft.graph.', ''
            Name = $p.displayName; Id = $p.id; Assigned = Get-TargetText $p.assignments
            Fingerprint = ($p | ConvertTo-Json -Depth 20 -Compress).ToLower()
        })
}

$overlap = foreach ($area in $areas.Keys) {
    $hits = @($rows | Where-Object { $_.Fingerprint -match $areas[$area].ToLower() })
    [pscustomobject]@{
        Phase1Area       = $area
        AlreadyConfigured = if ($hits) { 'YES' } else { 'no' }
        ExistingPolicies = ($hits | ForEach-Object { "$($_.Name) [$($_.Assigned)]" }) -join ' | '
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$rows | Select-Object Type, Name, Id, Assigned | Export-Csv (Join-Path $PSScriptRoot "inventory-policies-$stamp.csv") -NoTypeInformation
$overlap | Export-Csv (Join-Path $PSScriptRoot "inventory-phase1-overlap-$stamp.csv") -NoTypeInformation

Write-Host "`n== Existing Windows policies: $($rows.Count) ==" -ForegroundColor Cyan
$rows | Sort-Object Type, Name | Format-Table Type, Name, Assigned -AutoSize -Wrap
Write-Host '== Phase 1 overlap (YES = already set somewhere -> do NOT deploy that Phase 1 item; review/merge instead) ==' -ForegroundColor Yellow
$overlap | Format-Table -AutoSize -Wrap
Write-Host "CSV files saved in $PSScriptRoot" -ForegroundColor Cyan
