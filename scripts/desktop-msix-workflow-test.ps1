param(
  [Parameter(Mandatory = $true)][string]$PackageFullName,
  [Parameter(Mandatory = $true)][string]$PackageFamilyName,
  [Parameter(Mandatory = $true)][string]$InstallLocation,
  [Parameter(Mandatory = $true)][string]$RunDirectory
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

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
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
    public uint SessionId { get; set; }
  }

  public sealed class HelperRunResult {
    public ProcessEvidence Evidence { get; set; }
    public int ExitCode { get; set; }
  }

  public static class Native {
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TOKEN_QUERY = 0x0008;
    const uint TOKEN_DUPLICATE = 0x0002;
    const int TokenElevation = 20;
    const int TokenLinkedToken = 19;
    const int TokenIntegrityLevel = 25;
    const int TokenSessionId = 12;
    const int ERROR_INSUFFICIENT_BUFFER = 122;
    const uint MAXIMUM_ALLOWED = 0x02000000;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;

    [StructLayout(LayoutKind.Sequential)] struct TOKEN_ELEVATION { public int TokenIsElevated; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_LINKED_TOKEN { public IntPtr LinkedToken; }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
      public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute;
      public uint dwFlags; public short wShowWindow; public short cbReserved2;
      public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
      public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int tokenClass, IntPtr information, int length, out int returnLength);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr existingToken, uint desiredAccess,
      IntPtr tokenAttributes, int impersonationLevel, int tokenType, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessWithTokenW(
      IntPtr token, uint logonFlags, string applicationName, StringBuilder commandLine, uint creationFlags,
      IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthority);

    public static uint Activate(string applicationUserModelId, string arguments) {
      var manager = (IApplicationActivationManager)new ApplicationActivationManager();
      uint processId;
      int result = manager.ActivateApplication(applicationUserModelId, arguments, ActivateOptions.None, out processId);
      if (result < 0) Marshal.ThrowExceptionForHR(result);
      if (processId == 0) throw new InvalidOperationException("Package activation returned no process ID.");
      return processId;
    }

    static ProcessEvidence InspectToken(IntPtr token, uint processId, string packageFullName) {
      int returned;
      IntPtr elevationBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_ELEVATION)));
      try {
        if (!GetTokenInformation(token, TokenElevation, elevationBuffer, Marshal.SizeOf(typeof(TOKEN_ELEVATION)), out returned))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenElevation failed.");
        bool elevated = ((TOKEN_ELEVATION)Marshal.PtrToStructure(elevationBuffer, typeof(TOKEN_ELEVATION))).TokenIsElevated != 0;
        GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out returned);
        IntPtr integrityBuffer = Marshal.AllocHGlobal(returned);
        try {
          if (!GetTokenInformation(token, TokenIntegrityLevel, integrityBuffer, returned, out returned))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenIntegrityLevel failed.");
          var label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(integrityBuffer, typeof(TOKEN_MANDATORY_LABEL));
          byte count = Marshal.ReadByte(GetSidSubAuthorityCount(label.Label.Sid));
          int integrityRid = Marshal.ReadInt32(GetSidSubAuthority(label.Label.Sid, (uint)(count - 1)));
          IntPtr sessionBuffer = Marshal.AllocHGlobal(sizeof(uint));
          uint sessionId;
          try {
            if (!GetTokenInformation(token, TokenSessionId, sessionBuffer, sizeof(uint), out returned))
              throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenSessionId failed.");
            sessionId = unchecked((uint)Marshal.ReadInt32(sessionBuffer));
          } finally { Marshal.FreeHGlobal(sessionBuffer); }
          using (var identity = new WindowsIdentity(token)) {
            return new ProcessEvidence { ProcessId = processId, PackageFullName = packageFullName,
              UserSid = identity.User.Value, Elevated = elevated, IntegrityRid = integrityRid, SessionId = sessionId };
          }
        } finally { Marshal.FreeHGlobal(integrityBuffer); }
      } finally { Marshal.FreeHGlobal(elevationBuffer); }
    }

    static ProcessEvidence InspectProcessToken(uint processId, string packageFullName) {
      IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed.");
      IntPtr token = IntPtr.Zero;
      try {
        if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed.");
        return InspectToken(token, processId, packageFullName);
      } finally {
        if (token != IntPtr.Zero) CloseHandle(token);
        CloseHandle(process);
      }
    }

    public static ProcessEvidence InspectCurrent() {
      IntPtr token;
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed.");
      try { return InspectToken(token, (uint)System.Diagnostics.Process.GetCurrentProcess().Id, null); }
      finally { CloseHandle(token); }
    }

    public static ProcessEvidence Inspect(uint processId) {
      IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed.");
      try {
        uint packageLength = 0;
        int packageResult = GetPackageFullName(process, ref packageLength, null);
        if (packageResult != ERROR_INSUFFICIENT_BUFFER) throw new Win32Exception(packageResult, "Process has no package identity.");
        var package = new StringBuilder((int)packageLength);
        packageResult = GetPackageFullName(process, ref packageLength, package);
        if (packageResult != 0) throw new Win32Exception(packageResult, "GetPackageFullName failed.");
        return InspectProcessToken(processId, package.ToString());
      } finally { CloseHandle(process); }
    }

    public static HelperRunResult RunMediumHelper(string executable, string commandLine, string currentDirectory) {
      IntPtr currentToken = IntPtr.Zero, linkedToken = IntPtr.Zero, primaryToken = IntPtr.Zero;
      PROCESS_INFORMATION created = new PROCESS_INFORMATION();
      bool finished = false;
      try {
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, out currentToken))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed.");
        int returned;
        IntPtr linkedBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_LINKED_TOKEN)));
        try {
          if (!GetTokenInformation(currentToken, TokenLinkedToken, linkedBuffer, Marshal.SizeOf(typeof(TOKEN_LINKED_TOKEN)), out returned))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The elevated runner has no linked medium token.");
          linkedToken = ((TOKEN_LINKED_TOKEN)Marshal.PtrToStructure(linkedBuffer, typeof(TOKEN_LINKED_TOKEN))).LinkedToken;
        } finally { Marshal.FreeHGlobal(linkedBuffer); }
        if (!DuplicateTokenEx(linkedToken, MAXIMUM_ALLOWED, IntPtr.Zero, 2, 1, out primaryToken))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx failed.");
        var selected = InspectToken(primaryToken, 0, null);
        var current = InspectToken(currentToken, 0, null);
        if (selected.UserSid != current.UserSid || selected.SessionId != current.SessionId || selected.Elevated ||
            selected.IntegrityRid < 0x2000 || selected.IntegrityRid >= 0x3000)
          throw new InvalidOperationException("Linked token is not the current user's non-elevated medium-integrity token.");

        var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        var mutableCommandLine = new StringBuilder(commandLine);
        uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
        if (!CreateProcessWithTokenW(primaryToken, 1, executable, mutableCommandLine, flags, IntPtr.Zero, currentDirectory, ref startup, out created))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessWithTokenW failed.");
        var evidence = InspectProcessToken(created.dwProcessId, null);
        if (evidence.UserSid != current.UserSid || evidence.SessionId != current.SessionId || evidence.Elevated ||
            evidence.IntegrityRid < 0x2000 || evidence.IntegrityRid >= 0x3000)
          throw new InvalidOperationException("Activation helper did not start with the selected medium token.");
        if (ResumeThread(created.hThread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed.");
        uint wait = WaitForSingleObject(created.hProcess, 60000);
        if (wait == WAIT_TIMEOUT) { TerminateProcess(created.hProcess, 124); throw new TimeoutException("Activation helper timed out."); }
        if (wait != WAIT_OBJECT_0) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed.");
        finished = true;
        uint exitCode;
        if (!GetExitCodeProcess(created.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed.");
        return new HelperRunResult { Evidence = evidence, ExitCode = unchecked((int)exitCode) };
      } finally {
        if (created.hProcess != IntPtr.Zero && !finished) TerminateProcess(created.hProcess, 125);
        if (created.hThread != IntPtr.Zero) CloseHandle(created.hThread);
        if (created.hProcess != IntPtr.Zero) CloseHandle(created.hProcess);
        if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
        if (linkedToken != IntPtr.Zero) CloseHandle(linkedToken);
        if (currentToken != IntPtr.Zero) CloseHandle(currentToken);
      }
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
function Wait-ForJson([string]$Path, [int]$TimeoutSeconds = 90) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (Test-Path -LiteralPath $Path) {
      try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for workflow report: $Path"
}
function Invoke-PackagedActivation([string]$ApplicationUserModelId, [string]$Arguments, [string]$Role,
    [string]$HelperPath, [string]$ScratchPath) {
  $current = [HydraMsixFixture.Native]::InspectCurrent()
  if (-not $current.Elevated -and $current.IntegrityRid -ge 0x2000 -and $current.IntegrityRid -lt 0x3000) {
    return [pscustomobject]@{
      ProcessId = [HydraMsixFixture.Native]::Activate($ApplicationUserModelId, $Arguments)
      Launcher = [ordered]@{ mode = 'current-medium-token'; process = $current }
    }
  }

  $nonce = [Guid]::NewGuid().ToString('N')
  $requestPath = Join-Path $ScratchPath "activation-$nonce-request.json"
  $resultPath = Join-Path $ScratchPath "activation-$nonce-result.json"
  [ordered]@{ nonce = $nonce; applicationUserModelId = $ApplicationUserModelId; arguments = $Arguments; resultPath = $resultPath } |
    ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding utf8
  $runtime = (Get-Process -Id $PID -ErrorAction Stop).Path
  $helperArguments = Join-WindowsArguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', $HelperPath, '-RequestPath', $requestPath)
  $commandLine = (ConvertTo-WindowsArgument $runtime) + ' ' + $helperArguments
  $helperRun = [HydraMsixFixture.Native]::RunMediumHelper($runtime, $commandLine, $ScratchPath)
  if ($helperRun.ExitCode -ne 0) { throw "$Role medium-integrity activation helper failed with exit code $($helperRun.ExitCode)." }
  $response = Wait-ForJson $resultPath 10
  if ($response.nonce -ne $nonce -or [uint32]$response.processId -eq 0) { throw "$Role activation helper returned invalid evidence." }
  return [pscustomobject]@{
    ProcessId = [uint32]$response.processId
    Launcher = [ordered]@{ mode = 'linked-medium-token'; process = $helperRun.Evidence }
  }
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
function Assert-ProcessEvidence([uint32]$ProcessId, [string]$Role) {
  $evidence = [HydraMsixFixture.Native]::Inspect($ProcessId)
  if ($evidence.PackageFullName -ne $PackageFullName) { throw "$Role package identity changed." }
  if ($evidence.UserSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw "$Role user SID changed." }
  if ($evidence.Elevated -or $evidence.IntegrityRid -lt 0x2000 -or $evidence.IntegrityRid -ge 0x3000) {
    throw "$Role did not run as a non-elevated medium-integrity process."
  }
  $processPath = (Get-Process -Id $ProcessId -ErrorAction Stop).Path
  if ($processPath -ne (Join-Path $install 'Hydra.exe')) { throw "$Role executable path changed: $processPath" }
  $evidence | Add-Member -NotePropertyName ExecutablePath -NotePropertyValue $processPath
  return $evidence
}

$applicationUserModelId = $PackageFamilyName + '!HydraProbe'
$unicodeSuffix = [string][char]0x00FC
$workflowRoot = Join-Path $run ('workflow spaces ' + $unicodeSuffix)
$workspace = Join-Path $workflowRoot ('workspace ' + $unicodeSuffix)
$userData = Join-Path $workflowRoot 'user data'
$extensions = Join-Path $workflowRoot 'extensions'
$fixture = Join-Path $repository 'tests\fixtures\msix-workflow-extension'
$bootstrap = Join-Path $repository 'tests\fixtures\msix-install-bootstrap'
$vsix = Join-Path $workflowRoot 'hydra-msix-workflow-1.0.0.vsix'
$reportPath = Join-Path $run 'workflow-report.json'
$bootstrapReportPath = Join-Path $workflowRoot 'bootstrap-report.json'
$phaseOnePath = Join-Path $workflowRoot 'phase-1.json'
$phaseTwoPath = Join-Path $workflowRoot 'phase-2.json'
$activationHelper = Join-Path $workflowRoot 'activate-package.ps1'
$baseline = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$report = [ordered]@{ schemaVersion = 1; status = 'started'; applicationUserModelId = $applicationUserModelId; checks = [ordered]@{} }

try {
  New-Item -ItemType Directory -Path $workspace, $userData, $extensions -Force | Out-Null
  Set-Content -LiteralPath $activationHelper -Encoding utf8 -Value @'
param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace HydraMsixActivationHelper {
  [Flags] public enum ActivateOptions : uint { None = 0 }
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments, ActivateOptions options, out uint processId);
    [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray,
      [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
    [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray,
      out uint processId);
  }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] class ApplicationActivationManager { }
  public static class Native {
    public static uint Activate(string applicationUserModelId, string arguments) {
      var manager = (IApplicationActivationManager)new ApplicationActivationManager();
      uint processId;
      int result = manager.ActivateApplication(applicationUserModelId, arguments, ActivateOptions.None, out processId);
      if (result < 0) Marshal.ThrowExceptionForHR(result);
      if (processId == 0) throw new InvalidOperationException("Package activation returned no process ID.");
      return processId;
    }
  }
}
"@
$activatedPid = [HydraMsixActivationHelper.Native]::Activate(
  [string]$request.applicationUserModelId, [string]$request.arguments)
[ordered]@{ nonce = [string]$request.nonce; processId = $activatedPid } |
  ConvertTo-Json | Set-Content -LiteralPath ([string]$request.resultPath) -Encoding utf8
'@
  Push-Location $fixture
  try {
    & (Join-Path $repository 'node_modules\.bin\vsce.cmd') package --no-dependencies --allow-missing-repository --out $vsix
    if ($LASTEXITCODE -ne 0) { throw 'Offline workflow fixture VSIX packaging failed.' }
  } finally { Pop-Location }
  if (-not (Test-Path -LiteralPath $vsix)) { throw 'Workflow fixture VSIX is missing.' }

  [ordered]@{ vsix = $vsix; reportPath = $bootstrapReportPath;
    targetExtensionId = 'hydra-msix-workflow.hydra-msix-workflow' } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $workspace '.hydra-msix-bootstrap.json') -Encoding utf8
  $installArguments = Join-WindowsArguments @($workspace, '--new-window', '--user-data-dir', $userData,
    '--extensions-dir', $extensions, '--extensionDevelopmentPath', $bootstrap,
    '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust')
  $installActivation = Invoke-PackagedActivation $applicationUserModelId $installArguments 'VSIX install process' $activationHelper $workflowRoot
  $installPid = $installActivation.ProcessId
  $report.checks.installLauncher = $installActivation.Launcher
  $report.checks.installProcess = Assert-ProcessEvidence $installPid 'VSIX install process'
  $bootstrapReport = Wait-ForJson $bootstrapReportPath
  if ($bootstrapReport.status -ne 'passed' -or
      $bootstrapReport.command -ne 'workbench.extensions.installExtension' -or
      $bootstrapReport.targetExtensionId -ne 'hydra-msix-workflow.hydra-msix-workflow') {
    throw "Packaged Hydra extension bootstrap failed: $($bootstrapReport.error)"
  }
  $report.checks.installExtensionHost = Assert-ProcessEvidence ([uint32]$bootstrapReport.extensionHostPid) 'VSIX install extension host'
  $extensionDeadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    $installedFixture = @(Get-ChildItem -LiteralPath $extensions -Directory -ErrorAction SilentlyContinue |
      Where-Object Name -Like 'hydra-msix-workflow.hydra-msix-workflow-*')
    if ($installedFixture.Count -eq 1) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $extensionDeadline)
  if ($installedFixture.Count -ne 1) { throw 'Packaged Hydra did not install the offline fixture VSIX.' }
  Wait-ForHydraExit $baseline
  $report.checks.userExtensionInstall = [ordered]@{ path = $installedFixture[0].FullName; bootstrap = $bootstrapReport }

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
  $configuration = [ordered]@{ nonce = $nonce; phase = 1; reportPath = $phaseOnePath; editorFile = $editorFile;
    terminalName = 'Hydra MSIX workflow terminal'; terminalScript = $terminalScript; terminalOutput = $terminalOutput;
    fixtureCli = $fixtureCli; cliOutput = $cliOutput; fontSize = 17; protectedTargets = $targets }
  $configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding utf8

  $workflowArguments = Join-WindowsArguments @($workspace, '--new-window', '--user-data-dir', $userData,
    '--extensions-dir', $extensions, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust')
  $phaseOneActivation = Invoke-PackagedActivation $applicationUserModelId $workflowArguments 'Workflow phase 1' $activationHelper $workflowRoot
  $phaseOnePid = $phaseOneActivation.ProcessId
  $report.checks.phaseOneLauncher = $phaseOneActivation.Launcher
  $phaseOne = Wait-ForJson $phaseOnePath
  if ($phaseOne.status -ne 'passed') { throw "Packaged workflow phase 1 failed: $($phaseOne.error)" }
  if ($phaseOne.appName -ne 'Hydra' -or $phaseOne.workspace -ne $workspace -or
      -not $phaseOne.extensionPath.StartsWith($extensions + '\', [StringComparison]::OrdinalIgnoreCase) -or
      -not $phaseOne.checks.editorSaved -or $phaseOne.checks.userSetting -ne 17 -or
      $phaseOne.checks.globalState -ne $nonce -or @($phaseOne.checks.protectedWrites).Count -ne 4) {
    throw 'Packaged workflow phase 1 identity, editor, setting, or extension state evidence changed.'
  }
  $report.checks.phaseOneMain = Assert-ProcessEvidence $phaseOnePid 'Phase 1 main process'
  $report.checks.phaseOneExtensionHost = Assert-ProcessEvidence ([uint32]$phaseOne.extensionHostPid) 'Phase 1 extension host'
  $report.checks.phaseOne = $phaseOne
  Wait-ForHydraExit $baseline

  $configuration.phase = 2
  $configuration.reportPath = $phaseTwoPath
  $configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding utf8
  $phaseTwoActivation = Invoke-PackagedActivation $applicationUserModelId $workflowArguments 'Workflow phase 2' $activationHelper $workflowRoot
  $phaseTwoPid = $phaseTwoActivation.ProcessId
  $report.checks.phaseTwoLauncher = $phaseTwoActivation.Launcher
  $phaseTwo = Wait-ForJson $phaseTwoPath
  if ($phaseTwo.status -ne 'passed' -or -not $phaseTwo.checks.editorPersisted -or
      $phaseTwo.checks.userSetting -ne 17 -or $phaseTwo.checks.globalState -ne $nonce) {
    throw 'Packaged workflow restart did not preserve editor, setting, or extension state.'
  }
  if (-not $phaseTwo.checks.installedExtensionPath.StartsWith($extensions + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Workflow fixture did not activate from the isolated user extension directory.'
  }
  $report.checks.phaseTwoMain = Assert-ProcessEvidence $phaseTwoPid 'Phase 2 main process'
  $report.checks.phaseTwoExtensionHost = Assert-ProcessEvidence ([uint32]$phaseTwo.extensionHostPid) 'Phase 2 extension host'
  $report.checks.phaseTwo = $phaseTwo
  Wait-ForHydraExit $baseline
  $report.status = 'passed'
} finally {
  Get-Process -Name Hydra -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $baseline } |
    Stop-Process -Force -ErrorAction Continue
  $report.cleanup = [ordered]@{ packagedProcessesAbsent = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -notin $baseline }).Count -eq 0 }
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
if ($report.status -ne 'passed' -or -not $report.cleanup.packagedProcessesAbsent) { throw 'Packaged MSIX workflow acceptance failed.' }
Write-Output 'PASS: packaged Hydra identity ran editor, terminal, extension, tool, protected-write, restart, and persistence workflows.'
