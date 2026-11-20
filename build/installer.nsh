; ---------------------------------------------------------------------------
; The setup wizard's words. Its pictures are build/installerSidebar.bmp,
; uninstallerSidebar.bmp and installerHeader.bmp (npm run installer-art).
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER
  !macro customWelcomePage
    !define MUI_WELCOMEPAGE_TITLE "Welcome to Coffee"
    !define MUI_WELCOMEPAGE_TEXT "A fast, minimal browser with ad blocking built in.$\r$\n$\r$\nSetup will install Coffee on this computer. You can bring your bookmarks and history over from Chrome, Edge or Brave the first time you open it.$\r$\n$\r$\nClick Next to continue."
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  ; Used by the finish page electron-builder adds (with its "run" checkbox).
  !define MUI_FINISHPAGE_TITLE "Coffee is ready"
  !define MUI_FINISHPAGE_TEXT "Coffee is installed.$\r$\n$\r$\nTo open links from other apps in Coffee, make it your default browser in Coffee's Settings."
  !define MUI_FINISHPAGE_RUN_TEXT "Open Coffee now"
!endif

; Registers Coffee as a web browser so it shows up in
; Settings > Apps > Default apps. Per-user (HKCU), no admin rights needed.

!define COFFEE_CAPS "Software\Clients\StartMenuInternet\Coffee\Capabilities"

!macro customInstall
  WriteRegStr HKCU "Software\Classes\CoffeeHTML" "" "Coffee Web Document"
  WriteRegStr HKCU "Software\Classes\CoffeeHTML" "FriendlyTypeName" "Coffee Web Document"
  WriteRegStr HKCU "Software\Classes\CoffeeHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\CoffeeHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Coffee" "" "Coffee"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Coffee\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Coffee\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'

  WriteRegStr HKCU "${COFFEE_CAPS}" "ApplicationName" "Coffee"
  WriteRegStr HKCU "${COFFEE_CAPS}" "ApplicationDescription" "A fast, minimal browser."
  WriteRegStr HKCU "${COFFEE_CAPS}" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "${COFFEE_CAPS}\URLAssociations" "http" "CoffeeHTML"
  WriteRegStr HKCU "${COFFEE_CAPS}\URLAssociations" "https" "CoffeeHTML"
  WriteRegStr HKCU "${COFFEE_CAPS}\FileAssociations" ".html" "CoffeeHTML"
  WriteRegStr HKCU "${COFFEE_CAPS}\FileAssociations" ".htm" "CoffeeHTML"
  WriteRegStr HKCU "${COFFEE_CAPS}\FileAssociations" ".svg" "CoffeeHTML"
  WriteRegStr HKCU "${COFFEE_CAPS}\FileAssociations" ".pdf" "CoffeeHTML"
  WriteRegStr HKCU "${COFFEE_CAPS}\StartMenu" "StartMenuInternet" "Coffee"

  WriteRegStr HKCU "Software\RegisteredApplications" "Coffee" "${COFFEE_CAPS}"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\RegisteredApplications" "Coffee"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Coffee"
  DeleteRegKey HKCU "Software\Classes\CoffeeHTML"
!macroend
