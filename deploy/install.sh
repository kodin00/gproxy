#!/bin/bash
#
# gproxy work-Mac installer.
#
# Sets up the agent as a launchd user agent:
#   - installs Node 22 via mise (no global/system Node assumed)
#   - installs the agent's dependencies via `mise run deps`
#   - generates the auth token into ~/.config/gproxy/config.json (once)
#   - renders deploy/com.gproxy.agent.plist with absolute paths into
#     ~/Library/LaunchAgents/ and (re)starts it
#
# Safe to re-run: every step is idempotent, an existing token is kept,
# and the service is booted out before being bootstrapped again.
#
# Bash 3.2 compatible (macOS default shell). No jq, no mapfile, no
# associative arrays.

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '%s\n' "==> $*"; }
warn()  { printf '%s\n' "WARNING: $*" >&2; }
die()   { printf '%s\n' "ERROR: $*" >&2; exit 1; }

# Find the mise binary. In a non-interactive bash script PATH will not
# include ~/.local/bin (mise's shims only get injected into interactive
# shells), so probe the usual install locations as well.
find_mise() {
    local candidate
    if command -v mise >/dev/null 2>&1; then
        command -v mise
        return 0
    fi
    for candidate in \
        "$HOME/.local/bin/mise" \
        "/opt/homebrew/bin/mise" \
        "/usr/local/bin/mise" \
        "/usr/bin/mise"
    do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# Locate the tailscale CLI. The App Store / standalone Mac app ships the
# same CLI inside its .app bundle; support both.
find_tailscale() {
    local candidate
    if command -v tailscale >/dev/null 2>&1; then
        command -v tailscale
        return 0
    fi
    for candidate in \
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
        "/usr/local/bin/tailscale" \
        "/opt/homebrew/bin/tailscale"
    do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

info "Checking prerequisites"

MISE="$(find_mise)" || die "mise not found.
  Install it with:  brew install mise
  (then open a new terminal, or run:  ~/.local/bin/mise activate)"

info "mise found at $MISE"

CHROME_DEFAULT="/Applications/Google Chrome.app"
CONFIG_FILE="$HOME/.config/gproxy/config.json"

if [ ! -d "$CHROME_DEFAULT" ]; then
    # Chrome can live elsewhere, but only if the agent is told so via
    # chromePath in config.json — otherwise nothing can work.
    if [ -f "$CONFIG_FILE" ] && grep -q '"chromePath"' "$CONFIG_FILE"; then
        warn "Google Chrome not at $CHROME_DEFAULT, but config.json sets chromePath — continuing."
    else
        die "Google Chrome not found at $CHROME_DEFAULT.
  Install Chrome, or set \"chromePath\" in $CONFIG_FILE and re-run."
    fi
fi

# Repo root is one level up from this script; agent dir inside it.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$REPO_ROOT/agent"
DEPLOY_DIR="$REPO_ROOT/deploy"

[ -f "$AGENT_DIR/package.json" ] || die "agent/package.json not found under $REPO_ROOT.
  The agent code has not been written/checked out yet."

info "Repo root: $REPO_ROOT"

# ---------------------------------------------------------------------------
# Node 22 via mise
# ---------------------------------------------------------------------------

info "Installing Node 22 (mise)"
# Run from the repo root so mise picks up mise.toml. No-op when already
# installed; downloads the matching 22.x otherwise.
(cd "$REPO_ROOT" && "$MISE" install)

# Resolve the concrete node binary. `mise where node` prints the install
# directory for the version mise.toml selects; the binary is <dir>/bin/node.
# NOTE: this is a real path (not a shim), so launchd can execute it directly.
NODE_DIR="$(cd "$REPO_ROOT" && "$MISE" where node)"
NODE_BIN="$NODE_DIR/bin/node"

[ -x "$NODE_BIN" ] || die "Resolved node path is not executable: $NODE_BIN"
info "Node: $NODE_BIN ($("$NODE_BIN" -v))"

# If mise later upgrades to a different 22.x directory the baked-in path
# in the plist could go stale — re-run this script to refresh it.
if [ -f "$HOME/Library/LaunchAgents/com.gproxy.agent.plist" ] && \
   ! grep -q "$NODE_BIN" "$HOME/Library/LaunchAgents/com.gproxy.agent.plist"; then
    warn "Installed plist references a different node binary — it will be re-rendered."
fi

# ---------------------------------------------------------------------------
# Agent dependencies
# ---------------------------------------------------------------------------

info "Installing agent dependencies (mise run deps)"
# The `deps` task in mise.toml runs npm ci (npm install without a
# lockfile) inside agent/ using the mise-selected node/npm.
(cd "$REPO_ROOT" && "$MISE" run deps)

# ---------------------------------------------------------------------------
# Config + token
# ---------------------------------------------------------------------------

CONFIG_DIR="$HOME/.config/gproxy"
mkdir -p "$CONFIG_DIR"

info "Ensuring auth token in $CONFIG_FILE"

# Merge the token into config.json with node itself (we just resolved it;
# no jq dependency). Prints the effective token on stdout.
# Exit codes: 0 ok, 2 config exists but is not valid JSON.
# argv[1] is the config path ($NODE_BIN -e passes trailing args through).
TOKEN="$("$NODE_BIN" -e '
const fs = require("fs");
const p = process.argv[1];
let cfg = {};
if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8");
    if (raw.trim() !== "") {
        try {
            cfg = JSON.parse(raw);
        } catch (e) {
            process.exit(2);
        }
    }
}
const okToken = typeof cfg.token === "string" && /^[0-9a-f]{32}$/.test(cfg.token);
if (!okToken) {
    cfg.token = require("crypto").randomBytes(16).toString("hex");
}
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
console.log(cfg.token);
' "$CONFIG_FILE" )" || die "$CONFIG_FILE exists but is not valid JSON.
  Fix or remove it, then re-run. (Existing keys are always preserved.)"

info "Token ready"

# ---------------------------------------------------------------------------
# Render + install the launchd plist
# ---------------------------------------------------------------------------

PLIST_DST="$HOME/Library/LaunchAgents/com.gproxy.agent.plist"
mkdir -p "$HOME/Library/LaunchAgents"

info "Rendering launchd plist -> $PLIST_DST"

# launchd does not expand ~ or PATH, so bake in absolute paths.
# Using | as the sed delimiter because the paths contain /.
# (A repo path containing | or & would break this substitution — v1 caveat.)
sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__AGENT_DIR__|$AGENT_DIR|g" \
    "$DEPLOY_DIR/com.gproxy.agent.plist" > "$PLIST_DST"

# Sanity: the rendered file must be a valid plist (and unrendered
# placeholders would make it a broken one).
/usr/bin/plutil -lint "$PLIST_DST" >/dev/null || die "Rendered plist failed plutil -lint"

# ---------------------------------------------------------------------------
# (Re)start the service
# ---------------------------------------------------------------------------

uid="$(id -u)"
SERVICE="gui/$uid/com.gproxy.agent"

info "Starting launchd agent $SERVICE"
# Boot out the old instance if any; ignore errors (not loaded yet).
launchctl bootout "$SERVICE" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$PLIST_DST" || die "launchctl bootstrap failed.
  Check the plist:  plutil -p $PLIST_DST"

info "Agent installed and running (KeepAlive restarts it; starts at login)"

# ---------------------------------------------------------------------------
# Tailnet hints
# ---------------------------------------------------------------------------

TS_IP=""
TS_DNS=""
TS_CLI="$(find_tailscale || true)"

if [ -n "$TS_CLI" ]; then
    # Tailscale IPv4 address of this Mac (first one).
    TS_IP="$("$TS_CLI" ip -4 2>/dev/null | head -n 1 || true)"
    # MagicDNS name from `tailscale status --json` (Self.DNSName), trailing
    # dot stripped. Parsed with node — no jq dependency.
    TS_DNS="$("$TS_CLI" status --json 2>/dev/null | "$NODE_BIN" -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
    try {
        const j = JSON.parse(s);
        const n = (j.Self && (j.Self.DNSName || j.Self.HostName)) || "";
        process.stdout.write(String(n).replace(/\.$/, ""));
    } catch (e) { /* leave empty; hint falls back to the IP */ }
});
' || true)"
fi

