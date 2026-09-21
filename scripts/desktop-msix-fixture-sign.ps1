param(
  [Parameter(Mandatory = $true)][string]$RunDirectory,
  [string]$Publisher = 'CN=Hydra Fixture'
)
$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scratch = (Resolve-Path (Join-Path $repository '.test-build\msix-compatibility')).Path
$run = (Resolve-Path -LiteralPath $RunDirectory).Path
if (-not [string]::Equals([IO.Path]::GetDirectoryName($run), $scratch, [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFileName($run) -match '^run-[0-9a-f-]{36}$')) {
  throw 'Fixture signing requires a direct disposable MSIX probe run.'
}
$report = Get-Content -LiteralPath (Join-Path $run 'report.json') -Raw | ConvertFrom-Json
if ($report.status -ne 'unsigned-packaged' -or -not [IO.Path]::IsPathRooted($report.package) -or
    -not [string]::Equals([IO.Path]::GetDirectoryName($report.package), $run, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Probe report does not identify an unsigned package in this run.'
}
$unsigned = (Resolve-Path -LiteralPath $report.package).Path
if ($Publisher -notmatch '^CN=[A-Za-z0-9 ._-]+$') { throw 'Fixture publisher must be a simple CN value.' }
$manifest = [xml](Get-Content -LiteralPath (Join-Path $run 'stage\AppxManifest.xml') -Raw)
$identity = $manifest.SelectSingleNode('/*[local-name()="Package"]/*[local-name()="Identity"]')
if (-not $identity -or $identity.Publisher -ne $Publisher) {
  throw 'Fixture certificate publisher must exactly match the staged MSIX manifest publisher.'
}
$signed = Join-Path $run 'HydraProbe-fixture-signed.msix'
$key = Join-Path $run 'fixture-signing.key'
$certificate = Join-Path $run 'fixture-signing.crt'
$pfx = Join-Path $run 'fixture-signing.pfx'
foreach ($file in @($signed, $key, $certificate, $pfx)) {
  if (Test-Path -LiteralPath $file) { throw "Fixture output already exists: $file" }
}
$openssl = (Get-Command openssl.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $openssl) { $openssl = 'C:\Program Files\Git\usr\bin\openssl.exe' }
if (-not (Test-Path -LiteralPath $openssl)) { throw 'OpenSSL is unavailable.' }
$signtool = Join-Path ([IO.Path]::GetDirectoryName($report.makeAppx)) 'signtool.exe'
if (-not (Test-Path -LiteralPath $signtool)) { throw 'Matching Windows SDK SignTool is unavailable.' }

try {
  Copy-Item -LiteralPath $unsigned -Destination $signed -ErrorAction Stop
  # OpenSSL writes key-generation progress to stderr even in quiet mode;
  # PowerShell 5 treats that as an error under Stop. Judge its exit code.
  $priorErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $openssl req -quiet -batch -new -x509 -newkey rsa:2048 -nodes -keyout $key -out $certificate -days 1 `
      -subj ('/' + $Publisher) -addext 'basicConstraints=critical,CA:FALSE' `
      -addext 'keyUsage=critical,digitalSignature' -addext 'extendedKeyUsage=codeSigning' 2>$null
    $certificateExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $priorErrorAction
  }
  if ($certificateExit -ne 0) { throw 'Fixture certificate generation failed.' }
  & $openssl pkcs12 -export -inkey $key -in $certificate -out $pfx -passout 'pass:'
  if ($LASTEXITCODE -ne 0) { throw 'Fixture PFX generation failed.' }
  & $signtool sign /fd SHA256 /f $pfx $signed
  if ($LASTEXITCODE -ne 0) { throw 'Fixture MSIX signing failed.' }
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificate)
  if ($cert.Subject -ne $Publisher) { throw 'Fixture certificate subject changed.' }
  $record = [ordered]@{
    schemaVersion = 1
    status = 'fixture-signed-untrusted'
    package = $signed
    packageSha256 = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash.ToLowerInvariant()
    certificate = $certificate
    thumbprint = $cert.Thumbprint
    publisher = $Publisher
    sourceHydraVersion = $report.sourceHydraVersion
    currentSourceMatch = $report.currentSourceMatch
    installed = $false
  }
  $record | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $run 'fixture-signing.json') -Encoding utf8
  $record | ConvertTo-Json -Depth 3
} finally {
  foreach ($secret in @($key, $pfx)) {
    if (Test-Path -LiteralPath $secret) { Remove-Item -LiteralPath $secret -Force }
  }
}
