param(
  [Parameter(Mandatory = $true)][string]$InstallLocation,
  [Parameter(Mandatory = $true)][string]$RunDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'MSIX workflow fixture provisioning runs only on disposable GitHub-hosted Windows runners.'
}
$repository = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
$run = (Resolve-Path -LiteralPath $RunDirectory).Path
$install = (Resolve-Path -LiteralPath $InstallLocation).Path
if (-not $run.StartsWith((Join-Path $repository '.test-build\msix-compatibility') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Workflow run directory is outside MSIX scratch.'
}
if (-not $install.StartsWith((Join-Path $env:ProgramFiles 'WindowsApps') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Workflow install location is outside WindowsApps.'
}

$unicodeSuffix = [string][char]0x00FC
$workflowRoot = Join-Path $run ('workflow spaces ' + $unicodeSuffix)
$workspace = Join-Path $workflowRoot ('workspace ' + $unicodeSuffix)
$userData = Join-Path $workflowRoot 'user data'
$extensions = Join-Path $workflowRoot 'extensions'
$fixture = Join-Path $repository 'tests\fixtures\msix-workflow-extension'
$standalone = Join-Path $repository '.desktop\VSCode-win32-x64'
$vsix = Join-Path $workflowRoot 'hydra-msix-workflow-1.0.0.vsix'
$reportPath = Join-Path $run 'workflow-provision-report.json'
$report = [ordered]@{ schemaVersion = 1; status = 'started'; phase = 'packaging-fixture';
  invocation = 'version-matched-standalone-cli' }
function ConvertTo-WindowsArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
function Join-WindowsArguments([string[]]$Values) {
  return (($Values | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' ')
}
function Save-ProvisionReport {
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
Save-ProvisionReport

try {
  New-Item -ItemType Directory -Path $workspace, $userData, $extensions -Force | Out-Null
  Push-Location $fixture
  try {
    & (Join-Path $repository 'node_modules\.bin\vsce.cmd') package --no-dependencies --allow-missing-repository --skip-license --out $vsix
    if ($LASTEXITCODE -ne 0) { throw 'Offline workflow fixture VSIX packaging failed.' }
  } finally { Pop-Location }

  $standaloneProduct = Get-Content -LiteralPath (Join-Path $standalone 'resources\app\product.json') -Raw | ConvertFrom-Json
  $installedProduct = Get-Content -LiteralPath (Join-Path $install 'resources\app\product.json') -Raw | ConvertFrom-Json
  if ($standaloneProduct.hydraVersion -ne $installedProduct.hydraVersion -or
      $standaloneProduct.commit -ne $installedProduct.commit) {
    throw 'Standalone fixture provisioner does not match the installed package runtime.'
  }

  $report.phase = 'installing-fixture'
  Save-ProvisionReport
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path $standalone 'Hydra.exe'
  $start.Arguments = Join-WindowsArguments @((Join-Path $standalone 'resources\app\out\cli.js'),
    '--install-extension', $vsix, '--force', '--user-data-dir', $userData, '--extensions-dir', $extensions)
  $start.WorkingDirectory = $repository
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
  [void]$start.EnvironmentVariables.Remove('VSCODE_DEV')
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Version-matched Hydra CLI process did not start.' }
  $report.processId = $process.Id
  Save-ProvisionReport
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    $process.WaitForExit()
    throw 'Version-matched Hydra CLI process timed out after 120 seconds.'
  }
  $stdout.Wait()
  $stderr.Wait()
  $output = (($stdout.Result, $stderr.Result | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine)
  $exitCode = $process.ExitCode
  $report.exitCode = $exitCode
  $report.output = $output.Trim()
  if ($exitCode -ne 0) { throw "Version-matched Hydra CLI exited with code $exitCode. $output" }

  $installedFixture = @(Get-ChildItem -LiteralPath $extensions -Directory -ErrorAction SilentlyContinue |
    Where-Object Name -Like 'hydra-msix-workflow.hydra-msix-workflow-*')
  if ($installedFixture.Count -ne 1) { throw 'Version-matched Hydra CLI did not install exactly one workflow fixture.' }
  $installedManifest = Join-Path $installedFixture[0].FullName 'package.json'
  $installedEntrypoint = Join-Path $installedFixture[0].FullName 'extension.cjs'
  $fixtureManifest = Join-Path $fixture 'package.json'
  $fixtureEntrypoint = Join-Path $fixture 'extension.cjs'
  $installedMetadata = Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json
  $fixtureMetadata = Get-Content -LiteralPath $fixtureManifest -Raw | ConvertFrom-Json
  $installMetadata = $installedMetadata.__metadata
  if (-not $installMetadata) { throw 'Installed fixture extension lacks Code OSS install metadata.' }
  $installedMetadata.PSObject.Properties.Remove('__metadata')
  if (($installedMetadata | ConvertTo-Json -Depth 20 -Compress) -cne
      ($fixtureMetadata | ConvertTo-Json -Depth 20 -Compress)) {
    throw 'Installed fixture extension manifest changed beyond Code OSS install metadata.'
  }
  if ((Get-FileHash -LiteralPath $fixtureEntrypoint -Algorithm SHA256).Hash -ne
      (Get-FileHash -LiteralPath $installedEntrypoint -Algorithm SHA256).Hash) {
    throw 'Installed fixture extension entrypoint bytes changed.'
  }
  $report.hydraVersion = $standaloneProduct.hydraVersion
  $report.commit = $standaloneProduct.commit
  $report.extensionPath = $installedFixture[0].FullName
  $report.publisher = $installedMetadata.publisher
  $report.name = $installedMetadata.name
  $report.version = $installedMetadata.version
  $report.installMetadata = $installMetadata
  $report.sourceManifestSha256 = (Get-FileHash $fixtureManifest -Algorithm SHA256).Hash.ToLowerInvariant()
  $report.installedManifestSha256 = (Get-FileHash $installedManifest -Algorithm SHA256).Hash.ToLowerInvariant()
  $report.entrypointSha256 = (Get-FileHash $installedEntrypoint -Algorithm SHA256).Hash.ToLowerInvariant()
  $report.phase = 'complete'
  $report.status = 'passed'
} catch {
  $report.status = 'failed'
  $report.error = $_.Exception.ToString()
  throw
} finally {
  Save-ProvisionReport
}
Write-Output 'PASS: version-matched standalone Hydra CLI provisioned the exact offline workflow fixture.'
