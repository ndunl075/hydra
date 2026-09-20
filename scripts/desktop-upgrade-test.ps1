param(
  [Parameter(Mandatory = $true)][string]$PriorInstallerPath,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$BuiltAppPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Distinct-version upgrade tests run only on disposable GitHub-hosted Windows runners.'
}
$workspaceRoot = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path.TrimEnd('\')
function Resolve-WorkspaceArtifact([string]$value) {
  $resolved = (Resolve-Path -LiteralPath $value).Path
  if (-not $resolved.StartsWith($workspaceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Upgrade artifacts must be inside the CI workspace.' }
  return $resolved
}
$prior = Resolve-WorkspaceArtifact $PriorInstallerPath
$current = Resolve-WorkspaceArtifact $InstallerPath
$built = Resolve-WorkspaceArtifact $BuiltAppPath
$baseline = Get-Content -LiteralPath (Join-Path $workspaceRoot 'desktop\upgrade-baseline.json') -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $workspaceRoot 'package.json') -Raw | ConvertFrom-Json
if ([version]$baseline.version -ge [version]$manifest.version) { throw 'Upgrade requires a strictly newer Hydra version.' }
if ((Get-FileHash -LiteralPath $prior -Algorithm SHA256).Hash -ne $baseline.installerSha256) { throw 'Prior installer checksum does not match the pinned tested artifact.' }
$currentHash = (Get-FileHash -LiteralPath $current -Algorithm SHA256).Hash
$product = Get-Content -LiteralPath (Join-Path $built 'resources\app\product.json') -Raw | ConvertFrom-Json
$module = Get-Content -LiteralPath (Join-Path $built 'resources\app\extensions\hydra-agent-manager\package.json') -Raw | ConvertFrom-Json
if ($product.hydraVersion -ne $manifest.version -or $module.version -ne $manifest.version -or $product.nameShort -ne 'Hydra' -or $product.dataFolderName -ne '.hydra') { throw 'Current built runtime identity does not match the manifest.' }
$stagedProductPath = Join-Path (Split-Path -Parent $current) 'product.json'
$stagedProduct = Get-Content -LiteralPath $stagedProductPath -Raw | ConvertFrom-Json
if ($null -ne $product.PSObject.Properties['target']) { throw 'Built runtime product unexpectedly has an installer target.' }
$product | Add-Member -NotePropertyName target -NotePropertyValue 'user'
if ($stagedProduct.target -ne 'user' -or ($stagedProduct | ConvertTo-Json -Depth 100 -Compress) -cne ($product | ConvertTo-Json -Depth 100 -Compress)) { throw 'Installer-staged product differs from the built runtime plus its user target.' }
$testRoot = Join-Path $env:RUNNER_TEMP ('hydra-upgrade-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'Hydra'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Hydra.lnk'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{4C372D32-54B2-43D8-8C63-ECC31D3744A8}_is1'
if ((Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Runner already contains Hydra installation or shortcut; refusing to replace it.' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$sentinels = @(
  (Join-Path $env:APPDATA 'Hydra\User\settings.json'),
  (Join-Path $env:APPDATA 'Hydra\User\profiles\hydra-upgrade-fixture\settings.json'),
  (Join-Path $env:APPDATA 'Hydra\User\globalStorage\nico-dunlap.hydra-agent-manager\upgrade-fixture\tasks.json'),
  (Join-Path $env:USERPROFILE '.hydra\extensions\hydra-upgrade-fixture\package.json'),
  (Join-Path $env:APPDATA 'Code\User\hydra-upgrade-sentinel.txt'),
  (Join-Path $env:APPDATA 'Cursor\User\hydra-upgrade-sentinel.txt'),
  (Join-Path $testRoot 'project\keep.txt')
)
$hashes = @{}
foreach ($file in $sentinels) {
  if (Test-Path -LiteralPath $file) { throw "Unexpected existing upgrade sentinel: $file" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
  [IO.File]::WriteAllText($file, '{"hydraUpgradeFixture":"preserve across distinct versions"}')
  $hashes[$file] = (Get-FileHash -LiteralPath $file).Hash
}
function Assert-DataPreserved {
  foreach ($file in $sentinels) { if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file).Hash -ne $hashes[$file]) { throw "Upgrade changed user data: $file" } }
}
function Assert-Identity([string]$expectedVersion, [bool]$compareCurrent) {
  $installedProduct = Get-Content -LiteralPath (Join-Path $installRoot 'resources\app\product.json') -Raw | ConvertFrom-Json
  $installedModule = Get-Content -LiteralPath (Join-Path $installRoot 'resources\app\extensions\hydra-agent-manager\package.json') -Raw | ConvertFrom-Json
  $registration = Get-ItemProperty -LiteralPath $uninstallKey
  if ($installedProduct.nameShort -ne 'Hydra' -or $installedProduct.dataFolderName -ne '.hydra' -or $installedProduct.hydraVersion -ne $expectedVersion -or $installedModule.version -ne $expectedVersion -or $registration.DisplayVersion -ne $expectedVersion) { throw 'Installed product/module/registry version does not match the expected upgrade stage.' }
  if ($compareCurrent) {
    # The pinned Inno task adds target=user to product.json before packaging it.
    # Compare that exact staged file to the installation, while every other
    # runtime file must match the original CI build bytes.
    if ((Get-FileHash -LiteralPath $stagedProductPath).Hash -ne (Get-FileHash -LiteralPath (Join-Path $installRoot 'resources\app\product.json')).Hash) { throw 'Installed product differs from the exact installer-staged CI product.' }
    foreach ($relative in @('Hydra.exe', 'resources\app\extensions\hydra-agent-manager\package.json', 'resources\app\extensions\hydra-agent-manager\dist\extension.cjs', 'resources\app\extensions\hydra-agent-manager\dist\webview.js')) {
      if ((Get-FileHash -LiteralPath (Join-Path $built $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $installRoot $relative)).Hash) { throw "Installed current runtime differs from the exact CI build: $relative" }
    }
  }
  Assert-DataPreserved
}
function Invoke-UpgradeInstaller([string]$executable, [string]$label, [string[]]$tasks) {
  $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NORESTARTAPPLICATIONS', ('/DIR="' + $installRoot + '"'), ('/LOG="' + (Join-Path $testRoot ($label + '.log')) + '"')) + $tasks
  $process = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Upgrade installer $label failed: $($process.ExitCode)" }
}
function Assert-InstallerRefused([string]$executable, [string]$label, [string[]]$extra) {
  $installedExe = Join-Path $installRoot 'Hydra.exe'
  $beforeHash = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash
  $beforeVersion = (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion
  $beforeShortcut = Test-Path -LiteralPath $desktopShortcut
  $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NORESTARTAPPLICATIONS', ('/DIR="' + $installRoot + '"'), ('/LOG="' + (Join-Path $testRoot ($label + '.log')) + '"')) + $extra
  $process = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -eq 0) { throw "Unsafe installer $label was accepted." }
  if ((Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash -ne $beforeHash -or (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -ne $beforeVersion -or (Test-Path -LiteralPath $desktopShortcut) -ne $beforeShortcut) { throw "Installer refusal $label changed installation state." }
  Assert-DataPreserved
}
function Remove-TestInstallation([string]$label) {
  $uninstaller = Join-Path $installRoot 'unins000.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $process = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + (Join-Path $testRoot ($label + '-uninstall.log')) + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Upgrade uninstall failed: $($process.ExitCode)" }
  }
  if ((Test-Path -LiteralPath (Join-Path $installRoot 'Hydra.exe')) -or (Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Upgrade uninstall left runtime, shortcut or registration behind.' }
  Assert-DataPreserved
}
try {
  foreach ($enabled in @($true, $false)) {
    $label = if ($enabled) { 'shortcut-selected' } else { 'shortcut-unselected' }
    $priorTasks = if ($enabled) { @('/TASKS="desktopicon"') } else { @('/TASKS=""') }
    Invoke-UpgradeInstaller $prior ($label + '-prior') $priorTasks
    Assert-Identity $baseline.version $false
    if ((Test-Path -LiteralPath $desktopShortcut) -ne $enabled) { throw 'Prior installer shortcut choice was not established.' }
    Assert-InstallerRefused $current ($label + '-task-override') @('/HYDRAUPDATE=1', '/TASKS="desktopicon"')
    Assert-InstallerRefused $current ($label + '-force-close') @('/HYDRAUPDATE=1', '/CLOSEAPPLICATIONS')
    Assert-InstallerRefused $current ($label + '-upstream-update') @('/UPDATE=unsafe')
    Invoke-UpgradeInstaller $current ($label + '-upgrade') @('/HYDRAUPDATE=1')
    Assert-Identity $manifest.version $true
    if ((Test-Path -LiteralPath $desktopShortcut) -ne $enabled) { throw 'Distinct-version upgrade changed remembered shortcut preference.' }
    Assert-InstallerRefused $current ($label + '-equal') @('/HYDRAUPDATE=1')
    # Historical installers cannot acquire a guard retroactively. A synthetic
    # newer registration proves this installer's downgrade refusal only.
    Set-ItemProperty -LiteralPath $uninstallKey -Name DisplayVersion -Value '99.0.0'
    try { Assert-InstallerRefused $current ($label + '-synthetic-downgrade') @() }
    finally { Set-ItemProperty -LiteralPath $uninstallKey -Name DisplayVersion -Value $manifest.version }
    if ($enabled) { $shell = New-Object -ComObject WScript.Shell; if ($shell.CreateShortcut($desktopShortcut).TargetPath -ne (Join-Path $installRoot 'Hydra.exe')) { throw 'Upgraded shortcut targets another executable.' } }
    Remove-TestInstallation $label
  }
} finally {
  try { Remove-TestInstallation 'cleanup' }
  finally {
    $logs = Join-Path $workspaceRoot '.desktop\upgrade-test-logs'; New-Item -ItemType Directory -Path $logs -Force | Out-Null
    Get-ChildItem -LiteralPath $testRoot -Filter '*.log' | Copy-Item -Destination $logs
    [ordered]@{ prior = $baseline; currentVersion = $manifest.version; currentInstallerSha256 = $currentHash; runtimeCompared = @('Hydra.exe', 'product.json', 'built-in module', 'extension.cjs', 'webview.js') } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $logs 'provenance.json') -Encoding utf8
  }
}
Write-Output "PASS: pinned Hydra $($baseline.version) upgrades to $($manifest.version), preserves selected/unselected shortcut preference and user/profile/extension/task/project data, matches exact current runtime, and uninstalls cleanly."
