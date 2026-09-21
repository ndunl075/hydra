param(
  [Parameter(Mandatory = $true)][string]$PackageFullName,
  [Parameter(Mandatory = $true)][string]$PackageFamilyName,
  [Parameter(Mandatory = $true)][string]$InstallLocation,
  [Parameter(Mandatory = $true)][string]$RunDirectory,
  [switch]$ParentTokenControl
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'MSIX packaged workflow tests run only on disposable GitHub-hosted Windows runners.'
}
$repository = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
$run = (Resolve-Path -LiteralPath $RunDirectory).Path
$install = (Resolve-Path -LiteralPath $InstallLocation).Path
if (-not $run.StartsWith((Join-Path $repository '.test-build\msix-compatibility') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Workflow run directory is outside MSIX scratch.'
}
if (-not $install.StartsWith((Join-Path $env:ProgramFiles 'WindowsApps') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Workflow install location is outside WindowsApps.'
}
$reportName = if ($ParentTokenControl) { 'parent-token-control-report.json' } else { 'workflow-report.json' }
$reportPath = Join-Path $run $reportName
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
[ordered]@{ schemaVersion = 1; status = 'started'; phase = 'compiling-native-helper';
  updatedAtUtc = [DateTime]::UtcNow.ToString('o'); elapsedMilliseconds = $stopwatch.ElapsedMilliseconds } |
  ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding utf8

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace HydraMsixFixture {
  [Flags]
  public enum ActivateOptions : uint { None = 0 }

  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    [PreserveSig]
    int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments, ActivateOptions options, out uint processId);
    [PreserveSig]
    int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray,
      [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
    [PreserveSig]
    int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray,
      out uint processId);
  }

  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  class ApplicationActivationManager { }

  public sealed class ProcessEvidence {
    public uint ProcessId { get; set; }
    public string PackageFullName { get; set; }
    public string UserSid { get; set; }
    public bool Elevated { get; set; }
    public int IntegrityRid { get; set; }
    public string OwnerSid { get; set; }
    public string DefaultDaclSddl { get; set; }
    public bool IsAppContainer { get; set; }
    public string ProcessDaclSddl { get; set; }
    public string ProcessDaclError { get; set; }
    public string TokenSecurityError { get; set; }
  }
  public sealed class SelfAccessEvidence {
    public bool FullAccessReopen { get; set; }
    public int Win32Error { get; set; }
    public bool CrashpadAccessReopen { get; set; }
    public int CrashpadWin32Error { get; set; }
    public string OwnerSid { get; set; }
    public string DefaultDaclSddl { get; set; }
    public bool IsAppContainer { get; set; }
    public string ProcessDaclSddl { get; set; }
    public string ProcessDaclError { get; set; }
  }
  public sealed class ProcessObservation {
    public uint ProcessId { get; private set; }
    internal IntPtr Handle { get; private set; }
    internal ProcessObservation(uint processId, IntPtr handle) { ProcessId = processId; Handle = handle; }
    internal void Release() { Handle = IntPtr.Zero; }
  }

  public static class Native {
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint PROCESS_ALL_ACCESS = 0x001FFFFF;
    const uint CRASHPAD_PROCESS_ALL_ACCESS = 0x001F0FFF;
    const uint READ_CONTROL = 0x00020000;
    const uint SYNCHRONIZE = 0x00100000;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    const uint TOKEN_QUERY = 0x0008;
    const int TokenElevation = 20;
    const int TokenIntegrityLevel = 25;
    const int TokenOwner = 4;
    const int TokenDefaultDacl = 6;
    const int TokenIsAppContainer = 29;
    const int ERROR_INSUFFICIENT_BUFFER = 122;
    const int SE_KERNEL_OBJECT = 6;
    const uint DACL_SECURITY_INFORMATION = 0x00000004;

    [StructLayout(LayoutKind.Sequential)] struct TOKEN_ELEVATION { public int TokenIsElevated; }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_OWNER { public IntPtr Owner; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_DEFAULT_DACL { public IntPtr DefaultDacl; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(
      IntPtr process, out long creationTime, out long exitTime, out long kernelTime, out long userTime);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int tokenClass, IntPtr information, int length, out int returnLength);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthority);
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(IntPtr handle, int objectType,
      uint securityInformation, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl,
      out IntPtr securityDescriptor);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
      IntPtr securityDescriptor, uint requestedStringSDRevision, uint securityInformation,
      out IntPtr stringSecurityDescriptor, out uint stringSecurityDescriptorLen);

    static int ReadIntToken(IntPtr token, int tokenClass) {
      int returned;
      GetTokenInformation(token, tokenClass, IntPtr.Zero, 0, out returned);
      IntPtr buffer = Marshal.AllocHGlobal(returned);
      try {
        if (!GetTokenInformation(token, tokenClass, buffer, returned, out returned))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation class " + tokenClass + " failed.");
        return Marshal.ReadInt32(buffer);
      } finally { Marshal.FreeHGlobal(buffer); }
    }

    static string ReadTokenOwner(IntPtr token) {
      int returned;
      GetTokenInformation(token, TokenOwner, IntPtr.Zero, 0, out returned);
      IntPtr buffer = Marshal.AllocHGlobal(returned);
      try {
        if (!GetTokenInformation(token, TokenOwner, buffer, returned, out returned))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenOwner failed.");
        var owner = (TOKEN_OWNER)Marshal.PtrToStructure(buffer, typeof(TOKEN_OWNER));
        return new SecurityIdentifier(owner.Owner).Value;
      } finally { Marshal.FreeHGlobal(buffer); }
    }

    static string ReadTokenDefaultDacl(IntPtr token, string ownerSid) {
      int returned;
      GetTokenInformation(token, TokenDefaultDacl, IntPtr.Zero, 0, out returned);
      IntPtr buffer = Marshal.AllocHGlobal(returned);
      try {
        if (!GetTokenInformation(token, TokenDefaultDacl, buffer, returned, out returned))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenDefaultDacl failed.");
        var value = (TOKEN_DEFAULT_DACL)Marshal.PtrToStructure(buffer, typeof(TOKEN_DEFAULT_DACL));
        if (value.DefaultDacl == IntPtr.Zero) return "NO_ACCESS_CONTROL";
        int aclSize = unchecked((ushort)Marshal.ReadInt16(value.DefaultDacl, 2));
        var aclBytes = new byte[aclSize];
        Marshal.Copy(value.DefaultDacl, aclBytes, 0, aclSize);
        var acl = new RawAcl(aclBytes, 0);
        var descriptor = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent,
          new SecurityIdentifier(ownerSid), null, null, acl);
        return descriptor.GetSddlForm(AccessControlSections.Access);
      } finally { Marshal.FreeHGlobal(buffer); }
    }

    static string ReadProcessDacl(IntPtr process) {
      IntPtr owner, group, dacl, sacl, descriptor;
      uint result = GetSecurityInfo(process, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
        out owner, out group, out dacl, out sacl, out descriptor);
      if (result != 0) throw new Win32Exception(unchecked((int)result), "GetSecurityInfo process DACL failed.");
      try {
        IntPtr text;
        uint textLength;
        if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, DACL_SECURITY_INFORMATION,
            out text, out textLength))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Convert process DACL to SDDL failed.");
        try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
      } finally { LocalFree(descriptor); }
    }

    static void AddTokenSecurity(ProcessEvidence evidence, IntPtr token, uint processId) {
      evidence.OwnerSid = ReadTokenOwner(token);
      evidence.DefaultDaclSddl = ReadTokenDefaultDacl(token, evidence.OwnerSid);
      evidence.IsAppContainer = ReadIntToken(token, TokenIsAppContainer) != 0;
      IntPtr securityProcess = OpenProcess(READ_CONTROL | PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
      if (securityProcess == IntPtr.Zero) {
        evidence.ProcessDaclError = new Win32Exception(Marshal.GetLastWin32Error()).Message;
      } else {
        try {
          try { evidence.ProcessDaclSddl = ReadProcessDacl(securityProcess); }
          catch (Exception error) { evidence.ProcessDaclError = error.ToString(); }
        } finally { CloseHandle(securityProcess); }
      }
    }

    static ProcessObservation Observe(uint processId) {
      IntPtr handle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
      if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess observation failed.");
      return new ProcessObservation(processId, handle);
    }

    public static ProcessObservation ActivateObserved(string applicationUserModelId, string arguments) {
      var manager = (IApplicationActivationManager)new ApplicationActivationManager();
      uint processId;
      int result = manager.ActivateApplication(applicationUserModelId, arguments, ActivateOptions.None, out processId);
      if (result < 0) Marshal.ThrowExceptionForHR(result);
      if (processId == 0) throw new InvalidOperationException("Package activation returned no process ID.");
      return Observe(processId);
    }

    public static ProcessObservation StartDirectObserved(string executable, string arguments) {
      var start = new ProcessStartInfo {
        FileName = executable,
        Arguments = arguments,
        WorkingDirectory = Path.GetDirectoryName(executable),
        UseShellExecute = false
      };
      var process = Process.Start(start);
      if (process == null) throw new InvalidOperationException("Direct packaged executable launch returned no process.");
      try { return Observe((uint)process.Id); } finally { process.Dispose(); }
    }

    public static bool HasExited(ProcessObservation observation) {
      uint wait = WaitForSingleObject(observation.Handle, 0);
      if (wait == WAIT_OBJECT_0) return true;
      if (wait == WAIT_TIMEOUT) return false;
      throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject observation failed.");
    }

    public static int GetExitCode(ProcessObservation observation) {
      uint exitCode;
      if (!GetExitCodeProcess(observation.Handle, out exitCode))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess observation failed.");
      return unchecked((int)exitCode);
    }

    public static string GetExitTimeUtc(ProcessObservation observation) {
      long creationTime, exitTime, kernelTime, userTime;
      if (!GetProcessTimes(observation.Handle, out creationTime, out exitTime, out kernelTime, out userTime))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "GetProcessTimes observation failed.");
      return DateTime.FromFileTimeUtc(exitTime).ToString("o");
    }

    public static void CloseObservation(ProcessObservation observation) {
      if (observation == null || observation.Handle == IntPtr.Zero) return;
      IntPtr handle = observation.Handle;
      observation.Release();
      CloseHandle(handle);
    }

    public static ProcessEvidence Inspect(uint processId) {
      IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed.");
      IntPtr token = IntPtr.Zero;
      try {
        uint packageLength = 0;
        int packageResult = GetPackageFullName(process, ref packageLength, null);
        if (packageResult != ERROR_INSUFFICIENT_BUFFER) throw new Win32Exception(packageResult, "Process has no package identity.");
        var package = new StringBuilder((int)packageLength);
        packageResult = GetPackageFullName(process, ref packageLength, package);
        if (packageResult != 0) throw new Win32Exception(packageResult, "GetPackageFullName failed.");
        if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed.");

        int returned;
        IntPtr elevationBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_ELEVATION)));
        bool elevated;
        try {
          if (!GetTokenInformation(token, TokenElevation, elevationBuffer, Marshal.SizeOf(typeof(TOKEN_ELEVATION)), out returned))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenElevation failed.");
          elevated = ((TOKEN_ELEVATION)Marshal.PtrToStructure(elevationBuffer, typeof(TOKEN_ELEVATION))).TokenIsElevated != 0;
        } finally { Marshal.FreeHGlobal(elevationBuffer); }

        GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out returned);
        IntPtr integrityBuffer = Marshal.AllocHGlobal(returned);
        int integrityRid;
        try {
          if (!GetTokenInformation(token, TokenIntegrityLevel, integrityBuffer, returned, out returned))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenIntegrityLevel failed.");
          var label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(integrityBuffer, typeof(TOKEN_MANDATORY_LABEL));
          byte count = Marshal.ReadByte(GetSidSubAuthorityCount(label.Label.Sid));
          integrityRid = Marshal.ReadInt32(GetSidSubAuthority(label.Label.Sid, (uint)(count - 1)));
        } finally { Marshal.FreeHGlobal(integrityBuffer); }

        using (var identity = new WindowsIdentity(token)) {
          var evidence = new ProcessEvidence { ProcessId = processId, PackageFullName = package.ToString(),
            UserSid = identity.User.Value, Elevated = elevated, IntegrityRid = integrityRid };
          try { AddTokenSecurity(evidence, token, processId); }
          catch (Exception error) { evidence.TokenSecurityError = error.ToString(); }
          return evidence;
        }
      } finally {
        if (token != IntPtr.Zero) CloseHandle(token);
        CloseHandle(process);
      }
    }

    public static SelfAccessEvidence ProbeSelfAccess() {
      IntPtr current = GetCurrentProcess();
      IntPtr token;
      if (!OpenProcessToken(current, TOKEN_QUERY, out token))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Open current process token failed.");
      try {
        string ownerSid = ReadTokenOwner(token);
        var evidence = new SelfAccessEvidence { OwnerSid = ownerSid,
          DefaultDaclSddl = ReadTokenDefaultDacl(token, ownerSid),
          IsAppContainer = ReadIntToken(token, TokenIsAppContainer) != 0 };
        try { evidence.ProcessDaclSddl = ReadProcessDacl(current); }
        catch (Exception error) { evidence.ProcessDaclError = error.ToString(); }
        IntPtr reopened = OpenProcess(PROCESS_ALL_ACCESS, true, unchecked((uint)Process.GetCurrentProcess().Id));
        if (reopened == IntPtr.Zero) {
          evidence.FullAccessReopen = false;
          evidence.Win32Error = Marshal.GetLastWin32Error();
        } else {
          evidence.FullAccessReopen = true;
          CloseHandle(reopened);
        }
        reopened = OpenProcess(CRASHPAD_PROCESS_ALL_ACCESS, true, unchecked((uint)Process.GetCurrentProcess().Id));
        if (reopened == IntPtr.Zero) {
          evidence.CrashpadAccessReopen = false;
          evidence.CrashpadWin32Error = Marshal.GetLastWin32Error();
        } else {
          evidence.CrashpadAccessReopen = true;
          CloseHandle(reopened);
        }
        return evidence;
      } finally { CloseHandle(token); }
    }
  }
}
'@

