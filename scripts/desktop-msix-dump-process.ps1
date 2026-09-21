param(
  [Parameter(Mandatory = $true)][uint32]$TargetProcessId,
  [Parameter(Mandatory = $true)][string]$DumpPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace HydraMsixDump {
  public static class Native {
    const uint PROCESS_VM_READ = 0x0010;
    const uint PROCESS_DUP_HANDLE = 0x0040;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint MINI_DUMP_TYPE = 0x00001925;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("Dbghelp.dll", SetLastError = true)]
    static extern bool MiniDumpWriteDump(IntPtr process, uint processId, IntPtr file, uint dumpType,
      IntPtr exceptionParam, IntPtr userStreamParam, IntPtr callbackParam);

    public static void Write(uint processId, string dumpPath) {
      IntPtr process = OpenProcess(PROCESS_VM_READ | PROCESS_DUP_HANDLE | PROCESS_QUERY_INFORMATION, false, processId);
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess for dump failed.");
      try {
        using (var output = new FileStream(dumpPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None)) {
          if (!MiniDumpWriteDump(process, processId, output.SafeFileHandle.DangerousGetHandle(), MINI_DUMP_TYPE,
              IntPtr.Zero, IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "MiniDumpWriteDump failed.");
        }
      } finally { CloseHandle(process); }
    }
  }
}
'@

$resolvedDumpPath = [IO.Path]::GetFullPath($DumpPath)
$parent = Split-Path -Parent $resolvedDumpPath
New-Item -ItemType Directory -Path $parent -Force | Out-Null
[HydraMsixDump.Native]::Write($TargetProcessId, $resolvedDumpPath)
$file = Get-Item -LiteralPath $resolvedDumpPath
[ordered]@{
  status = 'passed'
  processId = $TargetProcessId
  path = $file.FullName
  bytes = $file.Length
  sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
} | ConvertTo-Json -Compress
