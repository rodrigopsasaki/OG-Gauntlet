#!/usr/bin/env zsh
# jak-telemetry.sh <telemetry-log> [game-log]
#
# The machine's side of a stutter investigation. gk's own HITCH / FRAMESTAT / GAMECTX / CONSOLEIO lines say
# what the game and its renderer were doing (see game/graphics/hitch_recorder.h); this writes, once a second and
# for as long as gk runs, what everything ELSE was doing, to <telemetry-log>:
#
#   SAMPLE    GPU Device / Renderer / Tiler utilisation %, CPU % of gk, OBS, WindowServer, replayd, BTLEServer and
#             kernel_task (a delta of each process's CPU time over the real interval, so it is the last second and
#             not ps's decayed lifetime average), and whether OBS is running at all
#   DISPLAY   the monitor's current mode, when it changes (and once at the start, with system_profiler's view);
#             plus the mode the game says it asked for, read from the game log when <game-log> is given
#   GAMEMODE  everything macOS says about Game Mode: gamepolicyd's own log lines about game mode and full screen
#             gaming sessions, and changes in the Darwin notifications gamepolicyd posts
#   START / END
#
# Every line starts with a wall-clock stamp to the millisecond in the same format as gk's own lines, so the two
# files can be read side by side. Exits when gk exits (or at once if there is no gk to watch).

zmodload zsh/datetime

out=$1
game_log=$2
[[ -n $out ]] || { print -u2 "usage: jak-telemetry.sh <telemetry-log> [game-log]"; exit 2 }

stamp() { strftime -s now '%Y-%m-%d %H:%M:%S' ${EPOCHREALTIME%.*}; printf -v ms '%03d' $(( (EPOCHREALTIME - ${EPOCHREALTIME%.*}) * 1000 )); print -r -- "$now.$ms" }
say() { print -r -- "$(stamp) $*" >> $out }

# gk may have been started a moment ago by the caller. JAK_TELEMETRY_PID names another process to watch, to try the
# sampler out without a game.
gk_pid=$JAK_TELEMETRY_PID
if [[ -z $gk_pid ]]; then
  for _ in 1 2 3 4 5 6; do
    gk_pid=$(pgrep -nx gk) && break
    sleep 0.25
  done
fi
if [[ -z $gk_pid ]]; then
  say "START no gk process to watch, nothing sampled"
  exit 0
fi
say "START watching gk pid $gk_pid, game log ${game_log:-none}"

# A few lines at the start the sampler cannot get later: what the display is, in system_profiler's words.
say "DISPLAY at start: $(system_profiler SPDisplaysDataType 2>/dev/null | grep -E 'Resolution:|UI Looks like|Display Type|Main Display|Mirror' | sed 's/^ *//' | paste -sd ';' - | sed 's/;/; /g')"

# The cheap per-second display check: one CoreGraphics call, compiled once. system_profiler takes half a second.
helper=${TMPDIR:-/tmp}/jak-telemetry-displaymode
if [[ ! -x $helper ]] && command -v clang >/dev/null; then
  src=$helper.c
  cat > $src <<'EOF'
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
int main(void) {
  CGDisplayModeRef m = CGDisplayCopyDisplayMode(CGMainDisplayID());
  if (!m) return 1;
  printf("%zux%zu points, %zux%zu pixels @ %.0f Hz\n", CGDisplayModeGetWidth(m), CGDisplayModeGetHeight(m),
         CGDisplayModeGetPixelWidth(m), CGDisplayModeGetPixelHeight(m), CGDisplayModeGetRefreshRate(m));
  return 0;
}
EOF
  clang $src -framework ApplicationServices -o $helper 2>/dev/null
fi

# Game Mode. gamepolicyd logs "Game mode is now ...", "Game mode status is now ..." and "Full screen gaming session is
# now ..." when it engages or lets go. Anything else it says (the RunningBoard chatter that is most of its output) is left out.
# The log's own timestamp leads each line, to the millisecond, like everything else here.
log stream --style compact --predicate \
  'process == "gamepolicyd" AND NOT (subsystem == "com.apple.runningboard") AND NOT (eventMessage CONTAINS "observedProcess") AND NOT (eventMessage CONTAINS "appex record") AND NOT (eventMessage CONTAINS "Cleaned up")' 2>/dev/null |
  sed -l -E '/^(Filtering|Timestamp)/d; s/^([0-9-]+ [0-9:.]+) +/\1 GAMEMODE log: /' >> $out &