function ConvertTo-WindowsArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
function Join-WindowsArguments([string[]]$Values) {
  return (($Values | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' ')
}
function Wait-ForJson([string]$Path, [int]$TimeoutSeconds = 90,
    [HydraMsixFixture.ProcessObservation]$ObservedProcess = $null) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (Test-Path -LiteralPath $Path) {
      try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { }
    }
    if ($ObservedProcess -and [HydraMsixFixture.Native]::HasExited($ObservedProcess)) {
      $exitCode = [HydraMsixFixture.Native]::GetExitCode($ObservedProcess)
      throw "Packaged Hydra process $($ObservedProcess.ProcessId) exited with code $exitCode before writing $Path."
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for workflow report: $Path"
}
function Wait-ForHydraExit([int[]]$Baseline, [int]$TimeoutSeconds = 45) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $remaining = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $Baseline })
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Packaged Hydra processes did not exit: $($remaining.Id -join ', ')"
}
function Get-HydraExitEvidence([HydraMsixFixture.ProcessObservation]$Observation) {
  $exitCode = [HydraMsixFixture.Native]::GetExitCode($Observation)
  $unsignedExitCode = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$exitCode), 0)
  return [ordered]@{ processId = $Observation.ProcessId; exitCode = $exitCode;
    exitCodeUnsigned = [uint64]$unsignedExitCode; exitCodeHex = ('0x{0:x8}' -f $unsignedExitCode);
    exitTimeUtc = [HydraMsixFixture.Native]::GetExitTimeUtc($Observation) }
}
function Assert-ProcessEvidence([uint32]$ProcessId, [string]$Role, [bool]$RequireMedium = $true) {
  $evidence = [HydraMsixFixture.Native]::Inspect($ProcessId)
  if ($evidence.PackageFullName -ne $PackageFullName) { throw "$Role package identity changed." }
  if ($evidence.UserSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw "$Role user SID changed." }
  if ($RequireMedium -and ($evidence.Elevated -or $evidence.IntegrityRid -lt 0x2000 -or $evidence.IntegrityRid -ge 0x3000)) {
    throw "$Role did not run as a non-elevated medium-integrity process."
  }
  $processPath = (Get-Process -Id $ProcessId -ErrorAction Stop).Path
  if ($processPath -ne (Join-Path $install 'Hydra.exe')) { throw "$Role executable path changed: $processPath" }
  $evidence | Add-Member -NotePropertyName ExecutablePath -NotePropertyValue $processPath
  return $evidence
}
function Start-HydraApplication([string]$Arguments, [string]$Role) {
  $method = 'application-activation-manager'
  try {
    $observation = [HydraMsixFixture.Native]::ActivateObserved($applicationUserModelId, $Arguments)
  } catch {
    if ($_.Exception.ToString() -notmatch '0x80070520') { throw }
    $method = 'direct-installed-executable'
    $observation = [HydraMsixFixture.Native]::StartDirectObserved((Join-Path $install 'Hydra.exe'), $Arguments)
  }
  return [pscustomobject]@{ launchMethod = $method; arguments = $Arguments; observation = $observation; role = $Role }
}
function Get-HydraApplicationEvidence($Activation, [bool]$RequireMedium = $true) {
  $processId = $Activation.observation.ProcessId
  $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop).CommandLine
  return [ordered]@{ launchMethod = $Activation.launchMethod; arguments = $Activation.arguments; commandLine = $commandLine;
    process = (Assert-ProcessEvidence $processId $Activation.role $RequireMedium) }
}
function Get-HydraProcessSnapshot([uint32]$TargetProcessId) {
  $snapshot = [ordered]@{ capturedAtUtc = [DateTime]::UtcNow.ToString('o'); processId = $TargetProcessId }
  try {
    $process = Get-Process -Id $TargetProcessId -ErrorAction Stop
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId" -ErrorAction Stop
    $snapshot.exited = $process.HasExited
    $snapshot.startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o')
    $snapshot.sessionId = $process.SessionId
    $snapshot.parentProcessId = [uint32]$cim.ParentProcessId
    try {
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($cim.ParentProcessId)" -ErrorAction Stop
      $snapshot.parent = [ordered]@{ processId = [uint32]$parent.ProcessId; name = $parent.Name;
        executablePath = $parent.ExecutablePath; commandLine = $parent.CommandLine; sessionId = [uint32]$parent.SessionId }
    } catch { $snapshot.parentError = $_.Exception.Message }
    $snapshot.commandLine = $cim.CommandLine
    $snapshot.handleCount = $process.HandleCount
    $snapshot.threadCount = $process.Threads.Count
    $snapshot.totalProcessorMilliseconds = [math]::Round($process.TotalProcessorTime.TotalMilliseconds, 3)
    $snapshot.workingSetBytes = $process.WorkingSet64
    $snapshot.privateMemoryBytes = $process.PrivateMemorySize64
    $snapshot.responding = $process.Responding
    $snapshot.mainWindowHandle = $process.MainWindowHandle.ToInt64()
    $snapshot.threads = @($process.Threads | ForEach-Object {
      $thread = $_
      $waitReason = $null
      if ($thread.ThreadState -eq [Diagnostics.ThreadState]::Wait) {
        try { $waitReason = $thread.WaitReason.ToString() } catch { $waitReason = 'unavailable' }
      }
      [ordered]@{ id = $thread.Id; state = $thread.ThreadState.ToString(); waitReason = $waitReason;
        startAddress = ('0x{0:x}' -f $thread.StartAddress.ToInt64()); totalProcessorMilliseconds = [math]::Round($thread.TotalProcessorTime.TotalMilliseconds, 3) }
    })
    try {
      $snapshot.modules = @($process.Modules | ForEach-Object { [ordered]@{ name = $_.ModuleName; path = $_.FileName } })
    } catch { $snapshot.moduleError = $_.Exception.Message }
    $snapshot.children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetProcessId" -ErrorAction Stop |
      ForEach-Object { [ordered]@{ processId = [uint32]$_.ProcessId; name = $_.Name; commandLine = $_.CommandLine } })
  } catch {
    $snapshot.captureError = $_.Exception.ToString()
  }
  return $snapshot
}
function Get-ActivationEvents([DateTime]$StartedAtUtc, [uint32]$TargetProcessId) {
  $events = [ordered]@{}
  $hexProcessId = '0x{0:x}' -f $TargetProcessId
  $executablePath = Join-Path $install 'Hydra.exe'
  foreach ($logName in @('Microsoft-Windows-AppModel-Runtime/Admin', 'Microsoft-Windows-TWinUI/Operational',
      'Microsoft-Windows-CodeIntegrity/Operational', 'Application')) {
    try {
      $matching = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $StartedAtUtc.ToLocalTime() } -ErrorAction Stop |
        Where-Object {
          $eventText = ([string]$_.Message) + "`n" + $_.ToXml()
          $eventText -match [regex]::Escape($PackageFullName) -or
          $eventText -match [regex]::Escape($PackageFamilyName) -or $eventText -match '(?i)Hydra\.exe' -or
          $eventText -match [regex]::Escape($executablePath) -or
          $eventText -match "(?<!\d)$TargetProcessId(?!\d)" -or $eventText -match "(?i)(?<![0-9a-f])$hexProcessId(?![0-9a-f])"
        } |
        Select-Object -First 50 | ForEach-Object { [ordered]@{ timeCreatedUtc = $_.TimeCreated.ToUniversalTime().ToString('o');
          id = $_.Id; level = $_.LevelDisplayName; provider = $_.ProviderName; message = $_.Message; eventXml = $_.ToXml() } })
      $events[$logName] = $matching
    } catch { $events[$logName] = [ordered]@{ captureError = $_.Exception.Message } }
  }
  return $events
}
function New-HydraProcessDump([uint32]$TargetProcessId, [string]$Label,
    [string]$ExpectedStartTimeUtc, [string]$ExpectedExecutablePath) {
  $process = $null
  try {
    $target = Get-Process -Id $TargetProcessId -ErrorAction Stop
    $actualStartTimeUtc = $target.StartTime.ToUniversalTime().ToString('o')
    if ($actualStartTimeUtc -ne $ExpectedStartTimeUtc -or
        -not [string]::Equals($target.Path, $ExpectedExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to dump reused or changed process ID $TargetProcessId."
    }
    $dumpPath = Join-Path $run ($Label + '-' + $TargetProcessId + '.dmp')
    $helper = Join-Path $repository 'scripts\desktop-msix-dump-process.ps1'
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command powershell.exe -ErrorAction Stop).Source
    $start.Arguments = Join-WindowsArguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', $helper, '-TargetProcessId', ([string]$TargetProcessId), '-DumpPath', $dumpPath)
    $start.WorkingDirectory = $repository
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Dump helper did not start.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) {
      $process.Kill()
      $process.WaitForExit()
      return [ordered]@{ status = 'timed-out'; processId = $TargetProcessId; timeoutMilliseconds = 30000 }
    }
    $stdout.Wait()
    $stderr.Wait()
    if ($process.ExitCode -ne 0) {
      return [ordered]@{ status = 'failed'; processId = $TargetProcessId; exitCode = $process.ExitCode;
        error = (($stdout.Result, $stderr.Result | Where-Object { $_ }) -join [Environment]::NewLine) }
    }
    return ($stdout.Result | ConvertFrom-Json)
  } catch {
    return [ordered]@{ status = 'failed'; processId = $TargetProcessId; error = $_.Exception.ToString() }
  } finally { if ($process) { $process.Dispose() } }
}

