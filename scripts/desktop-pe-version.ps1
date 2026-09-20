param([Parameter(Mandatory = $true)][string]$ExecutablePath)

$ErrorActionPreference = 'Stop'
$version = (Get-Item -LiteralPath $ExecutablePath).VersionInfo
[pscustomobject]@{
  ProductName = $version.ProductName
  ProductVersion = $version.ProductVersion
  FileVersion = $version.FileVersion
  CompanyName = $version.CompanyName
} | ConvertTo-Json -Compress
