param([string]$HydraInstaller)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = Join-Path $repository '.test-build/native-pe-identity'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ x64 tools are required.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = Join-Path $repository 'native'
$sources = @('desktop-update-pe-identity.cpp', 'desktop-update-pe-identity-fixture.cpp') | ForEach-Object { '"' + (Join-Path $source $_) + '"' }
$compile = '"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc ' + ($sources -join ' ') + ' /Fe:desktop-update-pe-identity-fixture.exe'
Push-Location $output
try {
  & cmd.exe /c $compile
  if ($LASTEXITCODE -ne 0) { throw 'Native PE identity fixture did not compile.' }
} finally { Pop-Location }
$fixture = Join-Path $output 'desktop-update-pe-identity-fixture.exe'
if (-not $HydraInstaller) {
  $HydraInstaller = Join-Path $repository '.desktop/code-oss/.build/win32-x64/user-setup/HydraSetup.exe'
}
if (-not (Test-Path -LiteralPath $HydraInstaller)) { throw "Built Hydra installer missing: $HydraInstaller" }
$version = (Get-Item -LiteralPath $HydraInstaller).VersionInfo.ProductVersion.Trim()
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Built installer has no stable version.' }
function Assert-Identity($path, $expected, $pass) {
  $result = & $fixture --fixture $path $expected
  $code = $LASTEXITCODE
  if ($pass -and ($code -ne 0 -or $result -notmatch '^accepted;')) { throw "Hydra identity refused: $result" }
  if (-not $pass -and ($code -ne 2 -or $result -notmatch '^refused;')) { throw "Wrong identity accepted: $result" }
}
Assert-Identity $HydraInstaller $version $true
Assert-Identity $HydraInstaller '999.0.0' $false
Assert-Identity $HydraInstaller ($version + '-beta.1') $false
Assert-Identity $fixture $version $false
$browser = Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'
if (Test-Path -LiteralPath $browser) { Assert-Identity $browser $version $false }
Write-Output 'PASS: Hydra installer PE identity accepted; wrong version, prerelease, missing resource, and other product refused.'
