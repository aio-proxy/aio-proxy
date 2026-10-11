; Start Menu shortcut, Settings uninstall entry, passive (/P) install, and relaunch (/R).
; /P keeps the progress page and closes it. /S is NSIS silent mode.
; A passive or silent install relaunches only when /R is set. An interactive install always does.

!define AIOP_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIO Proxy"

Var PassiveMode

Function .onInit
  StrCpy $PassiveMode 0
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $R0
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
    SetAutoClose true
  ${EndIf}
  ${If} ${Silent}
    SetAutoClose true
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  ClearErrors
  ${GetOptions} $CMDLINE "/R" $R0
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${IfNot} ${Errors}
      Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
    ${EndIf}
  ${Else}
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
FunctionEnd

!macro AioProxyInstallShell
  WriteRegStr HKCU "${AIOP_UNINSTALL_KEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr HKCU "${AIOP_UNINSTALL_KEY}" "Publisher" "${PRODUCTNAME}"
  WriteRegStr HKCU "${AIOP_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${AIOP_UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${AIOP_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${AIOP_UNINSTALL_KEY}" "NoRepair" 1
  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

!macro AioProxyUninstallShell
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  DeleteRegKey HKCU "${AIOP_UNINSTALL_KEY}"
!macroend
