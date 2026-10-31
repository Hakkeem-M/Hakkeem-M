<#
.SYNOPSIS
    Phase 1 - creates the LOW-RISK Intune baseline policies (Windows).

.DESCRIPTION
    Creates these policies through Microsoft Graph (beta):

      IN01  BitLocker silent encryption         (settings catalog)
      IN05  Microsoft Defender Antivirus        (settings catalog, PUA + network protection in AUDIT)
      N06   Windows Firewall - all profiles on  (settings catalog)
      N07   Attack surface reduction rules      (settings catalog, ALL rules in AUDIT mode only)
      IN09  Windows LAPS - backup to Entra ID   (settings catalog)
      N04   OneDrive Known Folder Move (silent) (settings catalog)
      N13   Windows Update ring                 (device configuration)
      N23   Windows compliance policy           (REPORT ONLY - do not link to Conditional Access yet)

    SAFETY:
      * Default mode is -Mode Validate: read-only. It checks every setting ID and value
        against your tenant's settings catalog and creates nothing.
      * -Mode Create creates the policies UNASSIGNED. Unassigned policies affect no device.
      * Policies are only assigned when you pass -PilotGroupId (an Entra group object ID).
      * Existing policies with the same name are not duplicated (safe to re-run);
        with -PilotGroupId they get the pilot assignment.
      * Rollback: Remove-Phase1SafePolicies.ps1 deletes everything with the name prefix.

.EXAMPLE
    .\Deploy-Phase1SafePolicies.ps1 -Mode Validate -TenantId <tenant-guid>
    .\Deploy-Phase1SafePolicies.ps1 -Mode Create   -TenantId <tenant-guid>
    .\Deploy-Phase1SafePolicies.ps1 -Mode Create   -TenantId <tenant-guid> -PilotGroupId <group-guid>
#>
[CmdletBinding()]
param(
    [ValidateSet('Validate', 'Create')]
    [string]$Mode = 'Validate',

    [Parameter(Mandatory)]
    [string]$TenantId,

    [string]$PilotGroupId,

    [string]$Prefix = 'P1-Safe',

    [switch]$SkipOneDriveKfm
)

$ErrorActionPreference = 'Stop'
$Beta = 'https://graph.microsoft.com/beta'

#region --- Connect ------------------------------------------------------------
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
    throw 'Install the Graph module first:  Install-Module Microsoft.Graph.Authentication -Scope CurrentUser'
}
Import-Module Microsoft.Graph.Authentication
$scopes = if ($Mode -eq 'Create') { 'DeviceManagementConfiguration.ReadWrite.All' } else { 'DeviceManagementConfiguration.Read.All' }
Connect-MgGraph -TenantId $TenantId -Scopes $scopes -NoWelcome
Write-Host "Connected as $((Get-MgContext).Account) | Mode: $Mode" -ForegroundColor Cyan
#endregion

#region --- Settings-catalog builders -----------------------------------------
function New-Choice {
    param([string]$Id, [string]$Value, [array]$Children = @())
    @{
        '@odata.type'      = '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance'
        settingDefinitionId = $Id
        choiceSettingValue = @{
            '@odata.type' = '#microsoft.graph.deviceManagementConfigurationChoiceSettingValue'
            value         = $Value
            children      = @($Children)
        }
    }
}
function New-StringSetting {
    param([string]$Id, [string]$Value)
    @{
        '@odata.type'       = '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance'
        settingDefinitionId = $Id
        simpleSettingValue  = @{
            '@odata.type' = '#microsoft.graph.deviceManagementConfigurationStringSettingValue'
            value         = $Value
        }
    }
}
function New-GroupCollection {
    param([string]$Id, [array]$Children)
    @{
        '@odata.type'               = '#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance'
        settingDefinitionId         = $Id
        groupSettingCollectionValue = @(@{ children = @($Children) })
    }
}
function ConvertTo-PolicySettings {
    param([array]$Instances)
    , @($Instances | ForEach-Object {
            @{ '@odata.type' = '#microsoft.graph.deviceManagementConfigurationSetting'; settingInstance = $_ }
        })
}
#endregion

