# gproxy

Use your work Google account from your personal Mac. The browser session runs
in a dedicated Chrome on the work Mac. A Chrome extension on the personal Mac
shows that tab live and sends your clicks and keystrokes back to it. The two
Macs talk over Tailscale.

```
personal Mac (extension)  ──Tailscale──▶  work Mac (agent + Chrome)
```

Requirements: both Macs are on the same tailnet, Google Chrome is in
`/Applications` on the work Mac, and [mise](https://mise.jdx.dev) is installed
on the work Mac.

## 1. Work Mac

```sh
curl https://mise.run | sh   # skip if mise is already installed
git clone git@github.com:kodin00/gproxy.git ~/gproxy
cd ~/gproxy
mise trust
mise run install
```

The installer:

- installs Node and the dependencies through mise
- starts the agent as a launchd service on port 7654
- opens a separate Chrome window
- prints the **agent URL** and **token**. Keep both for step 2.

Then:

1. In the Chrome window that opened, sign in to your work Google account.
2. Open `drive.google.com` in that window to confirm it isn't blocked.
3. Keep that window open (it can sit on another Space) and keep the Mac
   awake.

If macOS asks whether `node` may accept incoming connections, click
**Allow**.

## 2. Personal Mac

1. Get the code: `git clone git@github.com:kodin00/gproxy.git`
2. Open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and select the `extension/` folder.
3. Right-click the gproxy icon and open **Options**. Enter the agent URL (for
   example `http://<work-mac-name>:7654`) and the token from step 1, then
   save.
4. Check that you can reach the agent: `curl http://<work-mac-name>:7654/health`
   should return `"ok":true`.

## Usage

- **Toolbar button:** opens the current page on the work Mac and streams it
  in this tab.
- **Right-click a link → Open link on work Mac:** opens it in a new tab.
- Inside the stream, clicking, typing, scrolling, Cmd+A/C/X/Z, paste and
  links that open new tabs all work.
- Cmd+C copies selected text to your local clipboard. This doesn't work in
  Google Docs.

## Commands (work Mac)

| Command | What it does |
|---|---|
| `mise run logs` | Tail the agent logs |
| `mise run install` | Install or update the service (safe to re-run) |
| `mise run uninstall` | Remove the service. Config and Chrome profile are kept |
| `mise run agent` | Run in the foreground (stop the service first) |
| `mise run test` | Smoke test (needs no network) |

## Troubleshooting

- **401 or "token mismatch":** the token in the extension options doesn't
  match `~/.config/gproxy/config.json` on the work Mac.
- **Can't connect:** run `tailscale ping <work-mac-name>`, and check the
  macOS firewall allows `node`.
- **Stream freezes:** the Chrome window on the work Mac is minimized, or the
  Mac went to sleep.

Protocol and design details are in [SPEC.md](SPEC.md).
