#!/usr/bin/env bash
# [WSL/Docker] Reset the whole scenario1 demo to its INITIAL state so every participant starts
# from an identical setting. Run this between participants (or trigger it from the web "Reset"
# button, which calls /api/reset-all -> this script).
#
# What it resets:
#   - gpredict : recreated fresh -> 433.5 MHz transponder base, radio/rotor DISENGAGED, Doppler
#                OFF, satellite back at the pre-AOS start time (identical for everyone).
#   - gnuradio : recreated fresh -> the recovered image / decode state is wiped and it decodes
#                the default downlink again from scratch.
#   - recorded signal + recovered image : the PHASE-4 upload and the gnuradio-out/ results are
#                deleted so the next participant records and decodes their own.
#   - VSA + web guide : reset in the browser when the page reloads (their state is client-side).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

log "RESET: returning the demo to its initial state ..."

# 1) clear participant artifacts: the recorded IQ and the recovered image / progressive decode state
rm -f "$SCEN1/gnuradio-web/upload/uploaded.cf32" \
      "$SCEN1/gnuradio-web/upload/samp_rate.txt" \
      "$SCEN1/gnuradio-web/upload/uploaded.json" 2>/dev/null
rm -f "$SCEN1/gnuradio-out/"*.png \
      "$SCEN1/gnuradio-out/"*_progress.txt \
      "$SCEN1/gnuradio-out/persist.raw" \
      "$SCEN1/gnuradio-out/offset.txt" 2>/dev/null
log "cleared upload/ (recorded signal) and gnuradio-out/ (recovered image)"

# 2) recreate the two stateful containers so they come up in the identical initial state
bash "$RUN_DIR/gpredict.sh" || err "gpredict recreate failed"
bash "$RUN_DIR/gnuradio.sh" || err "gnuradio recreate failed"

log "RESET complete. Refresh the browser (the web Reset button reloads it automatically)."
