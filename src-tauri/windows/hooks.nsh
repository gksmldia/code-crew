!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Resetting saved window state..."
  Delete "$APPDATA\com.dorothy.codecrew\.window-state.json"
!macroend
