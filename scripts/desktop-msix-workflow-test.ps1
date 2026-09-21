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
$reportPath = Join-Path $run 'workflow-report.json'
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
  }

  public static class Native {
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TOKEN_QUERY = 0x0008;
    const int TokenElevation = 20;
    const int TokenIntegrityLevel = 25;
    const int ERROR_INSUFFICIENT_BUFFER = 122;

    [StructLayout(LayoutKind.Sequential)] struct TOKEN_ELEVATION { public int TokenIsElevated; }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int tokenClass, IntPtr information, int length, out int returnLength);
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

    public static uint StartDirect(string executable, string arguments) {
      var start = new ProcessStartInfo {
        FileName = executable,
        Arguments = arguments,
        WorkingDirectory = Path.GetDirectoryName(executable),
        UseShellExecute = false
      };
      var process = Process.Start(start);
      if (process == null) throw new InvalidOperationException("Direct packaged executable launch returned no process.");
      return (uint)process.Id;
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
          return new ProcessEvidence { ProcessId = processId, PackageFullName = package.ToString(),
            UserSid = identity.User.Value, Elevated = elevated, IntegrityRid = integrityRid };
        }
      } finally {
        if (token != IntPtr.Zero) CloseHandle(token);
        CloseHandle(process);
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
function Start-HydraApplication([string]$Arguments, [string]$Role) {
  $method = 'application-activation-manager'
  try {
    $processId = [HydraMsixFixture.Native]::Activate($applicationUserModelId, $Arguments)
  } catch {
    if ($_.Exception.ToString() -notmatch '0x80070520') { throw }
    $method = 'direct-installed-executable'
    $processId = [HydraMsixFixture.Native]::StartDirect((Join-Path $install 'Hydra.exe'), $Arguments)
  }
  $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop).CommandLine
  return [ordered]@{ launchMethod = $method; arguments = $Arguments; commandLine = $commandLine;
    process = (Assert-ProcessEvidence $processId $Role) }
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
$baseline = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$report = [ordered]@{ schemaVersion = 1; status = 'started'; phase = 'native-helper-compiled';
  updatedAtUtc = [DateTime]::UtcNow.ToString('o'); elapsedMilliseconds = $stopwatch.ElapsedMilliseconds;
  applicationUserModelId = $applicationUserModelId; checks = [ordered]@{} }
function Save-WorkflowReport {
  $report.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
  $report.elapsedMilliseconds = $stopwatch.ElapsedMilliseconds
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
Save-WorkflowReport

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
  $phaseOneLaunch = Start-HydraApplication $workflowArguments 'Phase 1 main process'
  $report.checks.phaseOneMain = $phaseOneLaunch
  $report.phase = 'waiting-phase-one-report'
  Save-WorkflowReport
  try {
    $phaseOne = Wait-ForJson $phaseOnePath 150
  } catch {
    if (Test-Path -LiteralPath $phaseOneProgressPath) {
      $report.checks.phaseOneProgress = Get-Content -LiteralPath $phaseOneProgressPath -Raw | ConvertFrom-Json
    }
    throw
  }
  if ($phaseOne.status -ne 'passed') { throw "Packaged workflow phase 1 failed: $($phaseOne.error)" }
  if ($phaseOne.appName -ne 'Hydra' -or $phaseOne.workspace -ne $workspace -or
      -not $phaseOne.extensionPath.StartsWith($extensions + '\', [StringComparison]::OrdinalIgnoreCase) -or
      -not $phaseOne.checks.editorSaved -or $phaseOne.checks.userSetting -ne 17 -or
      $phaseOne.checks.globalState -ne $nonce -or @($phaseOne.checks.protectedWrites).Count -ne 4) {
    throw 'Packaged workflow phase 1 identity, editor, setting, or extension state evidence changed.'
  }
  $report.checks.phaseOneExtensionHost = Assert-ProcessEvidence ([uint32]$phaseOne.extensionHostPid) 'Phase 1 extension host'
  $report.checks.phaseOne = $phaseOne
  $report.phase = 'waiting-phase-one-exit'
  Save-WorkflowReport
  Wait-ForHydraExit $baseline

  $report.phase = 'activating-phase-two'
  Save-WorkflowReport
  $configuration.phase = 2
  $configuration.reportPath = $phaseTwoPath
  $configuration.progressPath = $phaseTwoProgressPath
  $configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding utf8
  $phaseTwoLaunch = Start-HydraApplication $workflowArguments 'Phase 2 main process'
  $report.checks.phaseTwoMain = $phaseTwoLaunch
  $report.phase = 'waiting-phase-two-report'
  Save-WorkflowReport
  try {
    $phaseTwo = Wait-ForJson $phaseTwoPath 150
  } catch {
    if (Test-Path -LiteralPath $phaseTwoProgressPath) {
      $report.checks.phaseTwoProgress = Get-Content -LiteralPath $phaseTwoProgressPath -Raw | ConvertFrom-Json
    }
    throw
  }
  if ($phaseTwo.status -ne 'passed' -or -not $phaseTwo.checks.editorPersisted -or
      $phaseTwo.checks.userSetting -ne 17 -or $phaseTwo.checks.globalState -ne $nonce) {
    throw 'Packaged workflow restart did not preserve editor, setting, or extension state.'
  }
  if (-not $phaseTwo.checks.installedExtensionPath.StartsWith($extensions + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Workflow fixture did not activate from the isolated user extension directory.'
  }
  $report.checks.phaseTwoExtensionHost = Assert-ProcessEvidence ([uint32]$phaseTwo.extensionHostPid) 'Phase 2 extension host'
  $report.checks.phaseTwo = $phaseTwo
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
  Get-Process -Name Hydra -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $baseline } |
    Stop-Process -Force -ErrorAction Continue
  $report.cleanup = [ordered]@{ packagedProcessesAbsent = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -notin $baseline }).Count -eq 0 }
  Save-WorkflowReport
}
if ($report.status -ne 'passed' -or -not $report.cleanup.packagedProcessesAbsent) { throw 'Packaged MSIX workflow acceptance failed.' }
Write-Output 'PASS: packaged Hydra identity ran editor, terminal, extension, tool, protected-write, restart, and persistence workflows.'
