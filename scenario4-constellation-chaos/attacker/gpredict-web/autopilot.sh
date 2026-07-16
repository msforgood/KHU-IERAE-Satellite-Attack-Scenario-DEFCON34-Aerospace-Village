#!/bin/sh
# autopilot.sh — drive the REAL gpredict GTK UI via xdotool so the console can
# connect BOTH the antenna rotator (az/el tracking) and the radio (Doppler). It
# reproduces the manual menu sequence for each:
#   ☰ module menu → Antenna Control → (Rotator Control window) → Track → Engage
#   ☰ module menu → Radio Control   → (Radio Control window)   → Track → Engage
#
# Track and Engage are STATEFUL toggles, so blindly clicking them flips a good
# state back off. control.py therefore drives the granular actions below while
# watching the bridge status, clicking each toggle ONLY while it is still off:
#   rotor-open / rotor-track / rotor-engage — antenna (az/el) control
#   radio-open / radio-track / radio-engage — radio (Doppler) control
#   engage — (legacy) open rotor + Track + Engage in one blind shot
#
# Click coordinates: the TRACK/ENGAGE offsets are relative to each window's TRUE
# top-left as reported by `xdotool getwindowgeometry` (NOT the requested RC_X/RC_Y
# — the window manager adds a ~40px title-bar offset). Reading the real position
# each time keeps clicks correct even if the WM places the window a few px off.
# Measured on the 1280x900 Xvfb layout:
#   Rotator Control: Track +372,+177   Engage +778,+177  (menu item 8)
#   Radio Control:   Track +205,+234   Engage +695,+234  (menu item 7)
#
# `autopilot.sh windows` prints window geometry to help re-calibration.
set -u
export DISPLAY="${DISPLAY:-:99}"

MENU_BTN_X="${MENU_BTN_X:-1255}"; MENU_BTN_Y="${MENU_BTN_Y:-55}"
RC_X="${RC_X:-340}"; RC_Y="${RC_Y:-180}"

# rotor (Antenna Control) — menu item 8
ROTOR_DOWNS="${ROTOR_DOWNS:-${MENU_DOWNS:-8}}"
TRACK_DX="${TRACK_DX:-372}";  TRACK_DY="${TRACK_DY:-177}"
ENGAGE_DX="${ENGAGE_DX:-778}"; ENGAGE_DY="${ENGAGE_DY:-177}"

# radio (Radio Control) — menu item 7
RADIO_DOWNS="${RADIO_DOWNS:-7}"
RADIO_TRACK_DX="${RADIO_TRACK_DX:-205}";  RADIO_TRACK_DY="${RADIO_TRACK_DY:-234}"
RADIO_ENGAGE_DX="${RADIO_ENGAGE_DX:-695}"; RADIO_ENGAGE_DY="${RADIO_ENGAGE_DY:-234}"

MAIN_RE='Gpredict:'
ROT_RE='Rotator Control'
RADIO_RE='Radio Control'

find_win() { xdotool search --name "$1" 2>/dev/null | head -1; }
click() { xdotool mousemove "$1" "$2" click 1; sleep 0.3; }

