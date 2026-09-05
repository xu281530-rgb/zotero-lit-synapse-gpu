# vector-gpu

Windows x64 CUDA 12.6 worker for Zotero LitSynapse vector similarity scans.

Build with Visual Studio 2022 and a CUDA 12.6 Toolkit:

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 `
  -DCMAKE_CUDA_TOOLKIT_ROOT_DIR="C:\path\to\cuda-12.6"
cmake --build build --config Release
```

The process exposes only the framed `vector-gpu/2` protocol on standard input
and output. A resident snapshot uses either original Float32 vectors or the
existing Int8 representation. It is launched by Zotero from the plugin data
directory; it is not intended to be installed or run separately.
