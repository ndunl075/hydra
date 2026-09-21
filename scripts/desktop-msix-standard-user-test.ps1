param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$env:GITHUB_ACTIONS = [string]$request.environment.githubActions
$env:RUNNER_ENVIRONMENT = [string]$request.environment.runnerEnvironment
$env:RUNNER_OS = [string]$request.environment.runnerOs
$env:GITHUB_WORKSPACE = [string]$request.repository

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Standard-user MSIX tests run only on disposable GitHub-hosted Windows runners.'
}

$resultPath = [string]$request.resultPath
$report = [ordered]@{ schemaVersion = 1; status = 'started'; phase = 'bootstrap'; packageRemoved = $false }
function Save-Report {
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding utf8
}
Save-Report

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace HydraMsixStandardUserChild {
  public sealed class TokenEvidence {
    public string UserSid { get; set; }
    public bool Elevated { get; set; }
    public int IntegrityRid { get; set; }
    public bool Administrator { get; set; }
  }
  public static class Native {
    const uint TOKEN_QUERY = 0x0008;
    const int TokenElevation = 20;
    const int TokenIntegrityLevel = 25;
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_ELEVATION { public int TokenIsElevated; }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int tokenClass, IntPtr information, int length, out int returnLength);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthority);

    public static TokenEvidence Inspect() {
      IntPtr token;
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        int returned;
        IntPtr elevation = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_ELEVATION)));
        bool elevated;
        try {
          if (!GetTokenInformation(token, TokenElevation, elevation, Marshal.SizeOf(typeof(TOKEN_ELEVATION)), out returned))
            throw new Win32Exception(Marshal.GetLastWin32Error());
          elevated = ((TOKEN_ELEVATION)Marshal.PtrToStructure(elevation, typeof(TOKEN_ELEVATION))).TokenIsElevated != 0;
        } finally { Marshal.FreeHGlobal(elevation); }
        GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out returned);
        IntPtr integrity = Marshal.AllocHGlobal(returned);
        int rid;
        try {
          if (!GetTokenInformation(token, TokenIntegrityLevel, integrity, returned, out returned))
            throw new Win32Exception(Marshal.GetLastWin32Error());
          var label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(integrity, typeof(TOKEN_MANDATORY_LABEL));
          byte count = Marshal.ReadByte(GetSidSubAuthorityCount(label.Label.Sid));
          rid = Marshal.ReadInt32(GetSidSubAuthority(label.Label.Sid, (uint)(count - 1)));
        } finally { Marshal.FreeHGlobal(integrity); }
        using (var identity = new WindowsIdentity(token)) {
          var principal = new WindowsPrincipal(identity);
          return new TokenEvidence { UserSid = identity.User.Value, Elevated = elevated, IntegrityRid = rid,
            Administrator = principal.IsInRole(WindowsBuiltInRole.Administrator) };
        }
      } finally { CloseHandle(token); }
    }
  }
}
'@

$evidence = [HydraMsixStandardUserChild.Native]::Inspect()
$report.token = $evidence
$report.phase = 'token-attested'
Save-Report
$package = $null
try {
  if ($evidence.UserSid -ne [string]$request.expectedUserSid -or $evidence.Elevated -or $evidence.Administrator -or
      $evidence.IntegrityRid -lt 0x2000 -or $evidence.IntegrityRid -ge 0x3000) {
    throw 'Fixture child is not the expected non-administrator medium-integrity user.'
  }
  if (Get-AppxPackage -Name ([string]$request.packageName)) { throw 'Fixture user already has the Hydra probe package.' }
  $report.phase = 'installing-package'
  Save-Report
  Add-AppxPackage -Path ([string]$request.packagePath) -ErrorAction Stop
  $package = Get-AppxPackage -Name ([string]$request.packageName)
  if (-not $package -or $package.Version.ToString() -ne [string]$request.expectedVersion) {
    throw 'Fixture user package identity or version changed.'
  }
  $report.phase = 'running-workflow'
  $report.packageFullName = $package.PackageFullName
  $report.packageFamilyName = $package.PackageFamilyName
  $report.installLocation = $package.InstallLocation
  Save-Report
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ([string]$request.workflowScript) `
    -PackageFullName $package.PackageFullName -PackageFamilyName $package.PackageFamilyName `
    -InstallLocation $package.InstallLocation -RunDirectory ([string]$request.runDirectory)
  if ($LASTEXITCODE -ne 0) { throw 'Standard-user packaged workflow acceptance failed.' }
  $workflow = Get-Content -LiteralPath (Join-Path ([string]$request.runDirectory) 'workflow-report.json') -Raw | ConvertFrom-Json
  if ($workflow.status -ne 'passed') { throw 'Standard-user packaged workflow report did not pass.' }
  $report.workflow = $workflow.checks
  $report.phase = 'passed'
  $report.status = 'passed'
} catch {
  $report.phase = 'failed'
  $report.error = $_.Exception.ToString()
} finally {
  $installed = Get-AppxPackage -Name ([string]$request.packageName)
  if ($installed) { Remove-AppxPackage -Package $installed.PackageFullName -ErrorAction Continue }
  $report.packageRemoved = -not [bool](Get-AppxPackage -Name ([string]$request.packageName))
  Save-Report
}
if ($report.status -ne 'passed' -or -not $report.packageRemoved) { throw 'Standard-user MSIX fixture failed; inspect its report.' }