# Dismiss gpredict's transient "TLE files are getting out of date" modal (and any
# other single-button message dialog). It is titled exactly "gpredict" and pops up
# centred over the module; the leftover menu popups sit far right (x>=1000) and the
# real windows have longer titles, so we target centred, dialog-sized "gpredict"
# windows and press their default button (Return).
dismiss_popup() {
  for id in $(xdotool search --name '^gpredict$' 2>/dev/null); do
    geo=$(xdotool getwindowgeometry "$id" 2>/dev/null)
    x=$(echo "$geo"  | awk '/Position:/{split($2,a,",");print a[1]}')
    wh=$(echo "$geo" | awk '/Geometry:/{print $2}')
    w=${wh%x*}; h=${wh#*x}
    [ -z "${x:-}" ] && continue
    if [ "$x" -lt 1000 ] && [ "${w:-0}" -gt 250 ] && [ "${h:-0}" -gt 80 ] && [ "${h:-0}" -lt 400 ]; then
      xdotool windowactivate --sync "$id" 2>/dev/null
      xdotool key --clearmodifiers Return 2>/dev/null
      sleep 0.3
    fi
  done
}

# open (if needed) + place a control window; echo "winid X Y" (true top-left).
#   $1 = arrow-downs to the menu item   $2 = window-name regex
ensure_ctrl_win() {
  downs="$1"; re="$2"
  main=$(find_win "$MAIN_RE")
  [ -z "$main" ] && return 1
  win=$(find_win "$re")
  if [ -z "$win" ]; then
    xdotool windowactivate --sync "$main" 2>/dev/null
    click "$MENU_BTN_X" "$MENU_BTN_Y"
    sleep 0.4
    i=0; while [ "$i" -lt "$downs" ]; do xdotool key --clearmodifiers Down; sleep 0.06; i=$((i+1)); done
    xdotool key --clearmodifiers Return
    j=0; while [ "$j" -lt 30 ]; do win=$(find_win "$re"); [ -n "$win" ] && break; sleep 0.2; j=$((j+1)); done
    [ -z "$win" ] && return 1
  fi
  dismiss_popup
  xdotool windowactivate --sync "$win" 2>/dev/null
  xdotool windowmove "$win" "$RC_X" "$RC_Y" 2>/dev/null
  sleep 0.3
  pos=$(xdotool getwindowgeometry "$win" 2>/dev/null | awk '/Position:/{split($2,a,",");print a[1],a[2]}')
  [ -z "$pos" ] && pos="$RC_X $RC_Y"
  echo "$win $pos"
}

# click a toggle at (winX+dx, winY+dy) using the window's true top-left.
#   $1 = downs  $2 = regex  $3 = dx  $4 = dy
click_toggle() {
  info=$(ensure_ctrl_win "$1" "$2") || return 1
  set -- "$3" "$4" $info            # $1=dx $2=dy $3=winid $4=wx $5=wy
  dx="$1"; dy="$2"; win="$3"; wx="${4:-$RC_X}"; wy="${5:-$RC_Y}"
  cx=$((wx + dx)); cy=$((wy + dy))
  click "$cx" "$cy"
  echo "win=$win @ $wx,$wy -> click $cx,$cy"
}

case "${1:-engage}" in
  windows)
    for id in $(xdotool search --name '.' 2>/dev/null); do
      nm=$(xdotool getwindowname "$id" 2>/dev/null)
      geo=$(xdotool getwindowgeometry "$id" 2>/dev/null | tr '\n' ' ')
      [ -n "$nm" ] && echo "[$id] $nm | $geo"
    done
    ;;

  dismiss)       dismiss_popup; echo "OK: dismiss" ;;

  rotor-open)
    info=$(ensure_ctrl_win "$ROTOR_DOWNS" "$ROT_RE") || { echo "ERR: rotor window not found"; exit 1; }
    echo "OK: rotor-open ($info)" ;;
  rotor-track)
    d=$(click_toggle "$ROTOR_DOWNS" "$ROT_RE" "$TRACK_DX" "$TRACK_DY") || { echo "ERR: rotor window not found"; exit 1; }
    echo "OK: rotor-track ($d)" ;;
  rotor-engage)
    d=$(click_toggle "$ROTOR_DOWNS" "$ROT_RE" "$ENGAGE_DX" "$ENGAGE_DY") || { echo "ERR: rotor window not found"; exit 1; }
    echo "OK: rotor-engage ($d)" ;;

  radio-open)
    info=$(ensure_ctrl_win "$RADIO_DOWNS" "$RADIO_RE") || { echo "ERR: radio window not found"; exit 1; }
    echo "OK: radio-open ($info)" ;;
  radio-track)
    d=$(click_toggle "$RADIO_DOWNS" "$RADIO_RE" "$RADIO_TRACK_DX" "$RADIO_TRACK_DY") || { echo "ERR: radio window not found"; exit 1; }
    echo "OK: radio-track ($d)" ;;
  radio-engage)
    d=$(click_toggle "$RADIO_DOWNS" "$RADIO_RE" "$RADIO_ENGAGE_DX" "$RADIO_ENGAGE_DY") || { echo "ERR: radio window not found"; exit 1; }
    echo "OK: radio-engage ($d)" ;;

  engage)
    info=$(ensure_ctrl_win "$ROTOR_DOWNS" "$ROT_RE") || { echo "ERR: rotor window not found"; exit 1; }
    set -- $info; win=$1; wx="${2:-$RC_X}"; wy="${3:-$RC_Y}"
    click $((wx + TRACK_DX))  $((wy + TRACK_DY))    # Track
    click $((wx + ENGAGE_DX)) $((wy + ENGAGE_DY))   # Engage
    echo "OK: engaged (win=$win @ $wx,$wy)" ;;

  *)
    echo "usage: autopilot.sh {rotor-open|rotor-track|rotor-engage|radio-open|radio-track|radio-engage|engage|dismiss|windows}"; exit 2 ;;
esac
