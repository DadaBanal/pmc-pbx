# Sync-PbxPhoneUsers.ps1 - WS47. Runs on DND-SQL01 as SYSTEM every 5 minutes (task "PMC PBX Phone User Sync").
#
# Dada, 14 Oct 2026: "auto activate extensions on those once added to the group" / "auto upgrade extensions and
# activatiosn when added to the groups" / "make sure what your building does not fail and is secure".
#
# Reads the ENABLED user members (nested included) of the PBX phone groups from AD - as the computer account, so no
# account or password exists for this - and sends them to PMC-PBX01 over SSH with a key that can do nothing else.
# The PBX adds new members with a browser phone and switches off people who left both groups; it refuses to switch
# anyone off if this list arrives empty or would take more than half the active list.
#
#   .\Sync-PbxPhoneUsers.ps1            PREVIEW: what would change, nothing changed
#   .\Sync-PbxPhoneUsers.ps1 -Apply     sync (what the scheduled task runs)
#
# Key: C:\PMC\pbx-sync\pbx_sync_ed25519 (SYSTEM and Administrators only). On the PBX it is pinned in
# /var/lib/pmcsync/.ssh/authorized_keys with restrict, from="10.2.2.198" and a forced command
# (/usr/local/sbin/pmc-pbx-sync) that runs only "sync" or "preview".
# ROLLBACK, exact: Unregister-ScheduledTask -TaskName 'PMC PBX Phone User Sync' -Confirm:$false
#   and on the PBX: sudo rm /var/lib/pmcsync/.ssh/authorized_keys /etc/sudoers.d/pmc-pbx-sync
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$Dir = 'C:\PMC\pbx-sync'
$Log = Join-Path $Dir ('logs\sync-{0:yyyyMMdd}.log' -f (Get-Date))
function Write-Log($m) { ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $m) | Add-Content -Encoding UTF8 -Path $Log }
$Groups = @('PMO Team', 'PMC Phone System Users')

try {
    Import-Module ActiveDirectory
    $members = @{}
    foreach ($g in $Groups) {
        $grp = @(Get-ADGroup -LDAPFilter "(&(objectClass=group)(cn=$g))")
        if ($grp.Count -ne 1) { throw "group '$g' found $($grp.Count) times" }
        foreach ($m in (Get-ADGroupMember -Identity $grp[0] -Recursive | Where-Object objectClass -eq 'user')) {
            $u = Get-ADUser -Identity $m -Properties DisplayName, Enabled
            if (-not $u.Enabled) { continue }              # a disabled AD account gets no phone, and loses one
            $s = $u.SamAccountName.ToLower()
            if (-not $members.ContainsKey($s)) {
                $n = if ($u.DisplayName) { $u.DisplayName } else { $s }
                $members[$s] = [pscustomobject]@{ sam = $s; name = $n; group = $g }
            }
        }
    }
} catch {
    Write-Log ("AD read FAILED: " + $_.Exception.Message + " - nothing sent to the PBX")
    exit 2
}

$json = ConvertTo-Json -Compress -InputObject @($members.Values)
if ($members.Count -eq 0) { $json = '[]' }
# PowerShell 5.1 pipes to native programs as ASCII unless told otherwise: names with n-tilde would arrive mangled
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)   # no byte-order mark: 5.1 sent ef bb bf first (14 Oct 2026)
$mode = if ($Apply) { 'sync' } else { 'preview' }
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
# 5.1 turns a native program's stderr into a terminating error under 'Stop': every run must reach the log line
$ErrorActionPreference = 'Continue'
$out = $json | & $ssh -i (Join-Path $Dir 'pbx_sync_ed25519') -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 `
    -o StrictHostKeyChecking=yes -o ('UserKnownHostsFile=' + (Join-Path $Dir 'known_hosts')) pmcsync@10.2.0.10 $mode 2>&1
$code = $LASTEXITCODE
Write-Log ($mode + ' members=' + $members.Count + ' exit=' + $code + ' :: ' + (($out | ForEach-Object { "$_" }) -join ' / '))
Get-ChildItem (Join-Path $Dir 'logs') -Filter 'sync-*.log' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item -ErrorAction SilentlyContinue
if (-not $Apply) { $out }
exit $code
