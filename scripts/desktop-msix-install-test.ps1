param([Parameter(Mandatory = $true)][string]$BuiltAppPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Package trust is machine-wide. Run this only on the disposable Windows host
# whose entire lifetime is controlled by the desktop acceptance workflow.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'MSIX installation tests run only on disposable GitHub-hosted Windows runners.'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace HydraMsixStandardUserController {
  public sealed class TokenEvidence {
    public string UserSid { get; set; }
    public bool Elevated { get; set; }
    public int IntegrityRid { get; set; }
    public bool Administrator { get; set; }
  }
  public sealed class ProcessResult {
    public uint ProcessId { get; set; }
    public int ExitCode { get; set; }
    public uint ResumeCount { get; set; }
    public TokenEvidence Token { get; set; }
  }
  sealed class UserObjectGrant {
    public IntPtr Handle; public IntPtr OldDacl; public IntPtr SecurityDescriptor;
    public IntPtr NewDacl; public IntPtr Sid;
  }
  public static class Native {
    const uint TOKEN_QUERY = 0x0008;
    const int TokenUser = 1;
    const int TokenGroups = 2;
    const int TokenElevation = 20;
    const int TokenIntegrityLevel = 25;
    const uint SE_GROUP_ENABLED = 0x00000004;
    const uint SE_GROUP_USE_FOR_DENY_ONLY = 0x00000010;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_NEW_CONSOLE = 0x00000010;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint STARTF_USESHOWWINDOW = 0x00000001;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    const int SE_WINDOW_OBJECT = 7;
    const uint DACL_SECURITY_INFORMATION = 0x00000004;
    const int GRANT_ACCESS = 1;
    const int TRUSTEE_IS_SID = 0;
    const int TRUSTEE_IS_USER = 1;
    const uint WINSTA_ALL_ACCESS = 0x0000037F;
    const uint DESKTOP_ALL_ACCESS = 0x000001FF;
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_ELEVATION { public int TokenIsElevated; }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_GROUPS { public uint GroupCount; public SID_AND_ATTRIBUTES Groups; }
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
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct TRUSTEE {
      public IntPtr pMultipleTrustee; public int MultipleTrusteeOperation; public int TrusteeForm;
      public int TrusteeType; public IntPtr ptstrName;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct EXPLICIT_ACCESS {
      public uint grfAccessPermissions; public int grfAccessMode; public uint grfInheritance; public TRUSTEE Trustee;
    }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LogonUserW(
      string username, string domain, string password, int logonType, int logonProvider, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessWithLogonW(
      string username, string domain, string password, uint logonFlags, string applicationName, StringBuilder commandLine,
      uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
      out PROCESS_INFORMATION processInformation);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int tokenClass, IntPtr information, int length, out int returnLength);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthority);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(IntPtr handle, int objectType,
      uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint SetSecurityInfo(IntPtr handle, int objectType,
      uint securityInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern uint SetEntriesInAclW(
      int count, ref EXPLICIT_ACCESS entries, IntPtr oldAcl, out IntPtr newAcl);

    static UserObjectGrant GrantUserObject(IntPtr handle, uint access, string sidValue) {
      if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "User object handle is unavailable.");
      var sid = new SecurityIdentifier(sidValue);
      byte[] sidBytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(sidBytes, 0);
      IntPtr sidMemory = Marshal.AllocHGlobal(sidBytes.Length); Marshal.Copy(sidBytes, 0, sidMemory, sidBytes.Length);
      IntPtr owner = IntPtr.Zero, group = IntPtr.Zero, oldDacl = IntPtr.Zero, sacl = IntPtr.Zero, descriptor = IntPtr.Zero;
      IntPtr newDacl = IntPtr.Zero;
      try {
        uint result = GetSecurityInfo(handle, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION,
          out owner, out group, out oldDacl, out sacl, out descriptor);
        if (result != 0) throw new Win32Exception(unchecked((int)result), "GetSecurityInfo failed.");
        var trustee = new TRUSTEE { pMultipleTrustee = IntPtr.Zero, MultipleTrusteeOperation = 0,
          TrusteeForm = TRUSTEE_IS_SID, TrusteeType = TRUSTEE_IS_USER, ptstrName = sidMemory };
        var entry = new EXPLICIT_ACCESS { grfAccessPermissions = access, grfAccessMode = GRANT_ACCESS,
          grfInheritance = 0, Trustee = trustee };
        result = SetEntriesInAclW(1, ref entry, oldDacl, out newDacl);
        if (result != 0) throw new Win32Exception(unchecked((int)result), "SetEntriesInAcl failed.");
        result = SetSecurityInfo(handle, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION,
          IntPtr.Zero, IntPtr.Zero, newDacl, IntPtr.Zero);
        if (result != 0) throw new Win32Exception(unchecked((int)result), "SetSecurityInfo grant failed.");
        return new UserObjectGrant { Handle = handle, OldDacl = oldDacl, SecurityDescriptor = descriptor,
          NewDacl = newDacl, Sid = sidMemory };
      } catch {
        if (newDacl != IntPtr.Zero) LocalFree(newDacl);
        if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        Marshal.FreeHGlobal(sidMemory);
        throw;
      }
    }

    static void RestoreUserObject(UserObjectGrant grant) {
      if (grant == null) return;
      try {
        uint result = SetSecurityInfo(grant.Handle, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION,
          IntPtr.Zero, IntPtr.Zero, grant.OldDacl, IntPtr.Zero);
        if (result != 0) throw new Win32Exception(unchecked((int)result), "SetSecurityInfo restore failed.");
      } finally {
        if (grant.NewDacl != IntPtr.Zero) LocalFree(grant.NewDacl);
        if (grant.SecurityDescriptor != IntPtr.Zero) LocalFree(grant.SecurityDescriptor);
        if (grant.Sid != IntPtr.Zero) Marshal.FreeHGlobal(grant.Sid);
      }
    }

    static TokenEvidence InspectToken(IntPtr token) {
      int returned;
      IntPtr elevation = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_ELEVATION)));
      bool elevated;
      try {
        if (!GetTokenInformation(token, TokenElevation, elevation, Marshal.SizeOf(typeof(TOKEN_ELEVATION)), out returned))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenElevation failed.");
        elevated = ((TOKEN_ELEVATION)Marshal.PtrToStructure(elevation, typeof(TOKEN_ELEVATION))).TokenIsElevated != 0;
      } finally { Marshal.FreeHGlobal(elevation); }
      GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out returned);
      IntPtr integrity = Marshal.AllocHGlobal(returned);
      int rid;
      try {
        if (!GetTokenInformation(token, TokenIntegrityLevel, integrity, returned, out returned))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenIntegrityLevel failed.");
        var label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(integrity, typeof(TOKEN_MANDATORY_LABEL));
        byte count = Marshal.ReadByte(GetSidSubAuthorityCount(label.Label.Sid));
        rid = Marshal.ReadInt32(GetSidSubAuthority(label.Label.Sid, (uint)(count - 1)));
      } finally { Marshal.FreeHGlobal(integrity); }
      GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out returned);
      IntPtr userBuffer = Marshal.AllocHGlobal(returned);
      string userSid;
      try {
        if (!GetTokenInformation(token, TokenUser, userBuffer, returned, out returned))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenUser failed.");
        var user = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(userBuffer, typeof(SID_AND_ATTRIBUTES));
        userSid = new SecurityIdentifier(user.Sid).Value;
      } finally { Marshal.FreeHGlobal(userBuffer); }
      GetTokenInformation(token, TokenGroups, IntPtr.Zero, 0, out returned);
      IntPtr groupsBuffer = Marshal.AllocHGlobal(returned);
      bool administrator = false;
      try {
        if (!GetTokenInformation(token, TokenGroups, groupsBuffer, returned, out returned))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "TokenGroups failed.");
        uint count = unchecked((uint)Marshal.ReadInt32(groupsBuffer));
        int offset = Marshal.OffsetOf(typeof(TOKEN_GROUPS), "Groups").ToInt32();
        int size = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        for (uint index = 0; index < count; index++) {
          var group = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(groupsBuffer, offset + (int)index * size), typeof(SID_AND_ATTRIBUTES));
          if ((group.Attributes & SE_GROUP_ENABLED) != 0 && (group.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) == 0 &&
              new SecurityIdentifier(group.Sid).Value == "S-1-5-32-544") { administrator = true; break; }
        }
      } finally { Marshal.FreeHGlobal(groupsBuffer); }
      return new TokenEvidence { UserSid = userSid, Elevated = elevated, IntegrityRid = rid, Administrator = administrator };
    }

    public static ProcessResult Run(string username, string password, string expectedSid, string executable,
        string commandLine, string currentDirectory, uint timeoutMilliseconds) {
      IntPtr userToken = IntPtr.Zero;
      PROCESS_INFORMATION created = new PROCESS_INFORMATION();
      UserObjectGrant windowStationGrant = null, desktopGrant = null;
      bool finished = false;
      try {
        if (!LogonUserW(username, ".", password, 2, 0, out userToken))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "LogonUserW failed.");
        var selected = InspectToken(userToken);
        if (selected.UserSid != expectedSid || selected.Elevated || selected.Administrator ||
            selected.IntegrityRid < 0x2000 || selected.IntegrityRid >= 0x3000)
          throw new InvalidOperationException("Logon token is not the expected standard-user medium token.");
        var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = 0;
        windowStationGrant = GrantUserObject(GetProcessWindowStation(), WINSTA_ALL_ACCESS, expectedSid);
        desktopGrant = GrantUserObject(GetThreadDesktop(GetCurrentThreadId()), DESKTOP_ALL_ACCESS, expectedSid);
        var mutableCommandLine = new StringBuilder(commandLine);
        uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE;
        if (!CreateProcessWithLogonW(username, ".", password, 1, executable, mutableCommandLine, flags,
            IntPtr.Zero, currentDirectory, ref startup, out created))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessWithLogonW failed.");
        IntPtr processToken;
        if (!OpenProcessToken(created.hProcess, TOKEN_QUERY, out processToken))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken child failed.");
        TokenEvidence child;
        try { child = InspectToken(processToken); } finally { CloseHandle(processToken); }
        if (child.UserSid != expectedSid || child.Elevated || child.Administrator ||
            child.IntegrityRid < 0x2000 || child.IntegrityRid >= 0x3000)
          throw new InvalidOperationException("Child process is not the expected standard-user medium process.");
        uint resumeCount = ResumeThread(created.hThread);
        if (resumeCount == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed.");
        if (resumeCount != 1) throw new InvalidOperationException("Child thread suspend count was " + resumeCount + " before resume; expected 1.");
        uint wait = WaitForSingleObject(created.hProcess, timeoutMilliseconds);
        if (wait == WAIT_TIMEOUT) throw new TimeoutException("Standard-user MSIX child timed out.");
        if (wait != WAIT_OBJECT_0) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed.");
        finished = true;
        uint exitCode;
        if (!GetExitCodeProcess(created.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var completedDesktopGrant = desktopGrant; desktopGrant = null; RestoreUserObject(completedDesktopGrant);
        var completedWindowStationGrant = windowStationGrant; windowStationGrant = null; RestoreUserObject(completedWindowStationGrant);
        return new ProcessResult { ProcessId = created.dwProcessId, ExitCode = unchecked((int)exitCode),
          ResumeCount = resumeCount, Token = child };
      } finally {
        if (created.hProcess != IntPtr.Zero && !finished) TerminateProcess(created.hProcess, 124);
        var cleanupDesktopGrant = desktopGrant; desktopGrant = null;
        try { RestoreUserObject(cleanupDesktopGrant); } catch { }
        var cleanupWindowStationGrant = windowStationGrant; windowStationGrant = null;
        try { RestoreUserObject(cleanupWindowStationGrant); } catch { }
        if (created.hThread != IntPtr.Zero) CloseHandle(created.hThread);
        if (created.hProcess != IntPtr.Zero) CloseHandle(created.hProcess);
        if (userToken != IntPtr.Zero) CloseHandle(userToken);
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
$repository = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
$workspacePrefix = $repository.TrimEnd('\') + '\'
$builtApp = (Resolve-Path -LiteralPath $BuiltAppPath).Path
if (-not $builtApp.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Built app must be a workspace artifact.'
}
$product = Get-Content -LiteralPath (Join-Path $builtApp 'resources\app\product.json') -Raw | ConvertFrom-Json
if ($product.nameShort -ne 'Hydra' -or $product.hydraVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw 'Built app is not a versioned Hydra runtime.'
}

$scratch = Join-Path $repository '.test-build\msix-compatibility'
$before = @{}
if (Test-Path -LiteralPath $scratch) {
  Get-ChildItem -LiteralPath $scratch -Directory -Filter 'run-*' | ForEach-Object { $before[$_.FullName] = $true }
}
& (Get-Command node.exe).Source (Join-Path $repository 'scripts\desktop-msix-compatibility-probe.mjs') $builtApp
if ($LASTEXITCODE -ne 0) { throw 'MSIX packaging probe failed.' }
$created = @(Get-ChildItem -LiteralPath $scratch -Directory -Filter 'run-*' | Where-Object { -not $before.ContainsKey($_.FullName) })
if ($created.Count -ne 1) { throw 'MSIX probe did not create exactly one isolated run.' }
$run = $created[0].FullName
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repository 'scripts\desktop-msix-fixture-sign.ps1') -RunDirectory $run
if ($LASTEXITCODE -ne 0) { throw 'MSIX fixture signing failed.' }
$signing = Get-Content -LiteralPath (Join-Path $run 'fixture-signing.json') -Raw | ConvertFrom-Json
$signedPackage = (Resolve-Path -LiteralPath $signing.package).Path
$certificate = (Resolve-Path -LiteralPath $signing.certificate).Path
$packageName = 'NicoDunlap.Hydra.Probe'
$package = $null
$imported = $null
$installLocation = $null
$tamperRefused = $false
$newFileRefused = $false
$existingFileWriteRefused = $false
$existingProcessIds = @()
$activationAttempted = $false
$workflowReport = $null
$standardUserReport = $null
$fixtureUser = $null
$fixtureUserSid = $null
$fixtureSecurityIdentifier = $null
$fixtureAclRule = $null
$fixturePassword = $null
$fixtureAclRemoved = $true
$report = [ordered]@{
  schemaVersion = 1
  status = 'started'
  sourceHydraVersion = $product.hydraVersion
  packageSha256 = (Get-FileHash -LiteralPath $signedPackage -Algorithm SHA256).Hash.ToLowerInvariant()
  certificateThumbprint = $signing.thumbprint
  packageIdentity = $packageName
  checks = [ordered]@{}
}
try {
  if (Get-AppxPackage -Name $packageName) { throw 'Disposable runner already contains the Hydra probe package.' }
  if (Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Thumbprint -eq $signing.thumbprint) {
    throw 'Disposable runner already trusts the fixture certificate.'
  }
  $imported = Import-Certificate -FilePath $certificate -CertStoreLocation Cert:\LocalMachine\TrustedPeople
  if ($imported.Thumbprint -ne $signing.thumbprint) { throw 'Imported fixture certificate thumbprint changed.' }
  $report.checks.fixtureTrust = 'temporary LocalMachine TrustedPeople'

  # A changed copy must fail before a valid package is installed.
  $tampered = Join-Path $run 'HydraProbe-tampered.msix'
  Copy-Item -LiteralPath $signedPackage -Destination $tampered
  $stream = [IO.File]::Open($tampered, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $offset = [Math]::Floor($stream.Length / 2)
    $stream.Position = $offset
    $original = $stream.ReadByte()
    if ($original -lt 0) { throw 'Tamper fixture is empty.' }
    $stream.Position = $offset
    $stream.WriteByte($original -bxor 1)
  } finally { $stream.Dispose() }
  try { Add-AppxPackage -Path $tampered -ErrorAction Stop }
  catch { $tamperRefused = $true; $report.checks.tamperedPackageError = $_.Exception.Message }
  if (-not $tamperRefused -or (Get-AppxPackage -Name $packageName)) { throw 'Tampered MSIX package was accepted.' }

  Add-AppxPackage -Path $signedPackage -ErrorAction Stop
  $package = Get-AppxPackage -Name $packageName
  if (-not $package -or $package.Version.ToString() -ne ($product.hydraVersion + '.0')) {
    throw 'Installed MSIX identity or version does not match the Hydra runtime.'
  }
  if ($package.Publisher -ne 'CN=Hydra Fixture') { throw 'Installed MSIX publisher changed.' }
  $installLocation = $package.InstallLocation
  if (-not $installLocation.StartsWith((Join-Path $env:ProgramFiles 'WindowsApps') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'MSIX payload was not installed in the protected WindowsApps location.'
  }
  $installedExecutable = Join-Path $installLocation 'Hydra.exe'
  $installedExtension = Join-Path $installLocation 'resources\app\extensions\hydra-agent-manager\dist\extension.cjs'
  foreach ($pair in @(@((Join-Path $builtApp 'Hydra.exe'), $installedExecutable), @((Join-Path $builtApp 'resources\app\extensions\hydra-agent-manager\dist\extension.cjs'), $installedExtension))) {
    if ((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash) {
      throw "Installed payload differs from packaged input: $($pair[1])"
    }
  }

  $newFile = Join-Path $installLocation 'hydra-write-probe.txt'
  try { [IO.File]::WriteAllText($newFile, 'must not be created') }
  catch {
    if ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException]) { $newFileRefused = $true }
    else { throw }
  }
  if (Test-Path -LiteralPath $newFile) {
    Remove-Item -LiteralPath $newFile -Force -ErrorAction SilentlyContinue
    throw 'Ordinary process created a file in the installed package.'
  }
  $beforeExtensionHash = (Get-FileHash -LiteralPath $installedExtension -Algorithm SHA256).Hash
  try {
    $writeHandle = [IO.File]::Open($installedExtension, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $writeHandle.Dispose()
  } catch {
    if ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException]) { $existingFileWriteRefused = $true }
    else { throw }
  }
  if (-not $newFileRefused -or -not $existingFileWriteRefused -or (Get-FileHash -LiteralPath $installedExtension -Algorithm SHA256).Hash -ne $beforeExtensionHash) {
    throw 'Installed package payload was writable or changed.'
  }

  if ((Get-Item -LiteralPath $installedExecutable).VersionInfo.ProductVersion -ne $product.hydraVersion) {
    throw 'Installed Hydra executable did not retain its packaged PE version.'
  }

  $fixtureUserName = 'hydra' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $fixturePassword = 'H!' + [Guid]::NewGuid().ToString('N') + 'a9'
  $securePassword = ConvertTo-SecureString $fixturePassword -AsPlainText -Force
  $fixtureUser = New-LocalUser -Name $fixtureUserName -Password $securePassword -AccountNeverExpires `
    -PasswordNeverExpires -UserMayNotChangePassword -Description 'Disposable Hydra MSIX acceptance user'
  $fixtureUserSid = $fixtureUser.SID.Value
  $fixtureSecurityIdentifier = [Security.Principal.SecurityIdentifier]::new($fixtureUserSid)
  if (-not (Get-LocalGroupMember -SID 'S-1-5-32-545' | Where-Object SID -eq $fixtureUserSid)) {
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $fixtureUser
  }
  if (Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object SID -eq $fixtureUserSid) {
    throw 'Disposable Hydra fixture user unexpectedly belongs to Administrators.'
  }
  $runAcl = Get-Acl -LiteralPath $run
  $fixtureAclRule = New-Object Security.AccessControl.FileSystemAccessRule(
    $fixtureSecurityIdentifier, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  [void]$runAcl.AddAccessRule($fixtureAclRule)
  Set-Acl -LiteralPath $run -AclObject $runAcl

  $standardResultPath = Join-Path $run 'standard-user-report.json'
  $standardRequestPath = Join-Path $run 'standard-user-request.json'
  $childScript = Join-Path $repository 'scripts\desktop-msix-standard-user-test.ps1'
  [ordered]@{
    repository = $repository
    expectedUserSid = $fixtureUserSid
    packagePath = $signedPackage
    packageName = $packageName
    expectedVersion = ($product.hydraVersion + '.0')
    workflowScript = (Join-Path $repository 'scripts\desktop-msix-workflow-test.ps1')
    childScript = $childScript
    runDirectory = $run
    resultPath = $standardResultPath
    environment = [ordered]@{
      githubActions = $env:GITHUB_ACTIONS
      runnerEnvironment = $env:RUNNER_ENVIRONMENT
      runnerOs = $env:RUNNER_OS
    }
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $standardRequestPath -Encoding utf8

  $nativeMarker = Join-Path $run 'standard-user-native-probe.txt'
  $nativeProbe = Join-Path $run 'standard-user-native-probe.cmd'
  Set-Content -LiteralPath $nativeProbe -Encoding ascii -Value "@echo passed>`"$nativeMarker`""
  $cmd = (Get-Command cmd.exe).Source
  $nativeArguments = Join-WindowsArguments @('/d', '/c', $nativeProbe)
  $nativeCommandLine = (ConvertTo-WindowsArgument $cmd) + ' ' + $nativeArguments
  try {
    $nativeChild = [HydraMsixStandardUserController.Native]::Run($fixtureUserName, $fixturePassword, $fixtureUserSid,
      $cmd, $nativeCommandLine, $run, 30000)
  } catch { throw "Standard-user native launch probe failed: $($_.Exception.Message)" }
  if ($nativeChild.ExitCode -ne 0 -or (Get-Content -LiteralPath $nativeMarker -Raw -ErrorAction SilentlyContinue).Trim() -ne 'passed') {
    throw "Standard-user native launch probe returned exit code $($nativeChild.ExitCode)."
  }

  $powershellMarker = Join-Path $run 'standard-user-powershell-probe.txt'
  $powershellProbe = Join-Path $run 'standard-user-powershell-probe.ps1'
  Set-Content -LiteralPath $powershellProbe -Encoding utf8 -Value @'
param([string]$RequestPath, [string]$MarkerPath)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
Get-Content -LiteralPath ([string]$request.workflowScript) -TotalCount 1 | Out-Null
Get-Content -LiteralPath ([string]$request.childScript) -TotalCount 1 | Out-Null
Set-Content -LiteralPath $MarkerPath -Value 'passed' -Encoding ascii
'@
  $powershell = (Get-Command powershell.exe).Source
  $powershellProbeArguments = Join-WindowsArguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', $powershellProbe, '-RequestPath', $standardRequestPath, '-MarkerPath', $powershellMarker)
  $powershellProbeCommandLine = (ConvertTo-WindowsArgument $powershell) + ' ' + $powershellProbeArguments
  try {
    $powershellChild = [HydraMsixStandardUserController.Native]::Run($fixtureUserName, $fixturePassword, $fixtureUserSid,
      $powershell, $powershellProbeCommandLine, $run, 30000)
  } catch { throw "Standard-user PowerShell launch probe failed: $($_.Exception.Message)" }
  if ($powershellChild.ExitCode -ne 0 -or (Get-Content -LiteralPath $powershellMarker -Raw -ErrorAction SilentlyContinue).Trim() -ne 'passed') {
    throw "Standard-user PowerShell launch probe returned exit code $($powershellChild.ExitCode)."
  }
  $report.checks.standardUserLaunchPreflight = [ordered]@{
    nativeResumeCount = $nativeChild.ResumeCount
    powershellResumeCount = $powershellChild.ResumeCount
  }

  $existingProcessIds = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $activationAttempted = $true
  $childArguments = Join-WindowsArguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', $childScript, '-RequestPath', $standardRequestPath)
  $childCommandLine = (ConvertTo-WindowsArgument $powershell) + ' ' + $childArguments
  $child = [HydraMsixStandardUserController.Native]::Run($fixtureUserName, $fixturePassword, $fixtureUserSid,
    $powershell, $childCommandLine, $run, 600000)
  if ($child.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $standardResultPath)) {
    throw "Standard-user MSIX controller failed with exit code $($child.ExitCode)."
  }
  $standardUserReport = Get-Content -LiteralPath $standardResultPath -Raw | ConvertFrom-Json
  if ($standardUserReport.status -ne 'passed' -or -not $standardUserReport.packageRemoved) {
    throw "Standard-user packaged workflow failed: $($standardUserReport.error)"
  }
  if (Get-AppxPackage -User $fixtureUserSid -Name $packageName) {
    throw 'Standard-user package registration survived child cleanup.'
  }
  $workflowReport = Get-Content -LiteralPath (Join-Path $run 'workflow-report.json') -Raw | ConvertFrom-Json
  if ($workflowReport.status -ne 'passed') { throw 'Packaged MSIX workflow report did not pass.' }

  $report.checks.tamperedPackage = 'refused'
  $report.checks.installedVersion = $package.Version.ToString()
  $report.checks.installLocation = $installLocation
  $report.checks.inputHashes = 'Hydra.exe and built-in Hydra extension match'
  $report.checks.protectedNewFile = 'refused'
  $report.checks.protectedExistingFileWrite = 'refused'
  $report.checks.executablePeVersion = $product.hydraVersion
  $report.checks.standardUserToken = $standardUserReport.token
  $report.checks.registeredApplicationLaunch = 'passed as a standard local user with explicit arguments and process identity attestation'
  $report.checks.packagedWorkflows = $workflowReport.checks
  $report.status = 'passed'
} finally {
  if ($activationAttempted) {
    Get-Process -Name Hydra -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $existingProcessIds } |
      Stop-Process -Force -ErrorAction Continue
  }
  if ($fixtureUserSid) {
    $fixturePackages = @(Get-AppxPackage -User $fixtureUserSid -Name $packageName -ErrorAction SilentlyContinue)
    $fixturePackages | ForEach-Object {
      Remove-AppxPackage -Package $_.PackageFullName -User $fixtureUserSid -ErrorAction Continue
    }
    if ($fixtureAclRule) {
      try {
        $cleanupAcl = Get-Acl -LiteralPath $run
        $cleanupAcl.PurgeAccessRules($fixtureSecurityIdentifier)
        Set-Acl -LiteralPath $run -AclObject $cleanupAcl -ErrorAction Stop
        $fixtureAclRemoved = -not [bool](@((Get-Acl -LiteralPath $run).Access |
          Where-Object { $_.IdentityReference.Value -eq $fixtureUserSid }))
      } catch {
        $fixtureAclRemoved = $false
      }
    }
    Get-CimInstance Win32_UserProfile -Filter "SID='$fixtureUserSid'" -ErrorAction SilentlyContinue |
      Remove-CimInstance -ErrorAction Continue
  }
  if ($fixtureUser) { Remove-LocalUser -SID $fixtureUser.SID -ErrorAction Continue }
  $fixturePassword = $null
  $installed = Get-AppxPackage -Name $packageName
  if ($installed) { Remove-AppxPackage -Package $installed.PackageFullName -ErrorAction Continue }
  if ($imported) {
    @($imported) | ForEach-Object { Remove-Item -LiteralPath ('Cert:\LocalMachine\TrustedPeople\' + $_.Thumbprint) -Force -ErrorAction Continue }
  }
  $report.cleanup = [ordered]@{
    packageRemoved = -not [bool](Get-AppxPackage -Name $packageName)
    certificateRemoved = -not [bool](Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Thumbprint -eq $signing.thumbprint)
    privateKeyAbsent = -not (Test-Path -LiteralPath (Join-Path $run 'fixture-signing.key'))
    pfxAbsent = -not (Test-Path -LiteralPath (Join-Path $run 'fixture-signing.pfx'))
    standardUserPackageRemoved = -not $fixtureUserSid -or -not [bool](Get-AppxPackage -User $fixtureUserSid -Name $packageName -ErrorAction SilentlyContinue)
    standardUserProfileRemoved = -not $fixtureUserSid -or -not [bool](Get-CimInstance Win32_UserProfile -Filter "SID='$fixtureUserSid'" -ErrorAction SilentlyContinue)
    standardUserRemoved = -not $fixtureUserSid -or -not [bool](Get-LocalUser -SID $fixtureUserSid -ErrorAction SilentlyContinue)
    standardUserAclRemoved = $fixtureAclRemoved
  }
  $logRoot = Join-Path $repository '.desktop\msix-test-logs'
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $logRoot 'report.json') -Encoding utf8
  Copy-Item -LiteralPath (Join-Path $run 'report.json') -Destination (Join-Path $logRoot 'packaging-report.json') -Force
  Copy-Item -LiteralPath (Join-Path $run 'fixture-signing.json') -Destination (Join-Path $logRoot 'fixture-signing.json') -Force
  if (Test-Path -LiteralPath (Join-Path $run 'workflow-report.json')) {
    Copy-Item -LiteralPath (Join-Path $run 'workflow-report.json') -Destination (Join-Path $logRoot 'workflow-report.json') -Force
  }
  if (Test-Path -LiteralPath (Join-Path $run 'standard-user-report.json')) {
    Copy-Item -LiteralPath (Join-Path $run 'standard-user-report.json') -Destination (Join-Path $logRoot 'standard-user-report.json') -Force
  }
}
if ($report.status -ne 'passed' -or $report.cleanup.Values -contains $false) { throw 'MSIX fixture acceptance or cleanup failed.' }
Write-Output 'PASS: signed current Hydra MSIX installs, rejects tampering and package writes, passes packaged workflows, and removes package trust.'
