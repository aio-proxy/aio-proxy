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
  ; ReadAllText decodes UTF-8: Windows PowerShell's Get-Content would use the ANSI code page and, on a
  ; CJK one, mangle a non-ASCII profile path until ConvertFrom-Json fails.
  ; Exit 0: the app's service. Exit 1: verified not the app's (another owner, or no spec and no task).
  ; Exit 2 also for another owner's spec that runs the support copy (`aiop service install` from the
  ; app's shim): that task still needs the executable.
  ; Exit 2: unverifiable (spec missing or unreadable while a task exists) — the task may run the
  ; support copy, so it is kept, as it is when PowerShell itself fails ("error").
  System::Call 'kernel32::SetEnvironmentVariable(t "AIO_PROXY_SUPPORT", t "${AIOP_SUPPORT}")'
  System::Call 'kernel32::SetEnvironmentVariable(t "AIO_PROXY_SERVICE_SPEC", t "$LOCALAPPDATA\aio-proxy\service.json")'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { $$u = [IO.File]::ReadAllText($$env:AIO_PROXY_SERVICE_SPEC) | ConvertFrom-Json } catch { $$u = $$null }; if ($$u -ne $$null) { if ($$u.exec -and $$u.exec -ceq $$u.env.AIO_PROXY_DESKTOP_EXEC) { exit 0 }; if ($$u.exec -and $$u.exec.ToLower().StartsWith(($$env:AIO_PROXY_SUPPORT + [char]92).ToLower())) { exit 2 }; exit 1 }; if (Get-ScheduledTask -TaskPath $\'\AIO Proxy\$\' -ErrorAction SilentlyContinue) { exit 2 }; exit 1"'
  Pop $R0
  ${If} $R0 == 0
    ; Stops the task before deleting it.
    nsExec::ExecToLog '"$INSTDIR\aio-proxy.exe" service uninstall'
    Pop $R3
    ${If} $R3 != 0
      DetailPrint "aio-proxy service uninstall failed ($R3); keeping ${AIOP_SUPPORT}, which the task still runs"
    ${EndIf}
  ${ElseIf} $R0 == 1
    StrCpy $R3 0
  ${Else}
    StrCpy $R3 $R0
    DetailPrint "cannot tell who owns the AIO Proxy scheduled task ($R0); keeping ${AIOP_SUPPORT}, which it may run"
  ${EndIf}

  ; Drop the shims entry from the user Path; every other entry stays byte for byte, and the value keeps its
  ; registry type (rewriting a REG_SZ Path as REG_EXPAND_SZ would start expanding unrelated %VAR% entries).
  ; PowerShell reads the raw value (no expansion) with no NSIS_MAX_STRLEN ceiling. Exit 0: the Path changed.
  System::Call 'kernel32::SetEnvironmentVariable(t "AIO_PROXY_SHIMS", t "${AIOP_SHIMS}")'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $$true); if ($$k -eq $$null) { exit 1 }; $$v = $$k.GetValue('Path', $$null, 'DoNotExpandEnvironmentNames'); if ($$v -eq $$null) { exit 1 }; $$parts = $$v -split ';'; $$kept = @($$parts | Where-Object { $$_ -ne $$env:AIO_PROXY_SHIMS }); if ($$kept.Count -eq $$parts.Count) { exit 1 }; $$k.SetValue('Path', ($$kept -join ';'), $$k.GetValueKind('Path')); exit 0"`
  Pop $R0
  ${If} $R0 == 0
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}

  ; The login item, only when it is this install's (the app writes the quoted exe path).
  ReadRegStr $R0 HKCU "${AIOP_RUN_KEY}" "${AIOP_RUN_VALUE}"
  ${If} $R0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
    DeleteRegValue HKCU "${AIOP_RUN_KEY}" "${AIOP_RUN_VALUE}"
    DeleteRegValue HKCU "${AIOP_STARTUP_APPROVED_KEY}" "${AIOP_RUN_VALUE}"
  ${EndIf}

  ${If} $R3 == 0
    RMDir /r "${AIOP_SUPPORT}"
  ${EndIf}
  cleanup_done:
SectionEnd