$applicationUserModelId = $PackageFamilyName + '!HydraProbe'
$unicodeSuffix = [string][char]0x00FC
$workflowRoot = Join-Path $run ('workflow spaces ' + $unicodeSuffix)
$workspace = Join-Path $workflowRoot ('workspace ' + $unicodeSuffix)
$userData = Join-Path $workflowRoot 'user data'
$extensions = Join-Path $workflowRoot 'extensions'
$fixture = Join-Path $repository 'tests\fixtures\msix-workflow-extension'
$provisionReportPath = Join-Path $run 'workflow-provision-report.json'
$phaseOnePath = Join-Path $workflowRoot 'phase-1.json'
$phaseOneProgressPath = Join-Path $workflowRoot 'phase-1-progress.json'
$phaseTwoPath = Join-Path $workflowRoot 'phase-2.json'
$phaseTwoProgressPath = Join-Path $workflowRoot 'phase-2-progress.json'
$electronLogPath = Join-Path $workflowRoot 'electron.log'
$phaseOneObservation = $null
$phaseTwoObservation = $null
$baseline = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$report = [ordered]@{ schemaVersion = 1; status = 'started'; phase = 'native-helper-compiled';
  updatedAtUtc = [DateTime]::UtcNow.ToString('o'); elapsedMilliseconds = $stopwatch.ElapsedMilliseconds;
  applicationUserModelId = $applicationUserModelId; checks = [ordered]@{} }
