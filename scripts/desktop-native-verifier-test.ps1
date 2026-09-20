param()
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = Join-Path $repository '.test-build/native-verifier'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ x64 tools are required for the native verifier fixture.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = Join-Path $repository 'native'
$compile = '"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc "' + (Join-Path $source 'desktop-update-verifier.cpp') + '" "' + (Join-Path $source 'desktop-update-verifier-fixture.cpp') + '" /Fe:desktop-update-verifier-fixture.exe'
Push-Location $output
try {
  & cmd.exe /c $compile
  if ($LASTEXITCODE -ne 0) { throw 'Native verifier fixture did not compile.' }
} finally { Pop-Location }
$helper = Join-Path $output 'desktop-update-verifier-fixture.exe'

$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'),
  (Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe')
)
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
$subject = $signature.SignerCertificate.Subject
$thumbprint = $signature.SignerCertificate.Thumbprint

function Invoke-Fixture($path, $hash, $length, $expectedSubject, $expectedThumbprint, $accepted) {
  $outputText = & $helper --fixture $path $hash $length $expectedSubject $expectedThumbprint
  $code = $LASTEXITCODE
  if ($accepted -and ($code -ne 0 -or $outputText -notmatch '^accepted;status=0;')) { throw "Signed fixture refused: $outputText" }
  if (-not $accepted -and ($code -eq 0 -or $outputText -notmatch '^refused;')) { throw "Unsafe fixture accepted or did not report refusal: $outputText" }
}

$hash = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash
$length = (Get-Item -LiteralPath $signed).Length
Invoke-Fixture $signed $hash $length $subject $thumbprint $true
Invoke-Fixture $signed $hash $length 'CN=Wrong Publisher' $thumbprint $false
Invoke-Fixture $signed $hash $length $subject ('0' * 40) $false
Invoke-Fixture $signed ('0' * 64) $length $subject $thumbprint $false
Invoke-Fixture $signed $hash ($length + 1) $subject $thumbprint $false

$unsignedHash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash
$unsignedLength = (Get-Item -LiteralPath $helper).Length
Invoke-Fixture $helper $unsignedHash $unsignedLength $subject $thumbprint $false

$tampered = Join-Path $output 'tampered.exe'
Copy-Item -LiteralPath $signed -Destination $tampered -Force
$bytes = [IO.File]::ReadAllBytes($tampered)
if ($bytes.Length -lt 8192) { throw 'Signed fixture is too small for the tamper test.' }
$bytes[4096] = $bytes[4096] -bxor 1
[IO.File]::WriteAllBytes($tampered, $bytes)
$changedHash = (Get-FileHash -LiteralPath $tampered -Algorithm SHA256).Hash
Invoke-Fixture $tampered $changedHash $bytes.Length $subject $thumbprint $false
$hardlinked = Join-Path $output 'hardlinked.exe'
Copy-Item -LiteralPath $signed -Destination $hardlinked -Force
$otherLink = Join-Path $output 'hardlinked-copy.exe'
New-Item -ItemType HardLink -Path $otherLink -Target $hardlinked | Out-Null
$linkedHash = (Get-FileHash -LiteralPath $hardlinked -Algorithm SHA256).Hash
Invoke-Fixture $hardlinked $linkedHash $length $subject $thumbprint $false
Write-Output 'PASS: signed fixture accepted; wrong signer, thumbprint, hash, length, unsigned, tampered, and multiply linked files refused.'
