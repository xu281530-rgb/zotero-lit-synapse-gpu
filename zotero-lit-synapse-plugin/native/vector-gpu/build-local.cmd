@echo off
setlocal EnableExtensions

rem Some launchers provide both Path and PATH entries. nvcc serializes the
rem environment through vcvars64.bat and fails compiler detection in that case.
set "Path="
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%I"
if not defined VSROOT (
  echo Visual Studio 2022 C++ tools were not found. 1>&2
  exit /b 1
)

call "%VSROOT%\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul
if errorlevel 1 exit /b %errorlevel%

set "SOURCE=%~dp0."
set "CUDA_ROOT=%~1"
if not defined CUDA_ROOT set "CUDA_ROOT=%SOURCE%\..\..\.cuda-toolkit\12.6"
set "CMAKE=%VSROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
set "NINJA=%VSROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"

"%CMAKE%" --fresh -S "%SOURCE%" -B "%SOURCE%\build" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_MAKE_PROGRAM="%NINJA%" ^
  -DCMAKE_CUDA_COMPILER="%CUDA_ROOT%\bin\nvcc.exe" ^
  -DCMAKE_CUDA_FLAGS="--allow-unsupported-compiler" ^
  -DCUDAToolkit_ROOT="%CUDA_ROOT%"
if errorlevel 1 exit /b %errorlevel%

"%CMAKE%" --build "%SOURCE%\build" --config Release
exit /b %errorlevel%