function Save-WorkflowReport {
  $report.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
  $report.elapsedMilliseconds = $stopwatch.ElapsedMilliseconds
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
try { $report.checks.callerSelfAccess = [HydraMsixFixture.Native]::ProbeSelfAccess() }
catch { $report.checks.callerSelfAccess = [ordered]@{ captureError = $_.Exception.ToString() } }
Save-WorkflowReport

if ($ParentTokenControl) {
  $controlRoot = Join-Path $run ('parent token control ' + $unicodeSuffix)
  $controlWorkspace = Join-Path $controlRoot ('workspace ' + $unicodeSuffix)
  $controlUserData = Join-Path $controlRoot 'user data'
  $controlExtensions = Join-Path $controlRoot 'extensions'
  $controlElectronLog = Join-Path $controlRoot 'electron.log'
  $controlObservation = $null
  $report.phase = 'activating-parent-token-control'
  try {
    New-Item -ItemType Directory -Path $controlWorkspace, $controlUserData, $controlExtensions -Force | Out-Null
    $controlArguments = Join-WindowsArguments @($controlWorkspace, '--new-window', '--user-data-dir', $controlUserData,
      '--extensions-dir', $controlExtensions, '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--log', 'trace', '--enable-logging=file', ('--log-file=' + $controlElectronLog))
    $controlStartedAtUtc = [DateTime]::UtcNow
    $controlActivation = Start-HydraApplication $controlArguments 'Parent-token control main process'
    $controlObservation = $controlActivation.observation
    $controlLaunch = Get-HydraApplicationEvidence $controlActivation $false
    $report.checks.parentTokenControlMain = $controlLaunch
    $report.checks.parentTokenControlStartupSnapshot = Get-HydraProcessSnapshot ([uint32]$controlObservation.ProcessId)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline -and -not [HydraMsixFixture.Native]::HasExited($controlObservation)) {
      Start-Sleep -Milliseconds 250
    }
    if ([HydraMsixFixture.Native]::HasExited($controlObservation)) {
      $report.checks.parentTokenControlExit = Get-HydraExitEvidence $controlObservation
      $report.status = 'diagnostic-complete'
      $report.outcome = 'exited-before-10s'
      $report.phase = 'parent-token-control-exited'
    } else {
      $report.checks.parentTokenControlTenSecondSnapshot = Get-HydraProcessSnapshot ([uint32]$controlObservation.ProcessId)
      $report.status = 'diagnostic-complete'
      $report.outcome = 'survived-10s'
      $report.phase = 'parent-token-control-survived-10s'
    }
    $report.checks.parentTokenControlEvents = Get-ActivationEvents $controlStartedAtUtc ([uint32]$controlObservation.ProcessId)
  } catch {
    $report.status = 'failed'
    $report.phase = 'parent-token-control-error'
    $report.error = $_.Exception.ToString()
  } finally {
    if ($controlObservation) { [HydraMsixFixture.Native]::CloseObservation($controlObservation) }
    Get-Process -Name Hydra -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $baseline } |
      Stop-Process -Force -ErrorAction Continue
    $report.cleanup = [ordered]@{ packagedProcessesAbsent = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue |
      Where-Object { $_.Id -notin $baseline }).Count -eq 0 }
    Save-WorkflowReport
  }
  Write-Output "Parent-token packaged control status: $($report.status)"
  exit 0
}

