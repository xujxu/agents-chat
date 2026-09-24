param(
    [Parameter(Mandatory)]
    [ValidateSet('sensevoice-small-q8', 'whisper-base-q5_1')]
    [string] $Model
)
$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$work = Join-Path $repo '.data/voice-native-work'
$package = Join-Path $repo '.data/windows-candidate'
if ((Test-Path $work) -or (Test-Path $package)) { throw 'Candidate build requires a fresh workspace.' }
foreach ($folder in @("$work/source", "$work/llama", "$package/bin", "$package/models", "$package/licenses", "$package/provenance")) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
}

function Invoke-Checked([string] $Program, [string[]] $Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
function Fetch([string] $Url, [string] $Destination) {
    Invoke-Checked 'curl.exe' @('--fail', '--location', '--retry', '3', '--max-time', '600', $Url, '-o', $Destination)
}
function Check-Hash([string] $File, [string] $Expected) {
    if ((Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) {
        throw "Pinned asset checksum mismatch: $(Split-Path $File -Leaf)"
    }
}

$senseRev = '3ff9259aade4f7e4360645df28cad8f81959ee91'
$llamaRev = '803b7fcae893e9caaee3921779628fef83ac0965'
$whisperRev = '5670d5c0bbcb148feabef84400a07cfca9aa3b30'
$weightRev = '90c1c61912018b70ada0fcc024ea24aca62f2e63'
if ($Model -eq 'sensevoice-small-q8') {
    Fetch "https://github.com/modelscope/FunASR/archive/$senseRev.tar.gz" "$work/source.tar.gz"
    Fetch "https://github.com/ggml-org/llama.cpp/archive/$llamaRev.tar.gz" "$work/llama.tar.gz"
    Invoke-Checked 'tar' @('-xzf', "$work/source.tar.gz", '--strip-components=1', '-C', "$work/source")
    Invoke-Checked 'tar' @('-xzf', "$work/llama.tar.gz", '--strip-components=1', '-C', "$work/llama")
    Fetch "https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/$weightRev/sensevoice-small-q8.gguf" "$package/models/sensevoice-small-q8.gguf"
    Check-Hash "$package/models/sensevoice-small-q8.gguf" '4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5'
    Copy-Item "$work/source/LICENSE" "$package/licenses/FunASR-MIT.txt"
    Copy-Item "$work/llama/LICENSE" "$package/licenses/llama-MIT.txt"
    Copy-Item "$work/llama/licenses" "$package/licenses/llama-dependencies" -Recurse
    Copy-Item "$work/source/runtime/llama.cpp/funasr-common/miniaudio.h" "$package/licenses/miniaudio.h"
    Fetch "https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/raw/$weightRev/README.md" "$package/licenses/model-card.txt"
    Fetch 'https://www.apache.org/licenses/LICENSE-2.0.txt' "$package/licenses/Apache-2.0.txt"
    Invoke-Checked 'python' @('scripts/voice_sense_native_patch.py',
        "$work/source/runtime/llama.cpp/sensevoice/funasr-sensevoice/funasr-sensevoice.cpp",
        "$package/provenance/native-thread-error.patch")
    $source = "$work/source/runtime/llama.cpp"
    $target = 'llama-funasr-sensevoice'
    $extra = @("-DFETCHCONTENT_SOURCE_DIR_LLAMA=$work/llama")
} else {
    Fetch "https://github.com/ggml-org/whisper.cpp/archive/$whisperRev.tar.gz" "$work/source.tar.gz"
    Invoke-Checked 'tar' @('-xzf', "$work/source.tar.gz", '--strip-components=1', '-C', "$work/source")
    Fetch 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin' "$package/models/ggml-base-q5_1.bin"
    Check-Hash "$package/models/ggml-base-q5_1.bin" '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'
    Copy-Item "$work/source/LICENSE" "$package/licenses/whisper-MIT.txt"
    Fetch 'https://raw.githubusercontent.com/openai/whisper/6e3be77e1a105e59086e3e21ff5f609fd6fa89a5/LICENSE' "$package/licenses/whisper-weights-MIT.txt"
    $source = "$work/source"
    $target = 'whisper-cli'
    $extra = @('-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', '-DWHISPER_CURL=OFF')
}

$manifest = (Join-Path $repo 'scripts/voice/windows/utf8.manifest').Replace('\', '/')
$options = @('-S', $source, '-B', "$work/build", '-G', 'Visual Studio 17 2022', '-A', 'x64',
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
    '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
    '-DGGML_NATIVE=OFF', '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON',
    '-DGGML_F16C=ON', '-DGGML_BMI2=ON', '-DGGML_AVX512=OFF',
    '-DGGML_OPENMP=OFF', '-DGGML_CUDA=OFF', '-DGGML_VULKAN=OFF',
    '-DGGML_BLAS=OFF', '-DGGML_BACKEND_DL=OFF',
    "-DCMAKE_EXE_LINKER_FLAGS=/MANIFEST:EMBED /MANIFESTINPUT:$manifest") + $extra
Invoke-Checked 'cmake' $options
Invoke-Checked 'cmake' @('--build', "$work/build", '--config', 'Release', '--target', $target, '--parallel', '2')
Copy-Item "$work/build/bin/Release/$target.exe" "$package/bin/$target.exe"
Copy-Item "$work/build/CMakeCache.txt" "$package/provenance/CMakeCache.txt"
Copy-Item $manifest "$package/provenance/utf8.manifest"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Visual Studio 2022 x64 toolchain missing.' }
$devcmd = Join-Path $vs 'Common7/Tools/VsDevCmd.bat'
function Invoke-Compiler([string] $Command, [string] $Log) {
    & cmd /d /s /c "`"$devcmd`" -arch=x64 -host_arch=x64 && $Command" 2>&1 | Tee-Object -FilePath $Log
    if ($LASTEXITCODE -ne 0) { throw "Native tool failed: see $(Split-Path $Log -Leaf)" }
}
$helper = "`"$package/bin/voice-job.exe`""
Invoke-Compiler "cl /nologo /Bv /W4 /WX /EHsc /std:c++17 /MT /DUNICODE /D_UNICODE scripts\voice\windows\voice-job.cpp scripts\voice\windows\voice-files.cpp /Fo`"$work/`" /Fe$helper /link Advapi32.lib" "$package/provenance/helper-build.txt"
foreach ($binary in Get-ChildItem "$package/bin/*.exe") {
    $log = "$package/provenance/$($binary.BaseName)-dependencies.txt"
    Invoke-Compiler "dumpbin /dependents `"$($binary.FullName)`"" $log
    $dependencies = [regex]::Matches((Get-Content $log -Raw), '(?im)^\s+([a-z0-9_.-]+\.dll)\s*$') |
        ForEach-Object { $_.Groups[1].Value }
    if (!$dependencies) { throw 'No PE dependency evidence found.' }
    foreach ($dll in $dependencies) {
        if ($dll -notmatch '^(KERNEL32|ADVAPI32|USER32|SHELL32|OLE32|OLEAUT32|WS2_32|BCRYPT|CRYPT32|PSAPI|SHLWAPI|NTDLL|UCRTBASE|MSVCRT)\.dll$' -and $dll -notmatch '^api-ms-win-.*\.dll$') {
            throw "Unexpected non-system runtime dependency: $dll"
        }
    }
}
Invoke-Compiler "mt -nologo -inputresource:`"$package/bin/$target.exe;#1`" -out:`"$package/provenance/embedded.manifest`"" "$work/manifest-extraction.txt"
if ((Get-Content "$package/provenance/embedded.manifest" -Raw) -notmatch 'activeCodePage.*UTF-8') {
    throw 'Native engine does not contain the required UTF-8 manifest.'
}
Fetch "https://raw.githubusercontent.com/ggml-org/whisper.cpp/$whisperRev/samples/jfk.wav" "$work/jfk.wav"

$os = Get-CimInstance Win32_OperatingSystem
@{
    applicationCommit = $env:GITHUB_SHA
    modelId = $Model
    sourceRevision = $(if ($Model -eq 'sensevoice-small-q8') { $senseRev } else { $whisperRev })
    llamaRevision = $(if ($Model -eq 'sensevoice-small-q8') { $llamaRev } else { $null })
    runnerOS = $os.Caption
    osVersion = $os.Version
    architecture = $os.OSArchitecture
    compiler = 'MSVC Visual Studio 2022 x64; exact version in helper-build.txt and CMakeCache.txt'
    cRuntime = 'MultiThreaded static MSVC runtime; system Windows DLLs only'
    sourceArchives = @(Get-ChildItem "$work/*.tar.gz" | ForEach-Object {
        @{ name = $_.Name; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
    })
    scope = 'CI real-engine smoke candidate; not installer admitted or release approved'
} | ConvertTo-Json -Depth 4 | Set-Content "$package/provenance/build.json" -Encoding utf8
@'
These are private CI build candidates, not a redistributable product release.
Preserve the upstream license files and model identity evidence in this folder.
MSVC static C/C++ runtime code is included; the complete binary is not MIT-only.
Microsoft runtime redistribution terms require release review:
https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
Application-owned voice-job helper redistribution permission also requires
resolution: this checkout has no root application LICENSE file.
No blanket licensing or public-distribution approval is claimed by this build.
'@ | Set-Content "$package/licenses/RELEASE-REVIEW-REQUIRED.txt" -Encoding utf8
Invoke-Checked 'node' @('scripts/voice/windows/candidate-inventory.mjs', $package, $Model)
Invoke-Checked 'node' @('scripts/voice/package-manifest.mjs', $package, $Model, 'windows-x64')