#region --- Policy definitions ------------------------------------------------
$bl  = 'device_vendor_msft_bitlocker'
$def = 'device_vendor_msft_policy_config_defender'
$fw  = 'vendor_msft_firewall_mdmstore'
$asr = "${def}_attacksurfacereductionrules"
$od  = 'device_vendor_msft_policy_config_onedrivengscv2~policy~onedrivengsc'

# ASR rules - every rule set to AUDIT (logs only, blocks nothing)
$asrRules = @(
    'blockabuseofexploitedvulnerablesigneddrivers'
    'blockadobereaderfromcreatingchildprocesses'
    'blockallofficeapplicationsfromcreatingchildprocesses'
    'blockcredentialstealingfromwindowslocalsecurityauthoritysubsystem'
    'blockexecutablecontentfromemailclientandwebmail'
    'blockexecutionofpotentiallyobfuscatedscripts'
    'blockjavascriptorvbscriptfromlaunchingdownloadedexecutablecontent'
    'blockofficeapplicationsfromcreatingexecutablecontent'
    'blockofficeapplicationsfrominjectingcodeintootherprocesses'
    'blockofficecommunicationappfromcreatingchildprocesses'
    'blockpersistencethroughwmieventsubscription'
    'blockprocesscreationsfrompsexecandwmicommands'
    'blockuntrustedunsignedprocessesthatrunfromusb'
    'blockwin32apicallsfromofficemacros'
    'useadvancedprotectionagainstransomware'
) | ForEach-Object { New-Choice "${asr}_$_" "${asr}_${_}_audit" }

$catalogPolicies = [ordered]@{
    'IN01 BitLocker silent encryption' = @(
        New-Choice "${bl}_requiredeviceencryption"             "${bl}_requiredeviceencryption_1"
        New-Choice "${bl}_allowwarningforotherdiskencryption"  "${bl}_allowwarningforotherdiskencryption_0"
        New-Choice "${bl}_allowstandarduserencryption"         "${bl}_allowstandarduserencryption_1"
        New-Choice "${bl}_configurerecoverypasswordrotation"   "${bl}_configurerecoverypasswordrotation_1"
    )
    'IN05 Defender Antivirus' = @(
        New-Choice "${def}_allowrealtimemonitoring"  "${def}_allowrealtimemonitoring_1"
        New-Choice "${def}_allowbehaviormonitoring"  "${def}_allowbehaviormonitoring_1"
        New-Choice "${def}_allowcloudprotection"     "${def}_allowcloudprotection_1"
        New-Choice "${def}_allowioavprotection"      "${def}_allowioavprotection_1"
        New-Choice "${def}_allowscriptscanning"      "${def}_allowscriptscanning_1"
        New-Choice "${def}_submitsamplesconsent"     "${def}_submitsamplesconsent_1"   # send safe samples automatically
        New-Choice "${def}_puaprotection"            "${def}_puaprotection_2"          # 2 = audit
        New-Choice "${def}_enablenetworkprotection"  "${def}_enablenetworkprotection_2" # 2 = audit
    )
    'N06 Windows Firewall' = @(
        New-Choice "${fw}_domainprofile_enablefirewall"  "${fw}_domainprofile_enablefirewall_true"
        New-Choice "${fw}_privateprofile_enablefirewall" "${fw}_privateprofile_enablefirewall_true"
        New-Choice "${fw}_publicprofile_enablefirewall"  "${fw}_publicprofile_enablefirewall_true"
    )
    'N07 ASR rules AUDIT' = @(
        New-GroupCollection $asr $asrRules
    )
    'IN09 Windows LAPS' = @(
        New-Choice 'device_vendor_msft_laps_policies_backupdirectory' 'device_vendor_msft_laps_policies_backupdirectory_1' # 1 = Entra ID
    )
}
if (-not $SkipOneDriveKfm) {
    $catalogPolicies['N04 OneDrive Known Folder Move'] = @(
        New-Choice "${od}_silentaccountconfig" "${od}_silentaccountconfig_1"
        New-Choice "${od}_kfmsilentoptin" "${od}_kfmsilentoptin_1" @(
            New-StringSetting "${od}_kfmsilentoptin_kfmsilentoptin_textbox" $TenantId
        )
    )
}