# kernel_task is hidden from ps (pid 0), so top is left running to report it; the latest figure is kept in a file.
kt_file=${TMPDIR:-/tmp}/jak-telemetry-kernel-task.$$
top -l 0 -s 1 -pid 0 -stats pid,command,cpu 2>/dev/null | awk -v f=$kt_file '/^0 +kernel_task/ { printf "%s", $3 > f; close(f) }' &
cleanup() {
  pkill -P $$ -x log 2>/dev/null; pkill -P $$ -x sed 2>/dev/null; pkill -P $$ -x top 2>/dev/null; pkill -P $$ -x awk 2>/dev/null
  rm -f $kt_file
  say "END"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

notify_names=(com.apple.gamepolicy.fullscreenStateChanged com.apple.gamepolicy.GameExited com.apple.gamepolicy.game-mode-session)
notify_args=(); for n in $notify_names; do notify_args+=(-g $n); done

# CPU: the processes watched, by the name ps reports (its basename). Cumulative CPU seconds, summed over same-named processes.
watch=(gk obs WindowServer replayd BTLEServer kernel_task)
typeset -A prev_cpu
prev_now=0
last_display=
last_notify=
last_game_display=
tick=0

cpu_seconds() {  # ps -A output on stdin -> "<name> <cpu seconds>" per watched name
  awk -v names="${(j: :)watch}" '
    BEGIN { n = split(names, w, " "); for (i = 1; i <= n; i++) want[w[i]] = 1 }
    {
      t = $2; comm = $0; sub(/^ *[0-9]+ +[^ ]+ +/, "", comm); m = split(comm, parts, "/"); name = parts[m]
      if (!(name in want)) next
      d = 0; if (t ~ /-/) { split(t, dd, "-"); d = dd[1]; t = dd[2] }
      k = split(t, hms, ":"); s = 0
      for (i = 1; i <= k; i++) s = s * 60 + hms[i]
      sum[name] += s + d * 86400; seen[name] = 1
    }
    END { for (nm in seen) printf "%s %.2f\n", nm, sum[nm] }'
}

while kill -0 $gk_pid 2>/dev/null; do
  now=$EPOCHREALTIME

  typeset -A cur_cpu; cur_cpu=()
  while read -r name secs; do cur_cpu[$name]=$secs; done < <(ps -A -o pid=,cputime=,comm= | cpu_seconds)
  line=
  for name in $watch; do
    pct=-
    if [[ -n ${cur_cpu[$name]} && -n ${prev_cpu[$name]} ]] && (( prev_now > 0 )); then
      (( v = (cur_cpu[$name] - prev_cpu[$name]) / (now - prev_now) * 100 ))
      (( v < 0 )) && v=0
      printf -v pct '%.0f' $v
    fi
    line+=" cpu_$name=$pct"
    prev_cpu[$name]=${cur_cpu[$name]}
  done
  prev_now=$now
  [[ -r $kt_file ]] && line=${line/cpu_kernel_task=-/cpu_kernel_task=$(<$kt_file)}

  gpu=$(ioreg -r -d 1 -w0 -c IOAccelerator 2>/dev/null)
  g_dev=-; g_ren=-; g_til=-
  [[ $gpu =~ 'Device Utilization %"=([0-9]+)' ]] && g_dev=$match[1]
  [[ $gpu =~ 'Renderer Utilization %"=([0-9]+)' ]] && g_ren=$match[1]
  [[ $gpu =~ 'Tiler Utilization %"=([0-9]+)' ]] && g_til=$match[1]
  obs=no; [[ -n ${cur_cpu[obs]} ]] && obs=yes
  say "SAMPLE gpu_device=$g_dev gpu_renderer=$g_ren gpu_tiler=$g_til$line obs_running=$obs"

  if [[ -x $helper ]]; then
    mode=$($helper)
    if [[ $mode != $last_display ]]; then
      say "DISPLAY mode: $mode"
      last_display=$mode
    fi
  fi

  notify_now=$(notifyutil $notify_args 2>/dev/null | paste -sd ' ' -)
  if [[ $notify_now != $last_notify ]]; then
    say "GAMEMODE notify: $notify_now"
    last_notify=$notify_now
  fi

  if [[ -n $game_log && -r $game_log ]] && (( tick % 10 == 0 )); then
    g=$(grep -a -E '\[DISPLAY\] (fullscreen mode|Setting to display mode)' $game_log | tail -1)
    if [[ -n $g && $g != $last_game_display ]]; then
      say "DISPLAY game says: ${g//$'\e'\[[0-9;]#m/}"
      last_game_display=$g
    fi
  fi

  tick=$(( tick + 1 ))
  # a second from the start of this pass, not from its end, so the passes do not drift
  nap=$(( 1 - (EPOCHREALTIME - now) ))
  (( nap > 0.05 )) && sleep $nap
done
