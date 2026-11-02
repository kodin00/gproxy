#!/bin/bash
#
# gproxy work-Mac uninstaller.
#
# Stops the launchd agent and removes its plist. Deliberately KEEPS:
#   - ~/.config/gproxy           (config.json with the token)
#   - ~/.local/share/gproxy      (the Chrome profile with the signed-in
#                                 work Google session)
# so a re-install (./deploy/install.sh) picks up where you left off.
#
# Bash 3.2 compatible (macOS default shell).

set -euo pipefail

info() { printf '%s\n' "==> $*"; }

uid="$(id -u)"
SERVICE="gui/$uid/com.gproxy.agent"
PLIST="$HOME/Library/LaunchAgents/com.gproxy.agent.plist"

info "Stopping launchd agent (ignoring errors if not loaded)"
launchctl bootout "$SERVICE" >/dev/null 2>&1 || true

info "Removing $PLIST"
rm -f "$PLIST"

# The appliance Chrome was spawned detached by the agent; it survives the
# agent. Quit its window manually if it is still open.
info "If the appliance Chrome window is still open, quit it manually."

printf '\n'
printf '%s\n' "gproxy agent uninstalled."
printf '%s\n' "Left in place (config + Google session):"
printf '%s\n' "  ~/.config/gproxy           - token/config"
printf '%s\n' "  ~/.local/share/gproxy      - Chrome profile with the work Google session"
printf '\n'
printf '%s\n' "To remove those too:"
printf '%s\n' "  rm -rf ~/.config/gproxy ~/.local/share/gproxy"
printf '%s\n' "(Do this BEFORE signing out of anything if you also want the"
printf '%s\n' " work Google session gone — deleting the profile removes it.)"
printf '\n'
printf '%s\n' "Re-install any time with:  ./deploy/install.sh"