$updateRing = @{
    '@odata.type'                       = '#microsoft.graph.windowsUpdateForBusinessConfiguration'
    displayName                         = "$Prefix - N13 Windows Update ring"
    description                         = 'Phase 1 safe baseline. Quality 3d deferral, feature 30d, 7d deadline, 2d grace.'
    microsoftUpdateServiceAllowed       = $true
    driversExcluded                     = $false
    qualityUpdatesDeferralPeriodInDays  = 3
    featureUpdatesDeferralPeriodInDays  = 30
    qualityUpdatesPaused                = $false
    featureUpdatesPaused                = $false
    businessReadyUpdatesOnly            = 'userDefined'
    automaticUpdateMode                 = 'autoInstallAtMaintenanceTime'
    installationSchedule                = @{
        '@odata.type'    = '#microsoft.graph.windowsUpdateActiveHoursInstall'
        activeHoursStart = '08:00:00.0000000'
        activeHoursEnd   = '18:00:00.0000000'
    }
    deadlineForQualityUpdatesInDays     = 7
    deadlineForFeatureUpdatesInDays     = 14
    deadlineGracePeriodInDays           = 2
    postponeRebootUntilAfterDeadline    = $false
    allowWindows11Upgrade               = $false
    skipChecksBeforeRestart             = $false
    userPauseAccess                     = 'enabled'
    userWindowsUpdateScanAccess         = 'enabled'
}

$compliance = @{
    '@odata.type'          = '#microsoft.graph.windows10CompliancePolicy'
    displayName            = "$Prefix - N23 Windows compliance (report only)"
    description            = 'Phase 1: REPORTING ONLY. Do not reference from Conditional Access until results are clean.'
    bitLockerEnabled       = $true
    secureBootEnabled      = $true
    codeIntegrityEnabled   = $true
    tpmRequired            = $true
    activeFirewallRequired = $true
    defenderEnabled        = $true
    rtpEnabled             = $true
    antivirusRequired      = $true
    antiSpywareRequired    = $true
    osMinimumVersion       = '10.0.19045'
    scheduledActionsForRule = @(@{
            ruleName                      = 'PasswordRequired'
            scheduledActionConfigurations = @(@{
                    actionType       = 'block'   # = mark non-compliant; no effect without Conditional Access
                    gracePeriodHours = 72
                })
        })
}
#endregion

#region --- Validation (read-only) --------------------------------------------
function Get-AllInstances {
    param($Instance)
    $Instance
    if ($Instance.choiceSettingValue) { $Instance.choiceSettingValue.children | ForEach-Object { Get-AllInstances $_ } }
    if ($Instance.groupSettingCollectionValue) {
        $Instance.groupSettingCollectionValue | ForEach-Object { $_.children | ForEach-Object { Get-AllInstances $_ } }
    }
}

$definitionCache = @{}
function Test-Instance {
    param($Instance)
    $id = $Instance.settingDefinitionId
    if (-not $definitionCache.ContainsKey($id)) {
        try { $definitionCache[$id] = Invoke-MgGraphRequest -Method GET -Uri "$Beta/deviceManagement/configurationSettings('$id')" }
        catch { $definitionCache[$id] = $null }
    }
    $d = $definitionCache[$id]
    if (-not $d) { return "MISSING setting: $id" }
    if ($Instance.choiceSettingValue) {
        $valid = @($d.options | ForEach-Object { $_.itemId })
        if ($valid -notcontains $Instance.choiceSettingValue.value) {
            return "BAD value '$($Instance.choiceSettingValue.value)' for $id. Valid: $($valid -join ', ')"
        }
    }
    return $null
}

$problems = 0
Write-Host "`n== Validating settings catalog IDs against tenant ==" -ForegroundColor Cyan
foreach ($name in $catalogPolicies.Keys) {
    $errs = @($catalogPolicies[$name] | ForEach-Object { Get-AllInstances $_ } | ForEach-Object { Test-Instance $_ } | Where-Object { $_ })
    if ($errs.Count) {
        $problems += $errs.Count
        Write-Host "  [FAIL] $name" -ForegroundColor Red
        $errs | ForEach-Object { Write-Host "         $_" -ForegroundColor Red }
    }
    else { Write-Host "  [ OK ] $name" -ForegroundColor Green }
}
if ($Mode -eq 'Validate') {
    Write-Host "`nValidate mode: nothing was created. Problems found: $problems" -ForegroundColor Yellow
    return
}
#endregion

