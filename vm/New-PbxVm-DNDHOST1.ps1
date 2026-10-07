<#
PMC - New-PbxVm-DNDHOST1-20261007.ps1
Create the PMC-PBX01 virtual machine on DND-HOST1 (Hyper-V, Windows Server, WORKGROUP host).

RUN THIS ON DND-HOST1, in an ELEVATED Windows PowerShell 5.1 window. Pure ASCII, self-contained,
ScreenConnect-paste friendly. Written 7 Oct 2026 for workstream WS47 (PMC's own IP PBX).

Two modes:
  1. PREVIEW (default)   .\New-PbxVm-DNDHOST1-20261007.ps1 -SwitchName '<vswitch>'
     Reads the host, lists the virtual switches, checks the ISO hash, prints the plan. Changes nothing.
  2. APPLY               .\New-PbxVm-DNDHOST1-20261007.ps1 -SwitchName '<vswitch>' -Apply
     Creates the VM exactly as previewed, then reads it back and prints what exists.

Design (docs/pbx-design-20261007.md): Generation 2, Secure Boot ON with the Microsoft UEFI Certificate
Authority template (the Linux template per Microsoft Learn), 2 vCPU, 4 GB STATIC memory (the host runs
static memory everywhere, measured 31 Aug 2026), 40 GB VHDX on S: (4.86 TB free on 1 Sep 2026), boot from
the Debian 12.15.0 netinst ISO whose SHA256 was read from cdimage.debian.org on 7 Oct 2026.

Before -Apply:
  - Download debian-12.15.0-amd64-netinst.iso to the path in -IsoPath (default S:\ISO\...). The script
    refuses to apply if the hash differs from the published one.
  - Run PREVIEW first. It prints the switch names; pass the one that carries the 10.2.0.0/22 network.
  - If the VM must sit on a tagged VLAN, pass -VlanId. Untagged (0) is the default and is the design.

Rollback (manual, documented here on purpose):
  Stop-VM -Name PMC-PBX01 -Force
  Remove-VM -Name PMC-PBX01 -Force
  Remove-Item -Recurse -Force 'S:\VMs\PMC-PBX01'
#>
[CmdletBinding()]
param(
    [string]$VmName     = 'PMC-PBX01',
    [string]$IsoPath    = 'S:\ISO\debian-12.15.0-amd64-netinst.iso',
    [string]$VmRoot     = 'S:\VMs',
    [string]$SwitchName = '',
    [int]   $VlanId     = 0,
    [int]   $CpuCount   = 2,
    [long]  $MemoryBytes = 4GB,
    [long]  $DiskBytes   = 40GB,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$expectedIsoSha256 = 'cd4462c06aa8892e692c0c4b9c17802f38c8ab8690e85cbfb5ccaa5956e9af17'
$secureBootTemplate = 'MicrosoftUEFICertificateAuthority'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$problems = New-Object System.Collections.Generic.List[string]

function Write-Section([string]$text) { Write-Host ''; Write-Host ('=== ' + $text + ' ===') }

Write-Host ('PMC-PBX01 VM build script, ' + $stamp + ', host ' + $env:COMPUTERNAME + ', mode ' + $(if ($Apply) { 'APPLY' } else { 'PREVIEW' }))

# ---- 0. Elevation and Hyper-V module -----------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) { $problems.Add('Not elevated. Hyper-V reads under-report and writes fail without elevation.') }

if (-not (Get-Command -Name New-VM -ErrorAction SilentlyContinue)) {
    $problems.Add('Hyper-V PowerShell module not present. Run this on DND-HOST1 itself, elevated.')
    Write-Host 'STOP:'; $problems | ForEach-Object { Write-Host ('  - ' + $_) }
    exit 2
}

# ---- 1. Host facts (read-only) -----------------------------------------------------------------
Write-Section 'Host'
$vmHost = Get-VMHost
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$freeRamGB  = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$totalRamGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
Write-Host ('Logical processors : ' + $vmHost.LogicalProcessorCount)
Write-Host ('RAM total / free   : ' + $totalRamGB + ' GB / ' + $freeRamGB + ' GB')
Write-Host ('Default VM path    : ' + $vmHost.VirtualMachinePath)
Write-Host ('Default VHD path   : ' + $vmHost.VirtualHardDiskPath)

$assignedGB = 0
Get-VM | ForEach-Object { $assignedGB += $_.MemoryStartup }
$assignedGB = [math]::Round($assignedGB / 1GB, 1)
Write-Host ('Memory assigned to existing VMs (startup): ' + $assignedGB + ' GB')

$neededGB = [math]::Round(($MemoryBytes / 1GB) + 2, 1)
if ($freeRamGB -lt $neededGB) {
    $problems.Add('Free RAM ' + $freeRamGB + ' GB is below the ' + $neededGB + ' GB needed (VM plus 2 GB margin).')
}

# ---- 2. Virtual switches -----------------------------------------------------------------------
Write-Section 'Virtual switches'
$switches = @(Get-VMSwitch)
foreach ($s in $switches) {
    Write-Host ('  ' + $s.Name + '  [' + $s.SwitchType + ']  ' + $s.NetAdapterInterfaceDescription)
}
if ([string]::IsNullOrWhiteSpace($SwitchName)) {
    $external = @($switches | Where-Object { $_.SwitchType -eq 'External' })
    if ($external.Count -eq 1) {
        $SwitchName = $external[0].Name
        Write-Host ('Only one External switch exists; using it: ' + $SwitchName)
    } else {
        $problems.Add('Pass -SwitchName. ' + $external.Count + ' External switches exist; the script will not guess.')
    }
} elseif (-not ($switches | Where-Object { $_.Name -eq $SwitchName })) {
    $problems.Add('Switch "' + $SwitchName + '" does not exist on this host. Names are listed above.')
}

# ---- 3. Name collision, paths, free space ------------------------------------------------------
Write-Section 'Target'
$existing = Get-VM -Name $VmName -ErrorAction SilentlyContinue
if ($existing) { $problems.Add('A VM named ' + $VmName + ' already exists (state ' + $existing.State + '). Nothing will be created over it.') }

$vmPath  = Join-Path $VmRoot $VmName
$vhdPath = Join-Path $vmPath ($VmName + '.vhdx')
if (Test-Path -LiteralPath $vhdPath) { $problems.Add('VHDX already exists: ' + $vhdPath) }

$driveLetter = (Split-Path -Qualifier $VmRoot)
$disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + $driveLetter + "'") -ErrorAction SilentlyContinue
if ($disk) {
    $freeDiskGB = [math]::Round($disk.FreeSpace / 1GB)
    Write-Host ('Free on ' + $driveLetter + ' : ' + $freeDiskGB + ' GB')
    if ($disk.FreeSpace -lt ($DiskBytes + 20GB)) { $problems.Add('Not enough free space on ' + $driveLetter + ' for a ' + ($DiskBytes/1GB) + ' GB disk plus margin.') }
} else {
    $problems.Add('Drive ' + $driveLetter + ' not found for -VmRoot ' + $VmRoot)
}
Write-Host ('VM folder  : ' + $vmPath)
Write-Host ('VHDX       : ' + $vhdPath + '  (' + ($DiskBytes/1GB) + ' GB, dynamic)')

# ---- 4. ISO presence and hash ------------------------------------------------------------------
Write-Section 'ISO'
if (-not (Test-Path -LiteralPath $IsoPath)) {
    $problems.Add('ISO not found at ' + $IsoPath + '. Download debian-12.15.0-amd64-netinst.iso there first.')
} else {
    $iso = Get-Item -LiteralPath $IsoPath
    Write-Host ('File : ' + $iso.FullName + '  ' + [math]::Round($iso.Length / 1MB) + ' MB')
    Write-Host 'Hashing (SHA256, takes a few seconds)...'
    $actual = (Get-FileHash -LiteralPath $IsoPath -Algorithm SHA256).Hash.ToLower()
    Write-Host ('SHA256 actual   : ' + $actual)
    Write-Host ('SHA256 expected : ' + $expectedIsoSha256 + '  (cdimage.debian.org SHA256SUMS, read 7 Oct 2026)')
    if ($actual -ne $expectedIsoSha256) { $problems.Add('ISO hash does NOT match the published Debian 12.15.0 netinst hash. Do not boot it.') }
    else { Write-Host 'Hash matches.' }
}

# ---- 5. Plan -----------------------------------------------------------------------------------
Write-Section 'Plan'
Write-Host ('New-VM ' + $VmName + ' Generation 2, ' + $CpuCount + ' vCPU, ' + ($MemoryBytes/1GB) + ' GB static, VHDX ' + ($DiskBytes/1GB) + ' GB')
Write-Host ('Switch ' + $SwitchName + '  VLAN ' + $(if ($VlanId -gt 0) { $VlanId } else { 'untagged' }))
Write-Host ('Secure Boot ON, template ' + $secureBootTemplate)
Write-Host ('DVD = ' + $IsoPath + ', first boot device')
Write-Host 'Automatic start: Start.  Automatic stop: ShutDown.  Checkpoints: Production.'

if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host ('STOP: ' + $problems.Count + ' problem(s). Nothing was changed.')
    $problems | ForEach-Object { Write-Host ('  - ' + $_) }
    exit 1
}

