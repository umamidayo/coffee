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
