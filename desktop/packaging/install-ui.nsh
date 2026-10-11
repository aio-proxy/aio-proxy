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

; Close this install's companion before File replaces it, or before a user uninstall deletes
; it. Match the full path: taskkill /IM would also stop another session's aio-proxy-desktop.exe.
; Passive and silent installs kill it; an interactive one asks. No named labels, so the macro
; can be inserted from both the installer and the uninstaller.
!macro AioProxyCloseRunning
  System::Call 'kernel32::SetEnvironmentVariable(t "AIO_PROXY_DESKTOP_EXE", t "$INSTDIR\${MAINBINARYNAME}.exe")'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$want = $$env:AIO_PROXY_DESKTOP_EXE; $$ids = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -ieq $$want) }); if ($$ids.Count -eq 0) { exit 1 }; exit 0"'
  Pop $R0
  ${If} $R0 = 0
    ${IfNot} $PassiveMode = 1
    ${AndIfNot} ${Silent}
      MessageBox MB_OKCANCEL "$(appRunningOkKill)" IDOK +2
      Abort "$(appRunning)"
    ${EndIf}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$want = $$env:AIO_PROXY_DESKTOP_EXE; $$ids = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -ieq $$want) } | ForEach-Object ProcessId); foreach ($$id in $$ids) { Stop-Process -Id $$id -Force -ErrorAction Stop }"'
    Pop $R0
    Sleep 500
    ${IfThen} $R0 <> 0 ${|} Abort "$(failedToKillApp)" ${|}
  ${EndIf}
!macroend

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
