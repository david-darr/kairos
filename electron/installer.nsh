; Kairos CLI (vault spec "Kairos CLI (Build Spec)", section 4.7).
; electron-builder includes this through build.nsis.include.
;
; - Every install puts kairos.cmd in the install folder, beside Kairos.exe.
;   It runs the bundled Python on the bundled cli\ package.
; - A page offers to put that folder on the person's own PATH (HKCU, never
;   the machine's). The box starts unticked: nothing changes unless asked.
; - Uninstalling removes kairos.cmd and the PATH entry, but not during an
;   update, so an update keeps the person's choice.

!include nsDialogs.nsh
!include LogicLib.nsh
!include StrFunc.nsh
; electron-builder compiles the uninstaller in a pass of its own, with
; BUILD_UNINSTALLER defined. Each helper is declared only in the pass that
; uses it: an unused one is warning 6010, and the build treats warnings as
; errors (the 2.2.0 installer build failed on exactly that).
!ifdef BUILD_UNINSTALLER
  ${UnStrStr}
  ${UnStrRep}
!else
  ${StrStr}

; The PATH page and its answer belong to the installer pass alone, for the
; same reason.
Var KairosCliPathBox
Var KairosCliPathWanted

!macro customPageAfterChangeDir
  Page custom KairosCliPathPage KairosCliPathLeave
!macroend

Function KairosCliPathPage
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 40u "Kairos has a terminal command too: kairos. Tick the box to run it from any new terminal. This adds the Kairos folder to your own PATH, and uninstalling Kairos takes it out again."
  Pop $0
  ${NSD_CreateCheckbox} 0 48u 100% 12u "Add the kairos command to my PATH"
  Pop $KairosCliPathBox
  ${If} $KairosCliPathWanted == ${BST_CHECKED}
    ${NSD_Check} $KairosCliPathBox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function KairosCliPathLeave
  ${NSD_GetState} $KairosCliPathBox $KairosCliPathWanted
FunctionEnd
!endif

!macro customInstall
  CopyFiles /SILENT "$INSTDIR\resources\backend\cli\kairos.cmd" "$INSTDIR\kairos.cmd"
  ${If} $KairosCliPathWanted == ${BST_CHECKED}
    ReadRegStr $0 HKCU "Environment" "Path"
    ${StrStr} $1 ";$0;" ";$INSTDIR;"
    ${If} $1 == ""
      ${If} $0 == ""
        WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
      ${Else}
        WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
      ${EndIf}
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$INSTDIR\kairos.cmd"
  ${IfNot} ${isUpdated}
    ReadRegStr $0 HKCU "Environment" "Path"
    ${UnStrStr} $1 ";$0;" ";$INSTDIR;"
    ${If} $1 != ""
      ${UnStrRep} $2 ";$0;" ";$INSTDIR;" ";"
      ${UnStrRep} $2 "$2" ";;" ";"
      ; trim the separators the wrapping added
      StrCpy $3 $2 1
      ${If} $3 == ";"
        StrCpy $2 $2 "" 1
      ${EndIf}
      StrCpy $3 $2 1 -1
      ${If} $3 == ";"
        StrCpy $2 $2 -1
      ${EndIf}
      WriteRegExpandStr HKCU "Environment" "Path" "$2"
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}
!macroend
