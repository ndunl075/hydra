[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ManifestPath,
  # This preflight never mutates state; retain a conventional review flag
  # without forwarding PowerShell's common WhatIf preference to hash readers.
  [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$message) { throw "Release evidence blocked: $message" }

function Test-Hash([object]$value) {
  return $value -is [string] -and $value -match '^[a-f0-9]{64}$'
}

function Test-RelativePath([object]$value) {
  if ($value -isnot [string] -or $value.Length -eq 0 -or $value.Length -gt 4096) { return $false }
  if ([System.IO.Path]::IsPathRooted($value) -or $value.Contains([char]0) -or $value.Contains(':')) { return $false }
  return -not ($value -split '[\\/]' | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' })
}

function Require-Properties([object]$value, [string[]]$names, [string]$label) {
  if ($null -eq $value) { Fail "$label is missing." }
  foreach ($name in $names) {
    if ($null -eq $value.PSObject.Properties[$name]) { Fail "$label is missing $name." }
  }
}

function Assert-NoReparsePoint([string]$path, [string]$label) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "$label traverses a reparse point." }
}

function Resolve-EvidenceFile([string]$base, [object]$entry, [string]$label) {
  Require-Properties $entry @('path', 'sha256') $label
  if (-not (Test-RelativePath $entry.path)) { Fail "$label has an unsafe path." }
  if (-not (Test-Hash $entry.sha256)) { Fail "$label has an invalid SHA-256." }
  $canonicalBase = [System.IO.Path]::GetFullPath($base).TrimEnd([char]92, [char]47)
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $canonicalBase $entry.path))
  if (-not $candidate.StartsWith("$canonicalBase$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase)) { Fail "$label escapes the manifest directory." }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { Fail "$label file is unavailable: $($entry.path)." }
  Assert-NoReparsePoint $canonicalBase $label
  $ancestor = $canonicalBase
  foreach ($segment in ($entry.path -split '[\\/]')) {
    $ancestor = Join-Path $ancestor $segment
    Assert-NoReparsePoint $ancestor $label
  }
  $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $entry.sha256) { Fail "$label hash does not match: $($entry.path)." }
  return $candidate
}

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { Fail "manifest is unavailable: $ManifestPath." }
$manifestFile = (Resolve-Path -LiteralPath $ManifestPath).Path
$manifestRoot = Split-Path -Parent $manifestFile
try { $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json }
catch { Fail "manifest is not valid JSON." }

Require-Properties $manifest @('schemaVersion', 'installer', 'runtime', 'shortcutClaims', 'priorVersionBaseline', 'gates') 'manifest'
if ($manifest.schemaVersion -ne 1) { Fail 'unsupported manifest schema version.' }

[void](Resolve-EvidenceFile $manifestRoot $manifest.installer 'installer')
if ($manifest.runtime -isnot [System.Array] -or $manifest.runtime.Count -lt 1) { Fail 'runtime evidence is missing.' }
foreach ($runtime in $manifest.runtime) { [void](Resolve-EvidenceFile $manifestRoot $runtime 'runtime evidence') }

if ($manifest.shortcutClaims -isnot [System.Array] -or $manifest.shortcutClaims.Count -ne 2) { Fail 'exactly selected and unselected shortcut claims are required.' }
$shortcutStates = @{}
foreach ($claim in $manifest.shortcutClaims) {
  Require-Properties $claim @('selected', 'evidence') 'shortcut claim'
  if ($claim.selected -isnot [bool]) { Fail 'shortcut claim selection must be boolean.' }
  $state = [string]$claim.selected
  if ($shortcutStates.ContainsKey($state)) { Fail "duplicate shortcut claim: $state." }
  $shortcutStates[$state] = $true
  [void](Resolve-EvidenceFile $manifestRoot $claim.evidence "shortcut claim ($state)")
}
if (-not ($shortcutStates.ContainsKey('True') -and $shortcutStates.ContainsKey('False'))) { Fail 'both selected and unselected shortcut claims are required.' }

$baseline = $manifest.priorVersionBaseline
Require-Properties $baseline @('version', 'sourceCommit', 'installer') 'prior-version baseline'
if ($baseline.version -isnot [string] -or $baseline.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$') { Fail 'prior-version baseline has an invalid version.' }
if ($baseline.sourceCommit -isnot [string] -or $baseline.sourceCommit -notmatch '^[a-f0-9]{40}$') { Fail 'prior-version baseline has an invalid source commit.' }
[void](Resolve-EvidenceFile $manifestRoot $baseline.installer 'prior-version installer')

$gates = $manifest.gates
Require-Properties $gates @('signing', 'manual') 'release gates'
if ($gates.signing -ne 'verified') { Fail "signing gate is $($gates.signing)." }
if ($gates.manual -isnot [System.Array] -or $gates.manual.Count -lt 1) { Fail 'manual release gates are missing.' }
$gateIds = @{}
foreach ($gate in $gates.manual) {
  Require-Properties $gate @('id', 'status') 'manual release gate'
  if ($gate.id -isnot [string] -or $gate.id -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') { Fail 'manual release gate has an invalid id.' }
  if ($gateIds.ContainsKey($gate.id)) { Fail "duplicate manual release gate: $($gate.id)." }
  $gateIds[$gate.id] = $true
  if ($gate.status -ne 'verified') { Fail "manual release gate $($gate.id) is $($gate.status)." }
}

Write-Output "Release evidence preflight passed: $manifestFile"
