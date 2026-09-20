param()
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = Join-Path $repository '.test-build/native-helper-preflight'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ x64 tools are required.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars64.bat'
$source = Join-Path $repository 'native'
$context = '"' + (Join-Path $source 'desktop-update-helper-context.cpp') + '"'
$production = '"' + (Join-Path $source 'desktop-update-helper.cpp') + '"'
$fixture = '"' + (Join-Path $source 'desktop-update-helper-context-fixture.cpp') + '"'
$manifestSource = Join-Path $source 'desktop-update-helper.manifest'
Push-Location $output
try {
  & cmd.exe /c ('"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc ' + $context + ' ' + $production + ' /Fe:HydraUpdateVerify.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Production helper preflight did not compile.' }
  & cmd.exe /c ('"' + $vcvars + '" >nul && mt /nologo -manifest "' + $manifestSource + '" -outputresource:"' + (Join-Path $output 'HydraUpdateVerify.exe') + ';#1"')
  if ($LASTEXITCODE -ne 0) { throw 'Production helper manifest could not be embedded.' }
  & cmd.exe /c ('"' + $vcvars + '" >nul && cl /nologo /std:c++17 /W4 /WX /EHsc /DHYDRA_UPDATE_CONTEXT_FIXTURE ' + $context + ' ' + $fixture + ' /Fe:desktop-update-helper-context-fixture.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Native identity fixture did not compile.' }
} finally { Pop-Location }
$fixtureExe = Join-Path $output 'desktop-update-helper-context-fixture.exe'
& $fixtureExe
if ($LASTEXITCODE -ne 0) { throw "Native identity fixture refused: $LASTEXITCODE" }
$sample = Join-Path $output ('sample-' + [guid]::NewGuid().ToString('N') + '.exe')
[IO.File]::WriteAllBytes($sample, [byte[]](1, 2, 3))
& $fixtureExe --lock $sample
if ($LASTEXITCODE -ne 0) { throw 'Ordinary fixture file could not be held.' }
$otherLink = Join-Path $output ('linked-' + [guid]::NewGuid().ToString('N') + '.exe')
New-Item -ItemType HardLink -Path $otherLink -Target $sample | Out-Null
& $fixtureExe --lock $sample
if ($LASTEXITCODE -ne 2) { throw 'Multiply linked fixture file was accepted.' }
$targetDirectory = Join-Path $output ('target-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $targetDirectory | Out-Null
$targetFile = Join-Path $targetDirectory 'sample.exe'
[IO.File]::WriteAllBytes($targetFile, [byte[]](1, 2, 3))
$junction = Join-Path $output ('junction-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Junction -Path $junction -Target $targetDirectory | Out-Null
& $fixtureExe --lock (Join-Path $junction 'sample.exe')
if ($LASTEXITCODE -ne 2) { throw 'Reparsed fixture ancestor was accepted.' }
$helper = Join-Path $output 'HydraUpdateVerify.exe'
$manifest = Join-Path $output 'HydraUpdateVerify.manifest'
& cmd.exe /c ('"' + $vcvars + '" >nul && mt /nologo -inputresource:"' + $helper + ';#1" -out:"' + $manifest + '"')
if ($LASTEXITCODE -ne 0 -or (Get-Content -LiteralPath $manifest -Raw) -notmatch 'level="asInvoker"') { throw 'Production helper does not embed an asInvoker manifest.' }
& $helper '--fixture' 2>$null
if ($LASTEXITCODE -ne 64) { throw 'Production helper accepted a fixture switch.' }
& $helper '12345678-1234-4234-8234-123456789ABC' 2>$null
if ($LASTEXITCODE -ne 64) { throw 'Production helper accepted a noncanonical ID.' }
& $helper '12345678-1234-4234-8234-123456789abc' 'C:\Temp\installer.exe' 2>$null
if ($LASTEXITCODE -ne 64) { throw 'Production helper accepted extra path arguments.' }
$preflight = Start-Process -FilePath $helper -ArgumentList '12345678-1234-4234-8234-123456789abc' -WindowStyle Hidden -PassThru -Wait
if ($preflight.ExitCode -ne 2) { throw 'Development checkout unexpectedly enabled the production helper.' }
Write-Output 'PASS: native identity preflight rejects unsafe paths, registration, session, and CLI input; production helper stays disabled.'
