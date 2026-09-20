param()
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = Join-Path $repository '.test-build/native-staged-verifier'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ x64 tools are required.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = Join-Path $repository 'native'
$sources = @('desktop-update-locked-path.cpp', 'desktop-update-verifier.cpp', 'desktop-update-staged-verifier.cpp', 'desktop-update-staged-verifier-fixture.cpp') | ForEach-Object { '"' + (Join-Path $source $_) + '"' }
$compile = '"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc ' + ($sources -join ' ') + ' /Fe:desktop-update-staged-verifier-fixture.exe'
Push-Location $output
try {
  & cmd.exe /c $compile
  if ($LASTEXITCODE -ne 0) { throw 'Native staged verifier fixture did not compile.' }
} finally { Pop-Location }
$helper = Join-Path $output 'desktop-update-staged-verifier-fixture.exe'

$candidates = @((Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'), (Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'))
$signed = $null
$signature = $null
foreach ($candidate in $candidates) {
  if (-not (Test-Path -LiteralPath $candidate)) { continue }
  $observed = Get-AuthenticodeSignature -LiteralPath $candidate
  if ($observed.Status -eq 'Valid' -and $observed.SignerCertificate -and $observed.SignerCertificate.NotAfter -gt (Get-Date).AddDays(1)) {
    $signed = $candidate
    $signature = $observed
    break
  }
}
if (-not $signed) { throw 'No currently valid, embedded-signed Windows browser fixture is available.' }
$userData = Join-Path $output ('profile-' + [guid]::NewGuid().ToString('N'))
$id = [guid]::NewGuid().ToString('D')
$operation = Join-Path $userData (Join-Path 'hydra-updater' $id)
New-Item -ItemType Directory -Force -Path $operation | Out-Null
$installer = Join-Path $operation 'HydraSetup.exe'
Copy-Item -LiteralPath $signed -Destination $installer
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
$length = (Get-Item -LiteralPath $installer).Length
$subject = $signature.SignerCertificate.Subject
$thumbprint = $signature.SignerCertificate.Thumbprint

function Assert-Result($root, $operationId, $digest, $bytes, $publisher, $thumb, $accepted) {
  $result = & $helper --fixture $root $operationId $digest $bytes $publisher $thumb
  $code = $LASTEXITCODE
  if ($accepted -and ($code -ne 0 -or $result -notmatch '^accepted;status=0;')) { throw "Valid staged signature refused: $result" }
  if (-not $accepted -and ($code -ne 2 -or $result -notmatch '^refused;')) { throw "Unsafe staged signature accepted or lease invariant failed: $result" }
}
Assert-Result $userData $id $hash $length $subject $thumbprint $true
Assert-Result $userData $id ('0' * 64) $length $subject $thumbprint $false
Assert-Result $userData $id $hash ($length + 1) $subject $thumbprint $false
Assert-Result $userData $id $hash $length 'CN=Wrong Publisher' $thumbprint $false
Assert-Result $userData $id $hash $length $subject ('0' * 40) $false
Assert-Result $userData '../HydraSetup.exe' $hash $length $subject $thumbprint $false
Assert-Result $userData $id.ToUpperInvariant() $hash $length $subject $thumbprint $false

$linked = Join-Path $operation 'HydraSetup-linked.exe'
New-Item -ItemType HardLink -Path $linked -Target $installer | Out-Null
Assert-Result $userData $id $hash $length $subject $thumbprint $false
Remove-Item -LiteralPath $linked
$junctionId = [guid]::NewGuid().ToString('D')
$outside = Join-Path $output ('outside-' + $junctionId)
New-Item -ItemType Directory -Force -Path $outside | Out-Null
Copy-Item -LiteralPath $signed -Destination (Join-Path $outside 'HydraSetup.exe')
$junction = Join-Path (Join-Path $userData 'hydra-updater') $junctionId
New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
Assert-Result $userData $junctionId $hash $length $subject $thumbprint $false

$bytes = [IO.File]::ReadAllBytes($installer)
if ($bytes.Length -lt 8192) { throw 'Signed fixture is too small for the tamper test.' }
$bytes[4096] = $bytes[4096] -bxor 1
[IO.File]::WriteAllBytes($installer, $bytes)
$tamperedHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
Assert-Result $userData $id $tamperedHash $bytes.Length $subject $thumbprint $false
Write-Output 'PASS: one held staged-file lease authenticates bytes and signer; path, hash, length, signer, hardlink, junction, and tamper refusals passed.'
