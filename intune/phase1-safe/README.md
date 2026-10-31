# Intune Phase 1: safe policies

These are the lowest-risk items from the 27-policy checklist. Phase 1 blocks nothing a user does: the attack surface reduction (ASR) rules, PUA and network protection run in **audit** mode, and the compliance policy only **reports**.

| # | Policy | Mode in Phase 1 | Created by |
|---|---|---|---|
| IN01 | BitLocker silent encryption (key stored in Entra ID) | Enforced | Script |
| IN05 | Defender Antivirus (real-time, cloud, behaviour) | Enforced; PUA and network protection in **audit** | Script |
| N06 | Windows Firewall on (domain, private, public) | Enforced | Script |
| N07 | Attack surface reduction rules (15 rules) | **Audit only** | Script |
| IN09 | Windows LAPS, password stored in Entra ID | Enforced | Script |
| N04 | OneDrive Known Folder Move (silent) | Enforced | Script (`-SkipOneDriveKfm` leaves it out) |
| N13 | Windows Update ring (3d/30d deferral, 7d deadline) | Enforced | Script |
| N23 | Windows compliance policy | **Report only** (no Conditional Access) | Script |
| N17 | Edge SmartScreen | Enforced | Manual, step 6 |

**Left for later phases:** USB block, local admins / EPM, App Control, Credential Guard, expedite updates, feature-update pin, Conditional Access enforcement, Apple/Android, Wi-Fi certificates, Defender for Endpoint onboarding (check licences first).

## Before you run it

1. **Entra admin centre → Devices → Device settings → Enable Microsoft Entra LAPS = Yes → Save.** The LAPS policy needs this.
2. Create the Entra security group **`Intune-Pilot-P1`** with 5–10 IT and friendly users' **devices**. Copy its Object ID.
3. Check that none of the pilot devices runs third-party disk encryption (it conflicts with BitLocker).
4. On an admin PC, run this once:
   ```powershell
   Install-Module Microsoft.Graph.Authentication -Scope CurrentUser
   ```

## Run it

```powershell
cd .\intune\phase1-safe

# 1. Validate: read-only, creates nothing. Checks every setting ID and value against your tenant.
.\Deploy-Phase1SafePolicies.ps1 -Mode Validate -TenantId <tenant-id>

# 2. Create the policies UNASSIGNED (no device is affected). Review them in the portal.
.\Deploy-Phase1SafePolicies.ps1 -Mode Create -TenantId <tenant-id>

# 3. Assign to the pilot group (re-running does not create duplicates; it adds the assignment)
.\Deploy-Phase1SafePolicies.ps1 -Mode Create -TenantId <tenant-id> -PilotGroupId <group-object-id>
```

What to expect:
- Validate prints `[ OK ]` for every policy. If any line says `[FAIL]`, it names the invalid ID or value. Send it to me and I'll correct it.
- Create prints a table and saves `phase1-result-<date>.csv`.

## Step 6: Edge (manual, 2 minutes)

Intune → **Devices → Configuration → Create → Windows 10 and later → Settings catalog** → name it `P1-Safe - N17 Edge security` → **Add settings** → search **SmartScreen**:
- *Configure Microsoft Defender SmartScreen* = **Enabled**
- *Configure Microsoft Defender SmartScreen to block potentially unwanted apps* = **Enabled**

Assign the policy to `Intune-Pilot-P1`.

## Pilot checks (run for 1–2 weeks)

| Check | Where | Expected |
|---|---|---|
| Policies applied | Intune → Devices → *device* → Device configuration | All `Succeeded` |
| BitLocker key stored | Entra → Devices → *device* → BitLocker keys | Key is listed |
| LAPS password | Intune → Devices → *device* → Local admin password | Password is shown |
| ASR audit events | Defender portal → Reports → Attack surface reduction rules | Review which apps would be blocked |
| Compliance | Intune → Devices → Monitor → Device compliance | Fix non-compliant devices before any Conditional Access |

Once the pilot is clean, add `All Windows devices` (or a wider group) to each policy's assignments.

## Rollback

```powershell
.\Remove-Phase1SafePolicies.ps1 -TenantId <tenant-id>     # lists the policies, then asks you to type YES
```

Removing the policies stops enforcement. It does **not** decrypt BitLocker drives or uninstall updates that were already applied. To stop a single policy, remove its assignment in the portal.

## Status

The scripts were written but have **not yet been run against a tenant** (there was no PowerShell or tenant access when they were written). Always run `-Mode Validate` first.
