param(
  [Parameter(Mandatory = $true)][string[]]$RunDirectories,
  [string]$Publisher = 'CN=Hydra Fixture'
)
$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scratch = (Resolve-Path (Join-Path $repository '.test-build\msix-compatibility')).Path
if ($Publisher -notmatch '^CN=[A-Za-z0-9 ._-]+$') { throw 'Fixture publisher must be a simple CN value.' }
$runs = @($RunDirectories | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
if ($runs.Count -ne 2 -or @($runs | Select-Object -Unique).Count -ne $runs.Count) {
  throw 'Batch fixture signing requires exactly two distinct probe runs.'
}
$fixtures = @()
foreach ($run in $runs) {
  if (-not [string]::Equals([IO.Path]::GetDirectoryName($run), $scratch, [StringComparison]::OrdinalIgnoreCase) -or
      -not ([IO.Path]::GetFileName($run) -match '^run-[0-9a-f-]{36}$')) {
    throw 'Fixture signing requires direct disposable MSIX probe runs.'
  }
  $report = Get-Content -LiteralPath (Join-Path $run 'report.json') -Raw | ConvertFrom-Json
  if ($report.status -ne 'unsigned-packaged' -or -not [IO.Path]::IsPathRooted($report.package) -or
      -not [string]::Equals([IO.Path]::GetDirectoryName($report.package), $run, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Probe report does not identify an unsigned package in this run.'
  }
  $manifest = [xml](Get-Content -LiteralPath (Join-Path $run 'stage\AppxManifest.xml') -Raw)
  $identity = $manifest.SelectSingleNode('/*[local-name()="Package"]/*[local-name()="Identity"]')
  if (-not $identity -or $identity.Publisher -ne $Publisher -or
      [string]::IsNullOrWhiteSpace($identity.Name) -or [string]::IsNullOrWhiteSpace($identity.Version) -or
      [string]::IsNullOrWhiteSpace($identity.ProcessorArchitecture)) {
    throw 'Each staged manifest must have a complete identity matching the fixture publisher.'
  }
  $signed = Join-Path $run 'HydraProbe-fixture-signed.msix'
  $certificate = Join-Path $run 'fixture-signing.crt'
  foreach ($file in @($signed, $certificate, (Join-Path $run 'fixture-signing.json'), (Join-Path $run 'fixture-signing.key'), (Join-Path $run 'fixture-signing.pfx'))) {
    if (Test-Path -LiteralPath $file) { throw "Fixture output already exists: $file" }
  }
  $fixtures += [pscustomobject]@{ Run = $run; Report = $report; Unsigned = (Resolve-Path -LiteralPath $report.package).Path; Signed = $signed; Certificate = $certificate; Name = [string]$identity.Name; Version = [string]$identity.Version; Architecture = [string]$identity.ProcessorArchitecture }
}
if (@($fixtures.Name | Select-Object -Unique).Count -ne 1 -or @($fixtures.Architecture | Select-Object -Unique).Count -ne 1) {
  throw 'Batch fixture packages must share their MSIX name and processor architecture.'
}
if (@($fixtures.Version | Select-Object -Unique).Count -ne 2) { throw 'Batch fixture packages must use distinct MSIX versions.' }
$ordered = @($fixtures | Sort-Object { [Version]$_.Version })
if ([Version]$ordered[0].Version -ge [Version]$ordered[1].Version) { throw 'Batch fixture versions must increase.' }
$openssl = (Get-Command openssl.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $openssl) { $openssl = 'C:\Program Files\Git\usr\bin\openssl.exe' }
if (-not (Test-Path -LiteralPath $openssl)) { throw 'OpenSSL is unavailable.' }
$signtool = Join-Path ([IO.Path]::GetDirectoryName($fixtures[0].Report.makeAppx)) 'signtool.exe'
if (-not (Test-Path -LiteralPath $signtool)) { throw 'Matching Windows SDK SignTool is unavailable.' }
$batch = Join-Path $scratch ('signing-' + [guid]::NewGuid().ToString())
$key = Join-Path $batch 'fixture-signing.key'
$sharedCertificate = Join-Path $batch 'fixture-signing.crt'
$pfx = Join-Path $batch 'fixture-signing.pfx'
New-Item -ItemType Directory -Path $batch -ErrorAction Stop | Out-Null

try {
  # OpenSSL writes key-generation progress to stderr even in quiet mode;
  # PowerShell 5 treats that as an error under Stop. Judge its exit code.
  $priorErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $openssl req -quiet -batch -new -x509 -newkey rsa:2048 -nodes -keyout $key -out $sharedCertificate -days 1 `
      -subj ('/' + $Publisher) -addext 'basicConstraints=critical,CA:FALSE' `
      -addext 'keyUsage=critical,digitalSignature' -addext 'extendedKeyUsage=codeSigning' 2>$null
    $certificateExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $priorErrorAction
  }
  if ($certificateExit -ne 0) { throw 'Fixture certificate generation failed.' }
  & $openssl pkcs12 -export -inkey $key -in $sharedCertificate -out $pfx -passout 'pass:'
  if ($LASTEXITCODE -ne 0) { throw 'Fixture PFX generation failed.' }
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($sharedCertificate)
  if ($cert.Subject -ne $Publisher) { throw 'Fixture certificate subject changed.' }
  foreach ($fixture in $ordered) {
    Copy-Item -LiteralPath $fixture.Unsigned -Destination $fixture.Signed -ErrorAction Stop
    & $signtool sign /fd SHA256 /f $pfx $fixture.Signed
    if ($LASTEXITCODE -ne 0) { throw "Fixture MSIX signing failed for $($fixture.Version)." }
    Copy-Item -LiteralPath $sharedCertificate -Destination $fixture.Certificate -ErrorAction Stop
    $record = [ordered]@{
      schemaVersion = 1; status = 'fixture-signed-untrusted'; package = $fixture.Signed
      packageSha256 = (Get-FileHash -LiteralPath $fixture.Signed -Algorithm SHA256).Hash.ToLowerInvariant()
      certificate = $fixture.Certificate; thumbprint = $cert.Thumbprint; publisher = $Publisher
      packageIdentity = $fixture.Name; packageVersion = $fixture.Version; processorArchitecture = $fixture.Architecture
      sourceHydraVersion = $fixture.Report.sourceHydraVersion; currentSourceMatch = $fixture.Report.currentSourceMatch
      installed = $false
    }
    $record | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $fixture.Run 'fixture-signing.json') -Encoding utf8
  }
  $ordered | ForEach-Object { Get-Content -LiteralPath (Join-Path $_.Run 'fixture-signing.json') -Raw | ConvertFrom-Json } | ConvertTo-Json -Depth 3
} finally {
  foreach ($secret in @($key, $pfx)) {
    if (Test-Path -LiteralPath $secret) { Remove-Item -LiteralPath $secret -Force }
  }
  if (Test-Path -LiteralPath $batch) { Remove-Item -LiteralPath $batch -Recurse -Force }
}
