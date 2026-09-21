param([Parameter(Mandatory = $true)][string]$BuiltAppPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Package trust is machine-wide. Run this only on the disposable Windows host
# whose entire lifetime is controlled by the desktop acceptance workflow.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'MSIX installation tests run only on disposable GitHub-hosted Windows runners.'
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
$launchedProcessIds = @()
$existingProcessIds = @()
$activationAttempted = $false
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
  $existingProcessIds = @((Get-Process -Name Hydra -ErrorAction SilentlyContinue).Id)
  $applicationId = 'shell:AppsFolder\' + $package.PackageFamilyName + '!HydraProbe'
  $activationAttempted = $true
  Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList $applicationId
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    $launched = @(Get-Process -Name Hydra -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $existingProcessIds })
  } while ($launched.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline)
  if ($launched.Count -eq 0) { throw 'Registered MSIX application did not launch.' }
  $launchedProcessIds = @($launched.Id)
  Start-Sleep -Seconds 3
  $remaining = @(Get-Process -Id $launchedProcessIds -ErrorAction SilentlyContinue)
  if ($remaining.Count -eq 0 -or -not ($remaining | Where-Object { $_.Path -eq $installedExecutable })) {
    throw 'Registered MSIX application did not remain running from its installed executable.'
  }

  $report.checks.tamperedPackage = 'refused'
  $report.checks.installedVersion = $package.Version.ToString()
  $report.checks.installLocation = $installLocation
  $report.checks.inputHashes = 'Hydra.exe and built-in Hydra extension match'
  $report.checks.protectedNewFile = 'refused'
  $report.checks.protectedExistingFileWrite = 'refused'
  $report.checks.executablePeVersion = $product.hydraVersion
  $report.checks.registeredApplicationLaunch = 'passed'
  $report.status = 'passed'
} finally {
  if ($activationAttempted) {
    Get-Process -Name Hydra -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $existingProcessIds } |
      Stop-Process -Force -ErrorAction Continue
  }
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
  }
  $logRoot = Join-Path $repository '.desktop\msix-test-logs'
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $logRoot 'report.json') -Encoding utf8
  Copy-Item -LiteralPath (Join-Path $run 'report.json') -Destination (Join-Path $logRoot 'packaging-report.json') -Force
  Copy-Item -LiteralPath (Join-Path $run 'fixture-signing.json') -Destination (Join-Path $logRoot 'fixture-signing.json') -Force
}
if ($report.status -ne 'passed' -or $report.cleanup.Values -contains $false) { throw 'MSIX fixture acceptance or cleanup failed.' }
Write-Output 'PASS: signed current Hydra MSIX installs, rejects tampering and package writes, launches by registered identity, and removes package trust.'
