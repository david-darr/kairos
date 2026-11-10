; Microsoft Visual C++ 2015-2022 x64 runtime, installed only when a PC lacks it.
;
; The bundled Python's onnxruntime (Kokoro, Smart Turn), spaCy (Kokoro's phonemizer) and llama-cpp-python import
; MSVCP140.dll, MSVCP140_1.dll and VCOMP140.dll, which only this runtime provides. Microsoft's supported way to get them onto a PC is
; its own Redistributable, so the installer carries the official vc_redist.x64.exe (fetched and pinned by
; scripts/build_runtime.py: URL, size, SHA-256 and a Microsoft Corporation signature) and runs it quietly when the
; registry says the runtime is missing or older than the copy carried here.
;
; It never fails the Kairos install: 3010 (installed, restart pending) and 1638 (a newer one is present) are success,
; and anything else (a declined administrator prompt, no rights) is a detail line. Kairos itself still runs; Settings >
; Speech then says "Install the Microsoft Visual C++ runtime" (core/vc_runtime.py).
;
; installer.nsh includes this in the installer pass only. scripts/test_vcredist_nsis.cjs compiles the decision macro on
; its own and checks it against a table of registry states, and this PC's real registry, without installing anything.

; The version of the vc_redist.x64.exe carried (scripts/build_runtime.py VC_REDIST_VERSION; a test checks they agree).
!define KAIROS_VCRT_MAJOR 14
!define KAIROS_VCRT_MINOR 44
!define KAIROS_VCRT_BLD 35211
!define KAIROS_VCRT_KEY "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"

; Reads Microsoft's documented key from the 64-bit registry view: Installed, Major, Minor, Bld (empty when absent).
!macro KairosVcRuntimeRead _installed _major _minor _bld
  SetRegView 64
  ReadRegDWORD ${_installed} HKLM "${KAIROS_VCRT_KEY}" "Installed"
  ReadRegDWORD ${_major} HKLM "${KAIROS_VCRT_KEY}" "Major"
  ReadRegDWORD ${_minor} HKLM "${KAIROS_VCRT_KEY}" "Minor"
  ReadRegDWORD ${_bld} HKLM "${KAIROS_VCRT_KEY}" "Bld"
  SetRegView lastused
!macroend

; ${_out} = 1 when the carried redistributable must run: not installed, or installed older than the copy carried.
!macro KairosVcRuntimeNeeded _installed _major _minor _bld _out
  StrCpy ${_out} 1
  ${If} ${_installed} == 1
    ${If} ${_major} > ${KAIROS_VCRT_MAJOR}
      StrCpy ${_out} 0
    ${ElseIf} ${_major} = ${KAIROS_VCRT_MAJOR}
      ${If} ${_minor} > ${KAIROS_VCRT_MINOR}
        StrCpy ${_out} 0
      ${ElseIf} ${_minor} = ${KAIROS_VCRT_MINOR}
      ${AndIf} ${_bld} >= ${KAIROS_VCRT_BLD}
        StrCpy ${_out} 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; The plain detail line for the redistributable's exit code (Windows Installer codes).
!macro KairosVcRuntimeResult _code _out
  ${If} ${_code} = 0
    StrCpy ${_out} "Microsoft Visual C++ runtime installed."
  ${ElseIf} ${_code} = 3010
    StrCpy ${_out} "Microsoft Visual C++ runtime installed. Windows finishes it at the next restart."
  ${ElseIf} ${_code} = 1638
    StrCpy ${_out} "A newer Microsoft Visual C++ runtime is already installed."
  ${ElseIf} ${_code} = 1602
    StrCpy ${_out} "Microsoft Visual C++ runtime skipped (cancelled). Local voice features need it: aka.ms/vs/17/release/vc_redist.x64.exe"
  ${Else}
    StrCpy ${_out} "Microsoft Visual C++ runtime not installed (code ${_code}). Local voice features need it: aka.ms/vs/17/release/vc_redist.x64.exe"
  ${EndIf}
!macroend

!ifndef KAIROS_VCRT_TEST
Function KairosVcRuntime
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  !insertmacro KairosVcRuntimeRead $R1 $R2 $R3 $R4
  !insertmacro KairosVcRuntimeNeeded $R1 $R2 $R3 $R4 $R0
  ${If} $R0 == 0
    DetailPrint "Microsoft Visual C++ runtime $R2.$R3.$R4 is already installed."
  ${Else}
    DetailPrint "Installing the Microsoft Visual C++ runtime (Kairos's local voice and speech need it)..."
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "${BUILD_RESOURCES_DIR}\redist\vc_redist.x64.exe"
    ClearErrors
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $R5
    ${If} ${Errors}
      DetailPrint "Microsoft Visual C++ runtime could not be started. Local voice features need it: aka.ms/vs/17/release/vc_redist.x64.exe"
    ${Else}
      !insertmacro KairosVcRuntimeResult $R5 $R0
      DetailPrint "$R0"
    ${EndIf}
    Delete "$PLUGINSDIR\vc_redist.x64.exe"
    SetOutPath "$INSTDIR"
  ${EndIf}
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd
!endif
