param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = [IO.Path]::GetFullPath($OutputPath)
$workspacePrefix = $repository.TrimEnd('\') + '\'
if (-not $output.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($output) -ne 'HydraUpdateVerify.exe') {
  throw 'Native helper output must be a Hydra workspace build artifact.'
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ x64 tools are required.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = Join-Path $repository 'native'
$context = '"' + (Join-Path $source 'desktop-update-helper-context.cpp') + '"'
$helper = '"' + (Join-Path $source 'desktop-update-helper.cpp') + '"'
$manifest = Join-Path $source 'desktop-update-helper.manifest'
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
$intermediate = Join-Path $repository '.test-build/native-helper-build'
New-Item -ItemType Directory -Force -Path $intermediate | Out-Null
Push-Location $intermediate
try {
  & cmd.exe /c ('"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc ' + $context + ' ' + $helper + ' /Fe:"' + $output + '"')
  if ($LASTEXITCODE -ne 0) { throw 'Production helper did not compile.' }
  & cmd.exe /c ('"' + $vcvars + '" >nul && mt /nologo -manifest "' + $manifest + '" -outputresource:"' + $output + ';#1"')
  if ($LASTEXITCODE -ne 0) { throw 'Production helper manifest could not be embedded.' }
} finally { Pop-Location }
$bytes = [IO.File]::ReadAllBytes($output)
if ($bytes.Length -lt 1024 -or $bytes[0] -ne 77 -or $bytes[1] -ne 90) { throw 'Production helper PE output is invalid.' }
Write-Output "Built disabled native identity helper: $output"
