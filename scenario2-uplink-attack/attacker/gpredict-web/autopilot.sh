#!/bin/sh
# autopilot.sh — drive the REAL gpredict GTK UI via xdotool so the participant
# only clicks one console button. Reproduces the manual sequence:
#   ☰ module menu → Antenna Control → (Rotator Control window) → Track → Engage
#
# Robust bits (no blind coordinates):
#   · the ☰ popup is a GTK menu → navigate by keyboard (Down ×N, Return); the
#     8th selectable item is "Antenna Control" (Detach▸Full screen▸Autotrack▸
#     Select satellite▸Sky at a glance▸Time Controller▸Radio Control▸Antenna Ctrl).
#   · the rotator window is found by its title "Gpredict Rotator Control".
# Calibratable coordinates (env, defaults for a 1280x900 Xvfb):
#   MENU_BTN_X/Y  — the ☰ button in the module header (only truly blind coord)
#   RC_X/RC_Y     — where we move the Rotator Control window
#   TRACK_DX/DY   — "Track" toggle, relative to the rotator window origin
#   ENGAGE_DX/DY  — "Engage" toggle, relative to the rotator window origin
#   MENU_DOWNS    — arrow-downs to reach "Antenna Control" (default 8)
#
# `autopilot.sh windows` prints window geometry to help calibration.
set -u
export DISPLAY="${DISPLAY:-:99}"

MENU_BTN_X="${MENU_BTN_X:-1255}"; MENU_BTN_Y="${MENU_BTN_Y:-55}"
MENU_DOWNS="${MENU_DOWNS:-8}"
RC_X="${RC_X:-340}"; RC_Y="${RC_Y:-180}"
TRACK_DX="${TRACK_DX:-300}";  TRACK_DY="${TRACK_DY:-45}"
ENGAGE_DX="${ENGAGE_DX:-300}"; ENGAGE_DY="${ENGAGE_DY:-560}"

MAIN_RE='Gpredict:'
ROT_RE='Rotator Control'

find_win() { xdotool search --name "$1" 2>/dev/null | head -1; }

click() { xdotool mousemove "$1" "$2" click 1; sleep 0.3; }

case "${1:-engage}" in
  windows)
    for id in $(xdotool search --name '.' 2>/dev/null); do
      nm=$(xdotool getwindowname "$id" 2>/dev/null)
      geo=$(xdotool getwindowgeometry "$id" 2>/dev/null | tr '\n' ' ')
      [ -n "$nm" ] && echo "[$id] $nm | $geo"
    done
    ;;

  engage)
    main=$(find_win "$MAIN_RE")
    [ -z "$main" ] && { echo "ERR: gpredict main window not found"; exit 1; }

    rot=$(find_win "$ROT_RE")
    if [ -z "$rot" ]; then
      # open the ☰ menu, then keyboard-nav to Antenna Control
      xdotool windowactivate --sync "$main" 2>/dev/null
      click "$MENU_BTN_X" "$MENU_BTN_Y"
      sleep 0.4
      i=0; while [ "$i" -lt "$MENU_DOWNS" ]; do xdotool key --clearmodifiers Down; sleep 0.06; i=$((i+1)); done
      xdotool key --clearmodifiers Return
      # wait for the Rotator Control window
      j=0; while [ "$j" -lt 30 ]; do rot=$(find_win "$ROT_RE"); [ -n "$rot" ] && break; sleep 0.2; j=$((j+1)); done
      [ -z "$rot" ] && { echo "ERR: Antenna Control did not open (calibrate MENU_BTN_X/Y or MENU_DOWNS)"; exit 1; }
    fi

    # place the window at a known spot, then toggle Track + Engage
    xdotool windowactivate --sync "$rot" 2>/dev/null
    xdotool windowmove "$rot" "$RC_X" "$RC_Y" 2>/dev/null
    sleep 0.3
    click $((RC_X + TRACK_DX))  $((RC_Y + TRACK_DY))    # Track
    click $((RC_X + ENGAGE_DX)) $((RC_Y + ENGAGE_DY))   # Engage
    echo "OK: engaged (rot win=$rot)"
    ;;

  *)
    echo "usage: autopilot.sh {engage|windows}"; exit 2 ;;
esac
