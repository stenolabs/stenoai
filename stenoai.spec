# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for StenoAI Python backend.

This bundles the Python backend into a standalone executable that can be
distributed with the Electron app, eliminating the need for users to have
Python installed.

Includes:
- Parakeet TDT v3 for transcription. On Apple Silicon via parakeet-mlx
  (MLX runtime). On Windows / Linux via onnx-asr (ONNX Runtime, CPU).
  Both ship ~50 MB of bundled code; the ~600 MB (MLX fp16) or ~670 MB
  (ONNX int8) weights download on first use.
- whisper.cpp (pywhispercpp) as the user-selectable engine for languages
  Parakeet can't speak (Chinese, Japanese, Korean, Arabic, Hindi, …) and
  for the legacy post-stop batch pipeline.
- Bundled Ollama binary for summarization (~220MB).

No external dependencies required - users only need to download LLM + ASR models.

Usage:
    pip install pyinstaller
    pyinstaller stenoai.spec

The bundled executable will be in dist/stenoai/
"""

import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_dynamic_libs, copy_metadata

# PyInstaller does not consistently put the spec directory on sys.path when
# evaluating a spec on Windows runners. Make the local build guard importable
# explicitly on every platform.
if SPECPATH not in sys.path:
    sys.path.insert(0, SPECPATH)

from scripts.sidecar_bundle_guard import require_macos_sidecar

# Apple Silicon uses parakeet-mlx for ASR; Windows / Linux use onnx-asr via
# ONNX Runtime. The two backends live in src/_parakeet_{mlx,onnx}.py and
# src/parakeet.py dispatches between them at import time. We skip MLX hidden
# imports off-darwin so PyInstaller doesn't blow up trying to find a module
# that isn't installed.
_IS_DARWIN = sys.platform == "darwin"
_IS_WINDOWS = sys.platform == "win32"

def _macos_is_26_or_newer() -> bool:
    """True on macOS 26+ where the SpeechTranscriber sidecar can be built."""
    if sys.platform != "darwin":
        return False
    try:
        import platform

        ver = platform.mac_ver()[0]
        return int(ver.split(".", 1)[0]) >= 26
    except Exception:
        return False


_REQUIRES_TRANSCRIBE_SIDECAR = _macos_is_26_or_newer()

# UPX is a binary packer that compresses executables. It's safe on macOS but
# routinely flagged as suspicious by Windows Defender + corporate AVs because
# malware abuses it for the same compression benefits. Leaving it on would
# get the unsigned alpha installer quarantined on download for many users.
# Disable UPX on Windows; the bundle is a few MB larger but actually
# installs. macOS keeps UPX so the DMG stays close to its current size.
_USE_UPX = not _IS_WINDOWS

# Collect all hidden imports
hiddenimports = [
    # whisper.cpp bindings — still used by the post-stop batch pipeline AND
    # as the user-selectable engine for non-European languages (Chinese,
    # Japanese, Korean, Arabic, Hindi, …) that Parakeet can't speak.
    'pywhispercpp',
    'pywhispercpp.model',
    'pywhispercpp.constants',

    # HuggingFace hub (both ASR backends pull weights through this)
    'huggingface_hub',

    # ONNX Runtime — runs the bundled Silero VAD model directly on every
    # platform; runs the Parakeet weights too on Windows / Linux via onnx-asr.
    'onnxruntime',
    'onnxruntime.capi',

    # Audio processing
    'sounddevice',
    'soundfile',

    # Ollama client
    'ollama',
    'httpx',

    # Data handling
    'numpy',
    'numpy.core',
    'pydantic',
    'pydantic.fields',
    'pydantic_core',

    # CLI
    'click',

    # Date handling
    'dateutil',
    'dateutil.parser',

    # Standard library modules that might be missed
    'json',
    'pathlib',
    'logging',
    'threading',
    'queue',
    'wave',
    'struct',
    'tempfile',
    'shutil',
    'subprocess',
    'platform',
    'multiprocessing',
]

if _IS_DARWIN:
    # Parakeet MLX (ASR) + MLX runtime — Apple Silicon only
    hiddenimports += [
        'parakeet_mlx',
        'parakeet_mlx.audio',
        'parakeet_mlx.tokenizer',
        'parakeet_mlx.attention',
        'parakeet_mlx.cache',
        'mlx',
        'mlx.core',
        'mlx.nn',
        'mlx.utils',
    ]
else:
    # onnx-asr (ASR via ONNX Runtime) — Windows / Linux. The package is laid
    # out so the top-level `onnx_asr` import pulls everything user-facing;
    # collect_submodules below catches the lazily-imported model adapters.
    hiddenimports += [
        'onnx_asr',
    ]

# Collect submodules — parakeet-mlx + mlx + huggingface_hub all have
# late-bound imports that PyInstaller's static analysis misses, and a partial
# bundle silently breaks at runtime ("module not found" deep inside model
# load). collect_submodules is the safe sledgehammer.
hiddenimports += collect_submodules('pydantic')
hiddenimports += collect_submodules('numpy')
hiddenimports += collect_submodules('huggingface_hub')
hiddenimports += collect_submodules('onnxruntime')

if _IS_DARWIN:
    hiddenimports += collect_submodules('parakeet_mlx')
    hiddenimports += collect_submodules('mlx')
else:
    hiddenimports += collect_submodules('onnx_asr')

# Collect data files
datas = []

# Include the src module
datas += [('src', 'src')]

# Include the scripts dir so the spike command can run from the bundle.
# Kept tiny on purpose — the diagnostic spike-parakeet entrypoint reaches
# in here when the user runs `dist/stenoai/stenoai spike-parakeet`.
datas += [('scripts', 'scripts')]

# Collect data files (tokenizers, configs). parakeet-mlx ships tokenizer
# JSON resources that get loaded by path; onnx-asr ships built-in model
# alias configs the same way.
_DATA_PKGS = ['huggingface_hub', 'pywhispercpp', 'onnxruntime']
if _IS_DARWIN:
    _DATA_PKGS += ['parakeet_mlx', 'mlx']
else:
    _DATA_PKGS += ['onnx_asr']
for pkg in _DATA_PKGS:
    try:
        datas += collect_data_files(pkg)
    except Exception:
        pass

# OpenCC ships the Chinese Simplified↔Traditional conversion dictionaries
# (JSON + text) as package data, loaded by path at runtime. Without bundling
# them the s2t/t2s converters raise on init and zh-Hant output silently falls
# back to Simplified. Pure-Python + cross-platform, so this applies to both the
# macOS and Windows bundles (no platform gate). Guarded so a missing/renamed
# package never breaks the build.
try:
    datas += collect_data_files('opencc')
except Exception:
    pass

# Copy package metadata (.dist-info) for packages that read their own version
# via importlib.metadata at import time. onnx_asr/__init__.py does
# `__version__ = importlib.metadata.version("onnx-asr")` on import — without the
# bundled metadata that raises PackageNotFoundError (an ImportError subclass),
# which surfaces as the misleading "onnx-asr is not installed" at first
# transcription. copy_metadata fixes it. huggingface_hub is copied too since the
# onnx-asr [hub] download path leans on it.
# Only needed off-darwin (onnx-asr reads its own version via importlib.metadata
# at import). macOS gets nothing new here so its bundle is unchanged.
_METADATA_PKGS = [] if _IS_DARWIN else ['onnx-asr', 'huggingface_hub']
for pkg in _METADATA_PKGS:
    try:
        datas += copy_metadata(pkg)
    except Exception:
        pass

# Collect dynamic libraries — MLX ships compiled Metal kernels (.metallib)
# and a libmlx dylib. Without collect_dynamic_libs the bundle imports MLX
# but bombs the first time it touches a Metal op. pywhispercpp ships
# libwhisper.dylib via the same mechanism. onnxruntime ships its native
# session DLLs on Windows; PyInstaller's hidden-import / collect-all
# gotcha for onnxruntime is well-documented (microsoft/onnxruntime#25193)
# so we always run collect_dynamic_libs on it.
binaries = []
_DYLIB_PKGS = ['pywhispercpp', 'onnxruntime']
if _IS_DARWIN:
    _DYLIB_PKGS += ['mlx', 'parakeet_mlx']
for pkg in _DYLIB_PKGS:
    try:
        binaries += collect_dynamic_libs(pkg)
    except Exception:
        pass

# Bundle Ollama binary and libraries.
# Walk bin/ recursively — Ollama for Windows ships its runner libs under
# lib/ollama/ that must be preserved relative to ollama.exe.
# Ollama's Windows bundle ships GPU runner libs under lib/ollama/. As of
# v0.30.8 that's lib/ollama/{cuda_v12,cuda_v13,vulkan} (rocm is no longer
# shipped). They're NVIDIA-/discrete-GPU-only and add multiple GB
# (each cuda_v*/ggml-cuda.dll is ~1.6 GB) — dead weight on the CPU-only path:
# transcription is ONNX-CPU, and the bundled Ollama summarises on the CPU
# runner (ggml-cpu-*.dll / ggml-base.dll, which we keep). Skipping them keeps
# the Windows bundle small enough for the NSIS installer to build (makensis
# can't mmap a multi-GB app .7z). GPU acceleration for NVIDIA users is a
# tracked follow-up (separate build/pack). The substring markers match any
# cuda_vNN dir; rocm is kept as a defensive marker in case a future Ollama
# re-adds it. No-op on macOS — these dirs don't exist there (Metal is built
# into the darwin binary + its mlx_metal_v3/ runner, which we keep).
_OLLAMA_GPU_MARKERS = ('lib/ollama/cuda', 'lib/ollama/rocm', 'lib/ollama/vulkan')

# On darwin, Ollama's runner tree is routed into a COLLECT-stage DATA TOC
# (`ollama_datas`) instead of `Analysis.binaries`. This is load-bearing, not a
# style choice - DO NOT "simplify" it back into binaries/Analysis(datas=...):
#   Both Ollama and the pip `mlx` package ship their OWN, ABI-INCOMPATIBLE build
#   of `libmlx.dylib`. Ollama's copies live beside `libmlxc.dylib` in
#   `mlx_metal_v*/` with an `@loader_path` rpath, so each one resolves
#   `@rpath/libmlx.dylib` to its own co-located sibling. If these files go
#   through Analysis's binary-dependency walk, PyInstaller rewrites their
#   LC_RPATHs and dedups `libmlx.dylib` by basename onto ONE shared file at
#   `_internal/libmlx.dylib` (the pip build), so every MLX-tagged Ollama model
#   call dies at runtime with a missing-symbol error (mlx::core::astype). And
#   putting them in `Analysis(datas=...)` doesn't help: PyInstaller 6.x
#   content-sniffs each `datas` entry and silently reclassifies anything that
#   looks like a binary back into `binaries`, re-triggering the same rewrite.
#   Only raw COLLECT-stage TOC entries are copied verbatim (shutil.copyfile, no
#   dependency analysis, no rpath rewrite, no re-signing), preserving Ollama's
#   self-contained runner exactly as shipped. COLLECT still chmods 0o755 any
#   DATA entry whose source has the exec bit, so the ollama binary + dylibs stay
#   executable. Windows keeps the old `binaries` path (no libmlx collision there
#   - the GPU runner libs are pruned above and there's no pip-mlx build).
ollama_datas: list[tuple[str, str, str]] = []
ollama_bin_dir = os.path.join(SPECPATH, 'bin')
required_macos_sidecars: dict[str, Path | None] = {
    'steno-diarize': require_macos_sidecar(
        Path(ollama_bin_dir) / 'steno-diarize',
        name='speaker-diarization',
        build_script='scripts/build-diarize-sidecar.sh',
        platform=sys.platform,
    ),
}
if _REQUIRES_TRANSCRIBE_SIDECAR:
    required_macos_sidecars['steno-transcribe'] = require_macos_sidecar(
        Path(ollama_bin_dir) / 'steno-transcribe',
        name='Apple transcription',
        build_script='scripts/build-transcribe-sidecar.sh',
        platform=sys.platform,
    )
else:
    # On macOS <26 the transcribe sidecar cannot be built (needs macOS 26 SDK);
    # don't fail the bundle. The runtime (apple_speech_supported) will keep
    # the engine unavailable there, and Parakeet/Whisper remain the defaults.
    required_macos_sidecars['steno-transcribe'] = None
if os.path.exists(ollama_bin_dir):
    for root, _dirs, files in os.walk(ollama_bin_dir):
        for filename in files:
            filepath = os.path.join(root, filename)
            rel = os.path.relpath(filepath, ollama_bin_dir)
            rel_fs = rel.replace(os.sep, '/').lower()
            if any(marker in rel_fs for marker in _OLLAMA_GPU_MARKERS):
                continue  # skip GPU runner libs (CUDA/ROCm/Vulkan)
            rel_dir = os.path.dirname(rel)
            base = os.path.basename(filename).lower()
            if base in ('ffmpeg', 'ffmpeg.exe'):
                # Put ffmpeg at the root of the bundle for easy PATH access
                binaries.append((filepath, '.'))
            elif (
                base in required_macos_sidecars
                and _IS_DARWIN
                and required_macos_sidecars[base] is not None
            ):
                # Required macOS Swift sidecars follow ffmpeg into PyInstaller's
                # _internal directory, which each runtime resolver probes. The
                # guards above fail the build rather than shipping a latent
                # first-use error.
                binaries.append((filepath, '.'))
            elif _IS_DARWIN:
                # COLLECT DATA TOC 3-tuple: (dest_path_including_filename,
                # abs_src_path, 'DATA'). Everything lives under ollama/,
                # preserving subdirs like mlx_metal_v*/.
                dest_name = os.path.join('ollama', rel) if rel_dir else os.path.join('ollama', filename)
                ollama_datas.append((dest_name, filepath, 'DATA'))
            else:
                # Windows/Linux: unchanged - everything else lives under ollama/
                # (preserving subdirs like lib/ollama/).
                dest = 'ollama' if not rel_dir else os.path.join('ollama', rel_dir)
                binaries.append((filepath, dest))

block_cipher = None

a = Analysis(
    ['simple_recorder.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude PyTorch and related heavy packages (not needed with whisper.cpp)
        'torch',
        'torchvision',
        'torchaudio',
        'tensorflow',
        'keras',
        'transformers',
        # Exclude other unnecessary packages
        'matplotlib',
        'PIL',
        'tkinter',
        'PyQt5',
        'PyQt6',
        'PySide2',
        'PySide6',
        'IPython',
        'jupyter',
        'notebook',
        'sphinx',
        'pytest',
        # `unittest` is kept in the bundle now — parakeet-mlx (via librosa /
        # scipy) lazy-imports it during from_pretrained; excluding it makes
        # model loading fail with "No module named 'unittest'".
        # openai-whisper (PyTorch) is excluded — we use parakeet for live and
        # whisper.cpp (via pywhispercpp) for batch, neither needs the
        # PyTorch-based reference implementation.
        'whisper',
        'tiktoken',
        'tiktoken_ext',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='stenoai',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=_USE_UPX,
    console=True,  # Keep console for CLI usage
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    # Ollama's runner tree, verbatim (darwin only; empty list off-darwin, so
    # this is an unconditional no-op there). See the ollama_datas rationale
    # above for why these MUST bypass Analysis and land at the COLLECT stage.
    ollama_datas,
    strip=False,
    upx=_USE_UPX,
    upx_exclude=[],
    name='stenoai',
)
