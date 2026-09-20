param([Parameter(Mandatory = $true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This intentionally cannot be a local developer acceptance command.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Installer lifecycle tests run only on disposable GitHub-hosted Windows runners.'
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$workspaceRoot = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path.TrimEnd('\') + '\'
if (-not $installer.StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer must be a workspace artifact.' }
$testRoot = Join-Path $env:RUNNER_TEMP ('hydra-installer-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'Hydra'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Hydra.lnk'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{4C372D32-54B2-43D8-8C63-ECC31D3744A8}_is1'
if ((Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Runner already contains a Hydra install or shortcut; refusing to replace it.' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$sentinels = @(
  (Join-Path $env:APPDATA 'Hydra\User\hydra-installer-sentinel.txt'),
  (Join-Path $env:USERPROFILE '.hydra\extensions\hydra-installer-sentinel.txt'),
  (Join-Path $env:APPDATA 'Code\User\hydra-installer-sentinel.txt'),
  (Join-Path $env:APPDATA 'Cursor\User\hydra-installer-sentinel.txt'),
  (Join-Path $testRoot 'project\keep.txt')
)
foreach ($file in $sentinels) {
  if (Test-Path -LiteralPath $file) { throw "Unexpected existing sentinel: $file" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
  [IO.File]::WriteAllText($file, 'Keep this user data ' + $file)
}
$hashes = @{}
foreach ($file in $sentinels) { $hashes[$file] = (Get-FileHash -LiteralPath $file).Hash }
function Assert-DataPreserved {
  foreach ($file in $sentinels) {
    if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file).Hash -ne $hashes[$file]) { throw "Installer changed user data: $file" }
  }
}
function Invoke-Installer([string]$label, [string[]]$taskArgs) {
  $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NORESTARTAPPLICATIONS', ('/DIR="' + $installRoot + '"'), ('/LOG="' + (Join-Path $testRoot ($label + '.log')) + '"')) + $taskArgs
  $process = Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer $label failed: $($process.ExitCode)" }
  if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'Hydra.exe'))) { throw 'Installed executable missing.' }
  $product = Get-Content -LiteralPath (Join-Path $installRoot 'resources\app\product.json') -Raw | ConvertFrom-Json
  if ($product.nameShort -ne 'Hydra' -or $product.dataFolderName -ne '.hydra') { throw 'Installed product identity changed.' }
  $registry = Get-ItemProperty -LiteralPath $uninstallKey
  if ($registry.DisplayVersion -ne $product.hydraVersion) { throw 'Installer version does not match the bundled Hydra version.' }
  Assert-DataPreserved
}
function Assert-EqualVersionRefused([string]$label) {
  $executable = Join-Path $installRoot 'Hydra.exe'
  $beforeHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash
  $beforeVersion = (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion
  $beforeShortcut = Test-Path -LiteralPath $desktopShortcut
  $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NORESTARTAPPLICATIONS', ('/DIR="' + $installRoot + '"'), ('/LOG="' + (Join-Path $testRoot ($label + '.log')) + '"'))
  $process = Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -eq 0) { throw 'Equal-version reinstall was accepted.' }
  if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $beforeHash -or (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -ne $beforeVersion -or (Test-Path -LiteralPath $desktopShortcut) -ne $beforeShortcut) { throw 'Equal-version refusal changed the installation.' }
  Assert-DataPreserved
}
function Remove-TestInstallation([string]$label) {
  $uninstaller = Join-Path $installRoot 'unins000.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $process = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + (Join-Path $testRoot ($label + '-uninstall.log')) + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
  }
  if ((Test-Path -LiteralPath (Join-Path $installRoot 'Hydra.exe')) -or (Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Uninstall left the executable, shortcut, or registration behind.' }
  Assert-DataPreserved
}
try {
  # Fresh installs exercise the checkbox; equal-version reinstall is now refused.
  Invoke-Installer 'default-unchecked' @('/MERGETASKS="!runcode,!associatewithfiles,!addtopath"')
  if (Test-Path -LiteralPath $desktopShortcut) { throw 'Default installation created a desktop shortcut.' }
  Assert-EqualVersionRefused 'default-equal-refusal'
  Remove-TestInstallation 'default'
  Invoke-Installer 'enable-shortcut' @('/TASKS="desktopicon"')
  if (-not (Test-Path -LiteralPath $desktopShortcut)) { throw 'Selected desktop shortcut is missing.' }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($desktopShortcut)
  if ($shortcut.TargetPath -ne (Join-Path $installRoot 'Hydra.exe')) { throw 'Desktop shortcut targets another application.' }
  Assert-EqualVersionRefused 'selected-equal-refusal'
  Remove-TestInstallation 'selected'
} finally {
  Remove-TestInstallation 'cleanup'
  $logRoot = Join-Path $env:GITHUB_WORKSPACE '.desktop\installer-test-logs'
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  Get-ChildItem -LiteralPath $testRoot -Filter '*.log' | Copy-Item -Destination $logRoot
}
if ((Test-Path -LiteralPath (Join-Path $installRoot 'Hydra.exe')) -or (Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Uninstall left the executable, desktop shortcut, or registration behind.' }
Assert-DataPreserved
Write-Output 'PASS: fresh default-unchecked and selected shortcut installs, equal-version refusal, and uninstall preserve Hydra/VS Code/Cursor data and projects.'
