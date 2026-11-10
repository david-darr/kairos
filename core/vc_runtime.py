"""Whether Windows can load the Microsoft Visual C++ runtime the local speech and model engines are built against.

onnxruntime (Kokoro, Smart Turn), pywhispercpp (dictation) and llama-cpp-python import MSVCP140.dll and MSVCP140_1.dll.
The bundled Python carries only vcruntime140*.dll, so those two come from the Microsoft Visual C++ 2015-2022
Redistributable, which the Windows installer runs when a PC lacks it (electron/vcredist.nsh). If that was declined or
failed, importing those engines dies inside Windows' DLL loader with a traceback nobody can act on. This checks the two
DLLs up front, the same way Windows will look for them, so Settings > Speech can say the one thing that fixes it.

Not Windows: always fine (other platforms ship their C++ runtime with the system).
"""
import functools
import sys

# What Settings > Speech shows, word for word.
MESSAGE = "Install the Microsoft Visual C++ runtime"
# Microsoft's own permanent link to the current x64 package.
DOWNLOAD_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
DLLS = ("msvcp140.dll", "msvcp140_1.dll")


def _load(name: str) -> bool:
    import ctypes
    try:
        ctypes.WinDLL(name)
        return True
    except OSError:
        return False


@functools.lru_cache(maxsize=1)
def missing_dlls() -> tuple[str, ...]:
    """The runtime DLLs Windows cannot load, empty when all load (and always empty off Windows). Cached: installing
    the redistributable takes effect at the next start of Kairos, which is what the message implies anyway."""
    if sys.platform != "win32":
        return ()
    return tuple(name for name in DLLS if not _load(name))


def missing() -> bool:
    return bool(missing_dlls())


def status() -> dict:
    gone = missing_dlls()
    return {"missing": bool(gone), "dlls": list(gone), "message": MESSAGE if gone else None,
            "download_url": DOWNLOAD_URL if gone else None}