#region --- Create -------------------------------------------------------------
$results = [System.Collections.Generic.List[object]]::new()

function Add-Assignment {
    param([string]$Uri)
    if (-not $PilotGroupId) { return 'unassigned' }
    $body = @{ assignments = @(@{ target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $PilotGroupId } }) }
    Invoke-MgGraphRequest -Method POST -Uri $Uri -Body ($body | ConvertTo-Json -Depth 10) -ContentType 'application/json' | Out-Null
    return "assigned to $PilotGroupId"
}
function Get-ExistingNames {
    # Returns hashtable: policy name -> policy id
    param([string]$Uri, [string]$Field)
    $map = @{}; $next = $Uri
    while ($next) {
        $r = Invoke-MgGraphRequest -Method GET -Uri $next
        foreach ($v in $r.value) { $map[$v[$Field]] = $v.id }
        $next = $r.'@odata.nextLink'
    }
    $map
}

Write-Host "`n== Creating policies ==" -ForegroundColor Cyan
$existingCatalog = Get-ExistingNames "$Beta/deviceManagement/configurationPolicies?`$select=id,name" 'name'

foreach ($short in $catalogPolicies.Keys) {
    $name = "$Prefix - $short"
    try {
        if ($existingCatalog.ContainsKey($name)) {
            $a = Add-Assignment "$Beta/deviceManagement/configurationPolicies/$($existingCatalog[$name])/assign"
            $results.Add([pscustomobject]@{ Policy = $name; Result = "EXISTS ($a)" }); continue
        }
        $body = @{
            name            = $name
            description     = 'Phase 1 safe baseline - created by Deploy-Phase1SafePolicies.ps1'
            platforms       = 'windows10'
            technologies    = 'mdm'
            roleScopeTagIds = @('0')
            settings        = (ConvertTo-PolicySettings $catalogPolicies[$short])
        }
        $p = Invoke-MgGraphRequest -Method POST -Uri "$Beta/deviceManagement/configurationPolicies" -Body ($body | ConvertTo-Json -Depth 30) -ContentType 'application/json'
        $a = Add-Assignment "$Beta/deviceManagement/configurationPolicies/$($p.id)/assign"
        $results.Add([pscustomobject]@{ Policy = $name; Result = "CREATED ($a)" })
    }
    catch { $results.Add([pscustomobject]@{ Policy = $name; Result = "ERROR: $($_.Exception.Message)" }) }
}

$existingConfig = Get-ExistingNames "$Beta/deviceManagement/deviceConfigurations?`$select=id,displayName" 'displayName'
$existingComp   = Get-ExistingNames "$Beta/deviceManagement/deviceCompliancePolicies?`$select=id,displayName" 'displayName'

foreach ($item in @(
        @{ Body = $updateRing; Path = 'deviceConfigurations'; Existing = $existingConfig }
        @{ Body = $compliance; Path = 'deviceCompliancePolicies'; Existing = $existingComp }
    )) {
    $name = $item.Body.displayName
    try {
        if ($item.Existing.ContainsKey($name)) {
            $a = Add-Assignment "$Beta/deviceManagement/$($item.Path)/$($item.Existing[$name])/assign"
            $results.Add([pscustomobject]@{ Policy = $name; Result = "EXISTS ($a)" }); continue
        }
        $p = Invoke-MgGraphRequest -Method POST -Uri "$Beta/deviceManagement/$($item.Path)" -Body ($item.Body | ConvertTo-Json -Depth 20) -ContentType 'application/json'
        $a = Add-Assignment "$Beta/deviceManagement/$($item.Path)/$($p.id)/assign"
        $results.Add([pscustomobject]@{ Policy = $name; Result = "CREATED ($a)" })
    }
    catch { $results.Add([pscustomobject]@{ Policy = $name; Result = "ERROR: $($_.Exception.Message)" }) }
}

$results | Format-Table -AutoSize
$log = Join-Path $PSScriptRoot ("phase1-result-{0:yyyyMMdd-HHmmss}.csv" -f (Get-Date))
$results | Export-Csv -Path $log -NoTypeInformation
Write-Host "Result log: $log" -ForegroundColor Cyan
#endregion
