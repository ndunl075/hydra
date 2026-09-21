param()
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = Join-Path $repository '.test-build/native-inventory-signature'
New-Item -ItemType Directory -Force -Path $output | Out-Null
& node (Join-Path $PSScriptRoot 'desktop-native-inventory-signature-vectors.mjs') $output
if ($LASTEXITCODE -ne 0) { throw 'Inventory signature vectors could not be generated.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ x64 tools are required for the native inventory signature fixture.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = Join-Path $repository 'native'
$verifier = '"' + (Join-Path $source 'desktop-installed-inventory-signature.cpp') + '"'
$fixture = '"' + (Join-Path $source 'desktop-installed-inventory-signature-fixture.cpp') + '"'
Push-Location $output
try {
  & cmd.exe /c ('"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc /DHYDRA_INVENTORY_SIGNATURE_FIXTURE /I"' + $output + '" ' + $verifier + ' ' + $fixture + ' /Fe:inventory-signature-fixture.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Native inventory signature fixture did not compile.' }
  & cmd.exe /c ('"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc ' + $verifier + ' ' + $fixture + ' /Fe:inventory-signature-production-policy.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Production inventory signature policy fixture did not compile.' }
} finally { Pop-Location }

$native = Join-Path $output 'inventory-signature-fixture.exe'
$production = Join-Path $output 'inventory-signature-production-policy.exe'
function Invoke-Case($binary, $inventory, $signature, $accepted, $extra = @()) {
  $result = & $binary (Join-Path $output $inventory) (Join-Path $output $signature) @extra
  $code = $LASTEXITCODE
  if ($accepted) {
    if ($code -ne 0 -or $result -notmatch '^accepted bytes=') { throw "Native inventory signature acceptance failed: $result" }
  } elseif ($code -eq 0 -or $result -notmatch '^refused:') {
    throw "Unsafe inventory signature accepted or refusal missing: $result"
  }
  return $result
}
$valid = Invoke-Case $native 'valid.json' 'valid.sig' $true
$expected = (Get-FileHash -LiteralPath (Join-Path $output 'valid.json') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($valid -notmatch "sha256=$expected$") { throw 'Authenticated byte digest differs from the fixture payload.' }
foreach ($name in @('tampered.json', 'appended.json', 'alternate.json', 'empty.json', 'oversized.json')) {
  Invoke-Case $native $name 'valid.sig' $false | Out-Null
}
foreach ($name in @('wrong-key.sig', 'wrong-id.sig', 'wrong-signature.sig', 'wrong-domain.sig', 'truncated.sig', 'overlong.sig', 'wrong-format.sig', 'der.sig')) {
  Invoke-Case $native 'valid.json' $name $false | Out-Null
}
Invoke-Case $native 'valid.json' 'valid.sig' $false @('--invalid-root') | Out-Null
Invoke-Case $native 'malformed.json' 'malformed.sig' $true | Out-Null
Invoke-Case $production 'valid.json' 'valid.sig' $false | Out-Null
Write-Output 'PASS: real CNG accepts fixture-signed bytes; mutations, formats, keys, policy and bounds refuse; production has no trusted root.'
