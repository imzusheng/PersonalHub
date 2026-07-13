; electron-builder's default check first asks the user to close the app and only
; then kills it. PersonalHub is a background worker, so close it automatically.
!macro customCheckAppRunning
  DetailPrint "Closing PersonalHub before installing..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "PersonalHub.exe" /T /F'
  Pop $0
  Sleep 1500
!macroend
