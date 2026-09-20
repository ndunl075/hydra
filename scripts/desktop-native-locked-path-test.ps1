param()
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = Join-Path $repository '.test-build/native-locked-path'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ x64 tools are required.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = Join-Path $repository 'native'
$compile = '"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc "' + (Join-Path $source 'desktop-update-locked-path.cpp') + '" "' + (Join-Path $source 'desktop-update-locked-path-fixture.cpp') + '" /Fe:desktop-update-locked-path-fixture.exe'
Push-Location $output
try {
  & cmd.exe /c $compile
  if ($LASTEXITCODE -ne 0) { throw 'Native locked-path fixture did not compile.' }
} finally { Pop-Location }
$helper = Join-Path $output 'desktop-update-locked-path-fixture.exe'
$userData = Join-Path $output ('profile-' + [guid]::NewGuid().ToString('N'))
$id = [guid]::NewGuid().ToString('D')
$operation = Join-Path $userData (Join-Path 'hydra-updater' $id)
New-Item -ItemType Directory -Force -Path $operation | Out-Null
$installer = Join-Path $operation 'HydraSetup.exe'
Copy-Item -LiteralPath $helper -Destination $installer

function Assert-Result($root, $operationId, $accepted) {
  $result = & $helper --fixture $root $operationId
  $code = $LASTEXITCODE
  if ($accepted -and ($code -ne 0 -or $result -notcontains 'locked' -or $result -notcontains 'released')) { throw "Safe staged path refused: $result" }
  if (-not $accepted -and ($code -eq 0 -or $result -notmatch '^refused;')) { throw "Unsafe staged path accepted: $result" }
}
Assert-Result $userData $id $true
Assert-Result $userData '../HydraSetup.exe' $false
Assert-Result $userData $id.ToUpperInvariant() $false
Assert-Result (Join-Path $userData '..') $id $false

$linked = Join-Path $operation 'HydraSetup-linked.exe'
New-Item -ItemType HardLink -Path $linked -Target $installer | Out-Null
Assert-Result $userData $id $false
Remove-Item -LiteralPath $linked

$junctionId = [guid]::NewGuid().ToString('D')
$outside = Join-Path $output ('outside-' + $junctionId)
New-Item -ItemType Directory -Force -Path $outside | Out-Null
Copy-Item -LiteralPath $helper -Destination (Join-Path $outside 'HydraSetup.exe')
$junction = Join-Path (Join-Path $userData 'hydra-updater') $junctionId
New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
Assert-Result $userData $junctionId $false

$marker = Join-Path $output ('held-' + $id + '.txt')
$beforeHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
$process = Start-Process -FilePath $helper -ArgumentList @('--fixture', ('"' + $userData + '"'), $id, '3000') -WindowStyle Hidden -RedirectStandardOutput $marker -PassThru
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ((-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -ErrorAction SilentlyContinue) -notcontains 'locked') -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker) -notcontains 'locked') { throw 'Native fixture never acquired its lease.' }
  $renamed = $operation + '-renamed'
  try { [IO.Directory]::Move($operation, $renamed); throw 'Operation directory was renamed during the lease.' }
  catch { if ($_.Exception.Message -eq 'Operation directory was renamed during the lease.') { throw } }
  if (-not (Test-Path -LiteralPath $operation)) { throw 'Operation directory disappeared despite the held lease.' }
  try { [IO.Directory]::Move($userData, ($userData + '-renamed')); throw 'Profile directory was renamed during the lease.' }
  catch { if ($_.Exception.Message -eq 'Profile directory was renamed during the lease.') { throw } }
  if (-not (Test-Path -LiteralPath $userData)) { throw 'Profile directory disappeared despite the held lease.' }
  try { [IO.File]::Move($installer, ($installer + '.bak')); throw 'Installer was renamed during the lease.' }
  catch { if ($_.Exception.Message -eq 'Installer was renamed during the lease.') { throw } }
  try { [IO.File]::Open($installer, 'Open', 'Write', 'None').Dispose(); throw 'Installer was opened for writing during the lease.' }
  catch { if ($_.Exception.Message -eq 'Installer was opened for writing during the lease.') { throw } }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Installer bytes changed during the held lease.' }
} finally {
  $finished = $process.WaitForExit(6000)
  if (-not $process.HasExited) { $process.Kill() }
}
if (-not $finished -or (Get-Content -LiteralPath $marker) -notcontains 'released') { throw 'Native lease fixture did not release cleanly.' }
Write-Output 'PASS: canonical operation ID and locked staged file accepted; traversal, hardlink, junction, rename, and writer attempts refused.'
