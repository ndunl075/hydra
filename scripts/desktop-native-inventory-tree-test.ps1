param()
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = Join-Path $repository '.test-build/native-inventory-tree'
New-Item -ItemType Directory -Force -Path $output | Out-Null
& node (Join-Path $PSScriptRoot 'desktop-native-inventory-signature-vectors.mjs') $output
if ($LASTEXITCODE -ne 0) { throw 'Inventory tree vectors could not be generated.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ x64 tools are required.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = Join-Path $repository 'native'
$sources = @('desktop-installed-inventory-signature.cpp', 'desktop-installed-inventory-schema.cpp',
  'desktop-installed-inventory-tree.cpp', 'desktop-installed-inventory-tree-fixture.cpp') |
  ForEach-Object { '"' + (Join-Path $source $_) + '"' }
Push-Location $output
try {
  & cmd.exe /c ('"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc /DHYDRA_INVENTORY_SIGNATURE_FIXTURE /I"' + $output + '" ' + ($sources -join ' ') + ' /Fe:inventory-tree-fixture.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Native installed-tree fixture did not compile.' }
} finally { Pop-Location }
$binary = Join-Path $output 'inventory-tree-fixture.exe'
$tree = Join-Path $output ('payload-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tree | Out-Null
function Invoke-Case($inventory, $accepted) {
  $result = & $binary (Join-Path $output "$inventory.json") (Join-Path $output "$inventory.sig") $tree
  $code = $LASTEXITCODE
  if ($accepted) {
    if ($code -ne 0 -or ($result -join ' ') -notmatch '^accepted snapshot files=') {
      throw "Native tree acceptance failed: $result (exit $code)"
    }
    Write-Output ($result -join ' ')
    $created = Join-Path $tree 'surprise.txt'
    if (Test-Path -LiteralPath $created) { Remove-Item -LiteralPath $created }
  } elseif ($code -eq 0 -or ($result -join ' ') -notmatch '^refused:') {
    throw "Unsafe tree accepted or fixture failed: $result (exit $code)"
  }
}
$app = Join-Path $tree 'Hydra.exe'
[IO.File]::WriteAllBytes($app, [Text.Encoding]::ASCII.GetBytes('app'))
Invoke-Case 'valid' $true
$bin = Join-Path $tree 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
[IO.File]::WriteAllBytes((Join-Path $bin 'hydra.cmd'), [Text.Encoding]::ASCII.GetBytes('cmd'))
Invoke-Case 'valid-nested' $true
[IO.File]::WriteAllBytes($app, [Text.Encoding]::ASCII.GetBytes('bad'))
Invoke-Case 'valid-nested' $false
[IO.File]::WriteAllBytes($app, [Text.Encoding]::ASCII.GetBytes('app'))
Remove-Item -LiteralPath (Join-Path $bin 'hydra.cmd')
Invoke-Case 'valid-nested' $false
Remove-Item -LiteralPath $bin
$extra = Join-Path $tree 'extra.txt'
[IO.File]::WriteAllBytes($extra, [byte[]](1))
Invoke-Case 'valid' $false
Remove-Item -LiteralPath $extra
$other = Join-Path $output 'other-link.exe'
New-Item -ItemType HardLink -Path $other -Target $app | Out-Null
Invoke-Case 'valid' $false
Remove-Item -LiteralPath $other
$junctionTarget = Join-Path $output 'junction-target'
New-Item -ItemType Directory -Force -Path $junctionTarget | Out-Null
$junction = Join-Path $tree 'junction'
New-Item -ItemType Junction -Path $junction -Target $junctionTarget | Out-Null
Invoke-Case 'valid' $false
Remove-Item -LiteralPath $junction
Invoke-Case 'valid' $true
Write-Output 'PASS: signed inventory yields an exact payload snapshot with held file handles; altered, missing, extra, linked and reparsed payloads refuse.'
