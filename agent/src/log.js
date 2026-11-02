// One-line stdout logging. launchd captures stdout, so every event class
// (chrome lifecycle, cdp, tabs, websockets, http) prints exactly one line.

export function log(tag, detail = '') {
  const msg =
    detail instanceof Error ? detail.message
      : typeof detail === 'string' ? detail
        : detail === undefined || detail === null ? ''
          : JSON.stringify(detail);
  console.log(`${new Date().toISOString()} ${tag} ${msg}`.trimEnd());
}
