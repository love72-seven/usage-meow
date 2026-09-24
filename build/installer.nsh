!include "LogicLib.nsh"
!include "uninstall-files.nsh"

!macro customHeader
  ; This is the actual NSIS uninstaller, not a separate forwarding program.
  !undef UNINSTALL_FILENAME
  !define UNINSTALL_FILENAME "unins.exe"
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails show
  !endif
!macroend

!macro customInstall
  FileOpen $R0 "$INSTDIR\.usage-meow-install" w
  FileWrite $R0 "com.local.usage-meow"
  FileClose $R0
!macroend

!macro customRemoveFiles
  ; Validate ownership before removing anything, even if registry paths drift.
  ClearErrors
  FileOpen $R0 "$INSTDIR\.usage-meow-install" r
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "无法确认用量喵的安装目录，未删除程序文件。请使用新版安装包修复此目录后重试。$\r$\n$INSTDIR" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  FileRead $R0 $R1
  FileClose $R0
  ${If} $R1 != "com.local.usage-meow"
    MessageBox MB_OK|MB_ICONSTOP "安装目录标记不匹配，卸载已停止。$\r$\n$INSTDIR" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}

  SetOutPath $TEMP
  usage_meow_retry_remove:
  StrCpy $R9 "0"
  FileOpen $R8 "$INSTDIR\uninstall-errors.log" w
  !insertmacro UsageMeowRemovePayload
  FileClose $R8

  ${If} $R9 != "0"
    ; Stop before the standard code removes shortcuts and uninstall registry.
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "部分程序文件无法删除。请关闭用量喵后点击重试。$\r$\n卸载尚未完成，卸载入口和注册信息将保留。$\r$\n详情：$INSTDIR\uninstall-errors.log" /SD IDCANCEL IDRETRY usage_meow_retry_remove
    SetErrorLevel 2
    Abort
  ${EndIf}

  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" 0 usage_meow_cleanup
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "卸载程序仍被占用，清理尚未完成，请稍后重试。" /SD IDCANCEL IDRETRY usage_meow_retry_remove
  SetErrorLevel 2
  Abort

  usage_meow_cleanup:
  Delete "$INSTDIR\uninstall-errors.log"
  Delete "$INSTDIR\.usage-meow-install"
  !insertmacro UsageMeowRemoveEmptyDirectories
  ; Remove the folder only when empty. Preserve anything not shipped by us.
  RMDir "$INSTDIR"
  ${If} ${FileExists} "$INSTDIR\*.*"
    DetailPrint "用量喵程序文件已删除；安装目录中的其他文件已保留。"
  ${EndIf}
  ClearErrors
!macroend
