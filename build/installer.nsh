!macro customInit
  ; PersonalHub lives in the tray, so WM_CLOSE does not terminate it during upgrades.
  ; Stop every process in its Electron process tree before NSIS replaces app.asar/exe files.
  nsExec::ExecToLog 'taskkill /IM "PersonalHub.exe" /T /F'
!macroend
