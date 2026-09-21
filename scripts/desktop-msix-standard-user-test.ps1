param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$env:GITHUB_ACTIONS = [string]$request.environment.githubActions
$env:RUNNER_ENVIRONMENT = [string]$request.environment.runnerEnvironment
$env:RUNNER_OS = [string]$request.environment.runnerOs
$env:GITHUB_WORKSPACE = [string]$request.repository

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Standard-user MSIX tests run only on disposable GitHub-hosted Windows runners.'
}

$resultPath = [string]$request.resultPath
$report = [ordered]@{ schemaVersion = 1; status = 'started'; phase = 'bootstrap'; packageRemoved = $false }
function Save-Report {
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding utf8
}
Save-Report

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$evidence = [ordered]@{
  UserSid = $identity.User.Value
  Administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
$report.token = $evidence
$report.phase = 'token-attested'
Save-Report
$package = $null
try {
  if ($evidence.UserSid -ne [string]$request.expectedUserSid -or $evidence.Administrator) {
    throw 'Fixture child is not the expected non-administrator user.'
  }
  if (Get-AppxPackage -Name ([string]$request.packageName)) { throw 'Fixture user already has the Hydra probe package.' }
  $report.phase = 'installing-package'
  Save-Report
  Add-AppxPackage -Path ([string]$request.packagePath) -ErrorAction Stop
  $package = Get-AppxPackage -Name ([string]$request.packageName)
  if (-not $package -or $package.Version.ToString() -ne [string]$request.expectedVersion) {
    throw 'Fixture user package identity or version changed.'
  }
  $report.phase = 'running-workflow'
  $report.packageFullName = $package.PackageFullName
  $report.packageFamilyName = $package.PackageFamilyName
  $report.installLocation = $package.InstallLocation
  Save-Report
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ([string]$request.workflowScript) `
    -PackageFullName $package.PackageFullName -PackageFamilyName $package.PackageFamilyName `
    -InstallLocation $package.InstallLocation -RunDirectory ([string]$request.runDirectory)
  if ($LASTEXITCODE -ne 0) { throw 'Standard-user packaged workflow acceptance failed.' }
  $workflow = Get-Content -LiteralPath (Join-Path ([string]$request.runDirectory) 'workflow-report.json') -Raw | ConvertFrom-Json
  if ($workflow.status -ne 'passed') { throw 'Standard-user packaged workflow report did not pass.' }
  $report.workflow = $workflow.checks
  $report.phase = 'passed'
  $report.status = 'passed'
} catch {
  $report.phase = 'failed'
  $report.error = $_.Exception.ToString()
} finally {
  $installed = Get-AppxPackage -Name ([string]$request.packageName)
  if ($installed) { Remove-AppxPackage -Package $installed.PackageFullName -ErrorAction Continue }
  $report.packageRemoved = -not [bool](Get-AppxPackage -Name ([string]$request.packageName))
  Save-Report
}
if ($report.status -ne 'passed' -or -not $report.packageRemoved) { throw 'Standard-user MSIX fixture failed; inspect its report.' }