try {
  New-Item -ItemType Directory -Path $workspace, $userData, $extensions -Force | Out-Null
  $report.phase = 'validating-provisioned-extension'
  Save-WorkflowReport
  if (-not (Test-Path -LiteralPath $provisionReportPath)) { throw 'Workflow fixture provisioning evidence is missing.' }
  $provisionReport = Get-Content -LiteralPath $provisionReportPath -Raw | ConvertFrom-Json
  $installedProduct = Get-Content -LiteralPath (Join-Path $install 'resources\app\product.json') -Raw | ConvertFrom-Json
  if ($provisionReport.status -ne 'passed' -or $provisionReport.exitCode -ne 0 -or
      $provisionReport.hydraVersion -ne $installedProduct.hydraVersion -or
      $provisionReport.commit -ne $installedProduct.commit) {
    throw 'Workflow fixture provisioning evidence does not match the installed package runtime.'
  }
  $extensionPath = (Resolve-Path -LiteralPath ([string]$provisionReport.extensionPath)).Path
  if (-not $extensionPath.StartsWith($extensions + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Provisioned workflow fixture is outside the isolated extension directory.'
  }
  $installedFixture = @(Get-ChildItem -LiteralPath $extensions -Directory -ErrorAction SilentlyContinue |
    Where-Object Name -Like 'hydra-msix-workflow.hydra-msix-workflow-*')
  if ($installedFixture.Count -ne 1 -or $installedFixture[0].FullName -ne $extensionPath) {
    throw 'Provisioned workflow fixture directory evidence changed.'
  }
  $installedManifest = Join-Path $extensionPath 'package.json'
  $installedEntrypoint = Join-Path $extensionPath 'extension.cjs'
  $fixtureManifest = Join-Path $fixture 'package.json'
  $fixtureEntrypoint = Join-Path $fixture 'extension.cjs'
  $installedMetadata = Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json
  $fixtureMetadata = Get-Content -LiteralPath $fixtureManifest -Raw | ConvertFrom-Json
  if ($installedMetadata.publisher -ne 'hydra-msix-workflow' -or $installedMetadata.name -ne 'hydra-msix-workflow' -or
      $installedMetadata.version -ne '1.0.0') { throw 'Installed fixture extension identity changed.' }
  $installMetadata = $installedMetadata.__metadata
  if (-not $installMetadata) { throw 'Installed fixture extension lacks Code OSS install metadata.' }
  $installedMetadata.PSObject.Properties.Remove('__metadata')
  if (($installedMetadata | ConvertTo-Json -Depth 20 -Compress) -cne
      ($fixtureMetadata | ConvertTo-Json -Depth 20 -Compress)) {
    throw 'Installed fixture extension manifest changed beyond Code OSS install metadata.'
  }
  if ((Get-FileHash -LiteralPath $fixtureEntrypoint -Algorithm SHA256).Hash -ne
      (Get-FileHash -LiteralPath $installedEntrypoint -Algorithm SHA256).Hash) {
    throw 'Installed fixture extension entrypoint bytes changed.'
  }
  if ($provisionReport.publisher -ne $installedMetadata.publisher -or $provisionReport.name -ne $installedMetadata.name -or
      $provisionReport.version -ne $installedMetadata.version -or
      $provisionReport.sourceManifestSha256 -ne (Get-FileHash $fixtureManifest -Algorithm SHA256).Hash.ToLowerInvariant() -or
      $provisionReport.installedManifestSha256 -ne (Get-FileHash $installedManifest -Algorithm SHA256).Hash.ToLowerInvariant() -or
      $provisionReport.entrypointSha256 -ne (Get-FileHash $installedEntrypoint -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw 'Workflow fixture provisioning hashes or identity changed.'
  }
  $report.checks.userExtensionProvisioning = $provisionReport

  $report.phase = 'preparing-workflow'
  Save-WorkflowReport
  $editorFile = Join-Path $workspace 'editor result.txt'
  $terminalScript = Join-Path $workspace 'terminal fixture.ps1'
  $terminalOutput = Join-Path $workspace 'terminal-result.json'
  $fixtureCli = Join-Path $workspace 'fixture-cli.ps1'
  $cliOutput = Join-Path $workspace 'cli-result.txt'
  Set-Content -LiteralPath $editorFile -Value "before`n" -Encoding utf8
  Set-Content -LiteralPath $terminalScript -Value @'
param([string]$OutputPath, [string]$Nonce)
[ordered]@{ nonce = $Nonce; parentProcessId = $PID; shell = 'powershell.exe' } |
  ConvertTo-Json | Set-Content -LiteralPath $OutputPath -Encoding utf8
'@ -Encoding utf8
  Set-Content -LiteralPath $fixtureCli -Value @'
param([string]$OutputPath, [string]$Nonce)
Set-Content -LiteralPath $OutputPath -Value $Nonce -Encoding utf8
'@ -Encoding ascii

  $dll = Get-ChildItem -LiteralPath $install -Recurse -File -Filter '*.dll' |
    Sort-Object @{ Expression = { if ($_.Name -eq 'd3dcompiler_47.dll') { 0 } else { 1 } } }, FullName | Select-Object -First 1
  $nativeNode = Get-ChildItem -LiteralPath $install -Recurse -File -Filter '*.node' |
    Sort-Object @{ Expression = { if ($_.Name -match 'sqlite|pty') { 0 } else { 1 } } }, FullName | Select-Object -First 1
  if (-not $dll -or -not $nativeNode) { throw 'Installed package lacks a native DLL or .node module for write refusal.' }
  $targets = @(
    [ordered]@{ kind = 'native DLL'; path = $dll.FullName; sha256 = (Get-FileHash -LiteralPath $dll.FullName -Algorithm SHA256).Hash.ToLowerInvariant() },
    [ordered]@{ kind = 'native Node module'; path = $nativeNode.FullName; sha256 = (Get-FileHash -LiteralPath $nativeNode.FullName -Algorithm SHA256).Hash.ToLowerInvariant() },
    [ordered]@{ kind = 'Hydra executable'; path = (Join-Path $install 'Hydra.exe'); sha256 = (Get-FileHash -LiteralPath (Join-Path $install 'Hydra.exe') -Algorithm SHA256).Hash.ToLowerInvariant() },
    [ordered]@{ kind = 'built-in Hydra extension'; path = (Join-Path $install 'resources\app\extensions\hydra-agent-manager\dist\extension.cjs'); sha256 = (Get-FileHash -LiteralPath (Join-Path $install 'resources\app\extensions\hydra-agent-manager\dist\extension.cjs') -Algorithm SHA256).Hash.ToLowerInvariant() }
  )
  $nonce = [guid]::NewGuid().ToString('N')
  $configPath = Join-Path $workspace '.hydra-msix-workflow.json'
  $configuration = [ordered]@{ nonce = $nonce; phase = 1; reportPath = $phaseOnePath;
    progressPath = $phaseOneProgressPath; editorFile = $editorFile;
    terminalName = 'Hydra MSIX workflow terminal'; terminalScript = $terminalScript; terminalOutput = $terminalOutput;
    fixtureCli = $fixtureCli; cliOutput = $cliOutput; fontSize = 17; protectedTargets = $targets }
  $configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding utf8

  $report.phase = 'activating-phase-one'
  Save-WorkflowReport
  $electronLogArgument = '--log-file=' + $electronLogPath
  $workflowArguments = Join-WindowsArguments @($workspace, '--new-window', '--user-data-dir', $userData,
    '--extensions-dir', $extensions, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    '--log', 'trace', '--enable-logging=file', $electronLogArgument)
  $phaseOneStartedAtUtc = [DateTime]::UtcNow
  $phaseOneActivation = Start-HydraApplication $workflowArguments 'Phase 1 main process'
  $phaseOneObservation = $phaseOneActivation.observation
  try {
    $phaseOneLaunch = Get-HydraApplicationEvidence $phaseOneActivation
  } catch {
    if ([HydraMsixFixture.Native]::HasExited($phaseOneObservation)) {
      $report.checks.phaseOneExit = Get-HydraExitEvidence $phaseOneObservation
    }
    throw
  }
  $report.checks.phaseOneMain = $phaseOneLaunch
  $report.checks.phaseOneStartupSnapshot = Get-HydraProcessSnapshot ([uint32]$phaseOneLaunch.process.ProcessId)
  $report.phase = 'waiting-phase-one-report'
  Save-WorkflowReport
  try {
    $phaseOne = Wait-ForJson $phaseOnePath 150 $phaseOneObservation
  } catch {
    $phaseOneFailure = $_
    try {
      if ([HydraMsixFixture.Native]::HasExited($phaseOneObservation)) {
        $report.checks.phaseOneExit = Get-HydraExitEvidence $phaseOneObservation
        Start-Sleep -Seconds 2
      }
      if (Test-Path -LiteralPath $phaseOneProgressPath) {
        $report.checks.phaseOneProgress = Get-Content -LiteralPath $phaseOneProgressPath -Raw | ConvertFrom-Json
      }
      $phaseOneProcessId = [uint32]$phaseOneLaunch.process.ProcessId
      $report.checks.phaseOneTimeoutSnapshot = Get-HydraProcessSnapshot $phaseOneProcessId
      $report.checks.phaseOneSurvivingHydraProcesses = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue |
        Where-Object { $_.Id -notin $baseline } | ForEach-Object { Get-HydraProcessSnapshot ([uint32]$_.Id) })
      $report.checks.phaseOneActivationEvents = Get-ActivationEvents $phaseOneStartedAtUtc $phaseOneProcessId
      $dumpArguments = @{
        TargetProcessId = $phaseOneProcessId
        Label = 'phase-1-main'
        ExpectedStartTimeUtc = [string]$report.checks.phaseOneStartupSnapshot.startTimeUtc
        ExpectedExecutablePath = [string]$phaseOneLaunch.process.ExecutablePath
      }
      $report.checks.phaseOneDump = New-HydraProcessDump @dumpArguments
    } catch {
      $report.checks.phaseOneDiagnosticsError = $_.Exception.ToString()
    }
    try {
      Save-WorkflowReport
    } catch {
      Write-Warning "Failed to persist phase-one diagnostics: $($_.Exception.Message)"
    }
    throw $phaseOneFailure
  }
  $report.checks.phaseOne = $phaseOne
  Save-WorkflowReport
  if ($phaseOne.status -ne 'passed') { throw "Packaged workflow phase 1 failed: $($phaseOne.error)" }
  $phaseOneMismatches = @()
  if ($phaseOne.appName -ne 'Hydra') { $phaseOneMismatches += 'appName' }
  if ($phaseOne.workspace -ne $workspace) { $phaseOneMismatches += 'workspace' }
  if (-not $phaseOne.extensionPath.StartsWith($extensions + '\', [StringComparison]::OrdinalIgnoreCase)) {
    $phaseOneMismatches += 'extensionPath'
  }
  if (-not $phaseOne.checks.editorSaved) { $phaseOneMismatches += 'editorSaved' }
  if ($phaseOne.checks.userSetting -ne 17) { $phaseOneMismatches += 'userSetting' }
  if ($phaseOne.checks.globalState -ne $nonce) { $phaseOneMismatches += 'globalState' }
  if (@($phaseOne.checks.protectedWrites).Count -ne 4) { $phaseOneMismatches += 'protectedWrites' }
  if ($phaseOneMismatches.Count -ne 0) {
    throw "Packaged workflow phase 1 evidence changed: $($phaseOneMismatches -join ', ')."
  }
  $report.checks.phaseOneExtensionHost = Assert-ProcessEvidence ([uint32]$phaseOne.extensionHostPid) 'Phase 1 extension host'
  $report.phase = 'waiting-phase-one-exit'
  Save-WorkflowReport
  Wait-ForHydraExit $baseline

  $report.phase = 'activating-phase-two'
  Save-WorkflowReport
  $configuration.phase = 2
  $configuration.reportPath = $phaseTwoPath
  $configuration.progressPath = $phaseTwoProgressPath
  $configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding utf8
  $phaseTwoActivation = Start-HydraApplication $workflowArguments 'Phase 2 main process'
  $phaseTwoObservation = $phaseTwoActivation.observation
  try {
    $phaseTwoLaunch = Get-HydraApplicationEvidence $phaseTwoActivation
  } catch {
    if ([HydraMsixFixture.Native]::HasExited($phaseTwoObservation)) {
      $report.checks.phaseTwoExit = Get-HydraExitEvidence $phaseTwoObservation
    }
    throw
  }
  $report.checks.phaseTwoMain = $phaseTwoLaunch
  $report.phase = 'waiting-phase-two-report'
  Save-WorkflowReport
  try {
    $phaseTwo = Wait-ForJson $phaseTwoPath 150 $phaseTwoObservation
  } catch {
    $phaseTwoFailure = $_
    try {
      if ([HydraMsixFixture.Native]::HasExited($phaseTwoObservation)) {
        $report.checks.phaseTwoExit = Get-HydraExitEvidence $phaseTwoObservation
      }
      if (Test-Path -LiteralPath $phaseTwoProgressPath) {
        $report.checks.phaseTwoProgress = Get-Content -LiteralPath $phaseTwoProgressPath -Raw | ConvertFrom-Json
      }
    } catch {
      $report.checks.phaseTwoDiagnosticsError = $_.Exception.ToString()
    }
    try { Save-WorkflowReport } catch { Write-Warning "Failed to persist phase-two diagnostics: $($_.Exception.Message)" }
    throw $phaseTwoFailure
  }
  $report.checks.phaseTwo = $phaseTwo
  Save-WorkflowReport
  if ($phaseTwo.status -ne 'passed') { throw "Packaged workflow phase 2 failed: $($phaseTwo.error)" }
  $phaseTwoMismatches = @()
  if (-not $phaseTwo.checks.editorPersisted) { $phaseTwoMismatches += 'editorPersisted' }
  if ($phaseTwo.checks.userSetting -ne 17) { $phaseTwoMismatches += 'userSetting' }
  if ($phaseTwo.checks.globalState -ne $nonce) { $phaseTwoMismatches += 'globalState' }
  if ($phaseTwoMismatches.Count -ne 0) {
    throw "Packaged workflow restart evidence changed: $($phaseTwoMismatches -join ', ')."
  }
  if (-not $phaseTwo.checks.installedExtensionPath.StartsWith($extensions + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Workflow fixture did not activate from the isolated user extension directory.'
  }
  $report.checks.phaseTwoExtensionHost = Assert-ProcessEvidence ([uint32]$phaseTwo.extensionHostPid) 'Phase 2 extension host'
  $report.phase = 'waiting-phase-two-exit'
  Save-WorkflowReport
  Wait-ForHydraExit $baseline
  $report.phase = 'passed'
  $report.status = 'passed'
} catch {
  $report.status = 'failed'
  $report.error = $_.Exception.ToString()
  throw
} finally {
  if ($phaseOneObservation) { [HydraMsixFixture.Native]::CloseObservation($phaseOneObservation) }
  if ($phaseTwoObservation) { [HydraMsixFixture.Native]::CloseObservation($phaseTwoObservation) }
  Get-Process -Name Hydra -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $baseline } |
    Stop-Process -Force -ErrorAction Continue
  $report.cleanup = [ordered]@{ packagedProcessesAbsent = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -notin $baseline }).Count -eq 0 }
  Save-WorkflowReport
}
if ($report.status -ne 'passed' -or -not $report.cleanup.packagedProcessesAbsent) { throw 'Packaged MSIX workflow acceptance failed.' }
Write-Output 'PASS: packaged Hydra identity ran editor, terminal, extension, tool, protected-write, restart, and persistence workflows.'
