; Spliced into cargo-packager 0.11.8's installer.nsi as `nsis.preinstallSection` by
; desktop/scripts/package.ts. It lands ahead of the template's `Section Uninstall`, so this `un.`
; section runs first in the uninstaller.
;
; The template runs the previous version's uninstaller as `uninstall.exe /P _?=<dir>` only during an
; interactive upgrade (PageLeaveReinstall); a passive or silent update never runs it. A user uninstall
; (Settings, Control Panel, `uninstall.exe` with or without /S) passes no /P. Only then does this
; section remove what the app set up outside $INSTDIR, so an upgrade keeps the service, its stop/start
; intent, the aiop shims and the login item.

!define AIOP_SUPPORT "$LOCALAPPDATA\aio-proxy-desktop"
!define AIOP_SHIMS "$LOCALAPPDATA\aio-proxy-desktop\bin\shims"
!define AIOP_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define AIOP_STARTUP_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
!define AIOP_RUN_VALUE "AIO Proxy"

Section un.AioProxyCleanup
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $R0
  IfErrors 0 cleanup_done

  ; The template's own check comes after this section; the app must be gone first, because it holds
  ; its lock file under AIOP_SUPPORT and would restart the proxy.
  nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
  Pop $R0
  ${If} $R0 = 0
    IfSilent kill 0
    MessageBox MB_OKCANCEL "$(appRunningOkKill)" IDOK kill
    Abort "$(appRunning)"
    kill:
    nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
    Pop $R0
    Sleep 500
    ${IfThen} $R0 <> 0 ${|} Abort "$(failedToKillApp)" ${|}
  ${EndIf}

  ; Same rule as the CLI's readDesktopOwnedUnit: a unit is the app's when its program is the path the
  ; app recorded as AIO_PROXY_DESKTOP_EXEC. A service the user installed from the CLI stays.
  System::Call 'kernel32::SetEnvironmentVariable(t "AIO_PROXY_SERVICE_SPEC", t "$LOCALAPPDATA\aio-proxy\service.json")'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$u = Get-Content -LiteralPath $$env:AIO_PROXY_SERVICE_SPEC -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json; if ($$u.exec -and $$u.exec -ceq $$u.env.AIO_PROXY_DESKTOP_EXEC) { exit 0 }; exit 1"'
  Pop $R0
  ${If} $R0 == 0
    ; Stops the task before deleting it.
    nsExec::ExecToLog '"$INSTDIR\aio-proxy.exe" service uninstall'
    Pop $R0
  ${EndIf}

  ; Drop the shims entry from the user Path; every other entry stays byte for byte.
  ; ponytail: a Path at NSIS_MAX_STRLEN or longer is left alone (the entry stays) rather than risk
  ; writing back a truncated one; edit it from PowerShell if that ever matters.
  ClearErrors
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrLen $R1 $R0
  IntOp $R2 ${NSIS_MAX_STRLEN} - 1
  ${IfNot} ${Errors}
  ${AndIf} $R1 < $R2
    ${WordReplace} ";$R0;" ";${AIOP_SHIMS};" ";" "+" $R1
    StrCpy $R1 $R1 -1 1
    ${If} $R1 != $R0
      WriteRegExpandStr HKCU "Environment" "Path" $R1
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}

  ; The login item, only when it is this install's (the app writes the quoted exe path).
  ReadRegStr $R0 HKCU "${AIOP_RUN_KEY}" "${AIOP_RUN_VALUE}"
  ${If} $R0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
    DeleteRegValue HKCU "${AIOP_RUN_KEY}" "${AIOP_RUN_VALUE}"
    DeleteRegValue HKCU "${AIOP_STARTUP_APPROVED_KEY}" "${AIOP_RUN_VALUE}"
  ${EndIf}

  RMDir /r "${AIOP_SUPPORT}"
  cleanup_done:
SectionEnd