if (-not $Apply) {
    Write-Host ''
    Write-Host 'PREVIEW only. No change made. Re-run with -Apply to create the VM as planned above.'
    exit 0
}

# ---- 6. Apply ----------------------------------------------------------------------------------
Write-Section 'Apply'
New-Item -ItemType Directory -Path $vmPath -Force | Out-Null

$vm = New-VM -Name $VmName -Generation 2 -MemoryStartupBytes $MemoryBytes `
             -NewVHDPath $vhdPath -NewVHDSizeBytes $DiskBytes -SwitchName $SwitchName -Path $VmRoot
Write-Host ('Created VM ' + $vm.Name)

Set-VMProcessor -VMName $VmName -Count $CpuCount
Set-VMMemory    -VMName $VmName -DynamicMemoryEnabled $false -StartupBytes $MemoryBytes
Set-VMFirmware  -VMName $VmName -EnableSecureBoot On -SecureBootTemplate $secureBootTemplate
$dvd = Add-VMDvdDrive -VMName $VmName -Path $IsoPath -Passthru
Set-VMFirmware  -VMName $VmName -FirstBootDevice $dvd
if ($VlanId -gt 0) { Set-VMNetworkAdapterVlan -VMName $VmName -Access -VlanId $VlanId }
Set-VM -Name $VmName -AutomaticStartAction Start -AutomaticStopAction ShutDown -CheckpointType Production -Notes ('PMC PBX (Asterisk 22 LTS on Debian 12). WS47. Built ' + $stamp + ' by New-PbxVm-DNDHOST1-20261007.ps1')

Start-VM -Name $VmName
Write-Host 'VM started. Open its console in Hyper-V Manager and run the Debian installer (see the repo: vm/preseed.cfg and vm/README.md).'

# ---- 7. Read back ------------------------------------------------------------------------------
Write-Section 'Read back'
Get-VM -Name $VmName | Select-Object Name, State, Generation, ProcessorCount,
    @{n='MemoryGB';e={[math]::Round($_.MemoryStartup/1GB,1)}}, DynamicMemoryEnabled, Path | Format-List
Get-VMFirmware -VMName $VmName | Select-Object SecureBoot, SecureBootTemplate, @{n='FirstBoot';e={$_.BootOrder[0].BootType}} | Format-List
Get-VMNetworkAdapter -VMName $VmName | Select-Object Name, SwitchName, MacAddress | Format-List
Get-VMNetworkAdapterVlan -VMName $VmName | Select-Object OperationMode, AccessVlanId | Format-List
Get-VMHardDiskDrive -VMName $VmName | Select-Object Path | Format-List
Get-VMDvdDrive -VMName $VmName | Select-Object Path | Format-List
Write-Host 'Done. Paste this whole output into the session that asked for it.'