# ---------------------------------------------------------------------------
# Next steps for the human
# ---------------------------------------------------------------------------

printf '\n'
printf '%s\n' "---------------------------------------------------------------"
printf '%s\n' " gproxy agent is installed. Finish setup:"
printf '%s\n' "---------------------------------------------------------------"
printf '\n'
printf '%s\n' "1. A Chrome window (the \"appliance\" Chrome) should open shortly"
printf '%s\n' "   on this Mac. In it, sign into the WORK Google account once:"
printf '%s\n' "     https://accounts.google.com"
printf '%s\n' "   That session stays on this Mac and is what gets streamed."
printf '\n'
printf '%s\n' "2. On your PERSONAL Mac, load the extension:"
printf '%s\n' "     chrome://extensions -> Developer mode -> Load unpacked"
printf '%s\n' "     -> select the gproxy extension/ directory"
printf '\n'
printf '%s\n' "3. In the extension's options, set:"
if [ -n "$TS_DNS" ]; then
    printf '%s\n' "     agentUrl:  http://$TS_DNS:7654"
    if [ -n "$TS_IP" ]; then
        printf '%s\n' "       (or by IP:  http://$TS_IP:7654 )"
    fi
elif [ -n "$TS_IP" ]; then
    printf '%s\n' "     agentUrl:  http://$TS_IP:7654"
else
    printf '%s\n' "     agentUrl:  http://<this-macs-tailscale-name-or-ip>:7654"
    if [ -z "$TS_CLI" ]; then
        printf '%s\n' "       (tailscale CLI not found — open the Tailscale app to find"
        printf '%s\n' "        this Mac's name / IP, or run:  tailscale ip -4 )"
    fi
fi
printf '%s\n' "     token:     (copy the line below)"
printf '%s\n' ""
printf '%s\n' "       $TOKEN"
printf '%s\n' ""
printf '\n'
printf '%s\n' "Handy commands on this Mac:"
printf '%s\n' "  logs:          mise run logs"
printf '%s\n' "  status:        launchctl print gui/$uid/com.gproxy.agent"
printf '%s\n' "  foreground:    mise run agent      (stop the service first if needed)"
printf '%s\n' "  re-run me:     mise run install (idempotent)"
printf '%s\n' "  uninstall:     mise run uninstall"
printf '\n'
