param()
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = Join-Path $repository '.test-build/native-inventory-schema'
New-Item -ItemType Directory -Force -Path $output | Out-Null
& node (Join-Path $PSScriptRoot 'desktop-native-inventory-signature-vectors.mjs') $output
if ($LASTEXITCODE -ne 0) { throw 'Inventory schema vectors could not be generated.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ x64 tools are required.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = Join-Path $repository 'native'
$signature = '"' + (Join-Path $source 'desktop-installed-inventory-signature.cpp') + '"'
$schema = '"' + (Join-Path $source 'desktop-installed-inventory-schema.cpp') + '"'
$fixture = '"' + (Join-Path $source 'desktop-installed-inventory-signature-fixture.cpp') + '"'
Push-Location $output
try {
  & cmd.exe /c ('"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc /DHYDRA_INVENTORY_SIGNATURE_FIXTURE /DHYDRA_INVENTORY_SCHEMA_FIXTURE /I"' + $output + '" ' + $signature + ' ' + $schema + ' ' + $fixture + ' /Fe:inventory-schema-fixture.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Native inventory schema fixture did not compile.' }
} finally { Pop-Location }
$binary = Join-Path $output 'inventory-schema-fixture.exe'
function Invoke-Case($name, $accepted) {
  $result = & $binary (Join-Path $output "$name.json") (Join-Path $output "$name.sig") '--validate-schema'
  $code = $LASTEXITCODE
  $message = $result -join ' '
  if ($accepted) {
    if ($code -ne 0 -or $message -notmatch 'schema accepted files=1 version=0.22.0') {
      throw "Native inventory schema acceptance failed for ${name}: $result"
    }
    $expected = Get-Content -LiteralPath (Join-Path $output "$name.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $file = $expected.files[0]
    $path16 = ($file.path.ToCharArray() | ForEach-Object { '{0:x4}' -f [int][char]$_ }) -join ''
    $entry = "entry path16=$path16 bytes=$($file.bytes) sha256=$($file.sha256)"
    if ($message -notmatch $entry) { throw "Native inventory file data differs for ${name}: $result" }
  } elseif ($code -eq 0 -or $message -notmatch '^refused:') {
    throw "Unsafe signed inventory schema accepted for ${name}: $result"
  }
}
foreach ($name in @('valid', 'valid-unicode')) { Invoke-Case $name $true }
foreach ($name in @('malformed', 'wrong-target', 'bad-version', 'unknown-field',
  'duplicate-field', 'whitespace', 'escaped-safe', 'wrong-order', 'empty-files',
  'unsorted-files', 'case-collision', 'unsafe-path', 'oversized-entry',
  'negative-entry', 'fractional-entry', 'wrong-commit', 'long-segment',
  'long-path', 'too-many-files', 'bad-utf8')) {
  Invoke-Case $name $false
}
Write-Output 'PASS: native parser accepts signed canonical inventory and refuses signed schema/path/encoding mutations.'
