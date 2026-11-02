"use strict";

// gproxy background service worker (MV3, classic).
// Action click / link context menu -> POST {agent}/v1/open, then open
// viewer.html?tab=<agent tabId>. Agent URL and token are never put in the
// viewer URL; viewer.html reads them from chrome.storage.local itself.

var DEFAULT_AGENT = "http://work-mac:7654";
var FETCH_TIMEOUT_MS = 10000;
var DEFAULT_TITLE = "Open on work Mac";
var BADGE_CLEAR_MS = 5000;
var badgeTimer = 0;

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: "gproxy-open-link",
      title: "Open link on work Mac",
      contexts: ["link"]
    });
  });
});

chrome.action.onClicked.addListener(function (tab) {
  // Already a viewer page: nothing to open.
  if (tab && tab.url && tab.url.indexOf(chrome.runtime.getURL("")) === 0) return;
  openRemote(tab, tab.url);
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId !== "gproxy-open-link") return;
  // Context menu always opens a new viewer tab, never replaces.
  openRemote({ id: tab && tab.id, index: tab && tab.index }, info.linkUrl, true);
});

async function openRemote(originTab, url, forceNewTab) {
  try {
    if (!/^https?:/i.test(url || "")) {
      throw new Error("only http(s) pages can be opened on the work Mac (this one is " +
        ((url || "").split(":")[0] || "unknown") + ":)");
    }
    var c = await getConfig();
    if (!/^https?:\/\//i.test(c.agentUrl)) {
      throw new Error("invalid agentUrl '" + c.agentUrl + "' — set a http(s):// URL in gproxy options");
    }
    if (!c.token) {
      throw new Error("missing token — open gproxy options and paste the token printed by the work-Mac installer");
    }

    var res = await postJson(c.agentUrl + "/v1/open", { url: url }, c.token);
    if (!res.ok) throw new Error("POST /v1/open failed with HTTP " + res.status);
    var data = await res.json();
    if (!data || !data.tabId) throw new Error("POST /v1/open returned no tabId");

    var viewerUrl =
      chrome.runtime.getURL("viewer.html") +
      "?tab=" + encodeURIComponent(String(data.tabId));

    if (!forceNewTab && c.mode === "replace" && originTab && originTab.id != null) {
      chrome.tabs.update(originTab.id, { url: viewerUrl });
    } else {
      // New viewer tab, placed right after the tab we came from when known.
      var after = originTab && typeof originTab.index === "number" ? originTab.index + 1 : undefined;
      chrome.tabs.create({ url: viewerUrl, index: after });
    }
    setBadge("");
    setTitle(DEFAULT_TITLE);
  } catch (err) {
    var m = err && err.message ? err.message : String(err);
    console.error("gproxy: " + m);
    setBadge("!");
    setTitle(DEFAULT_TITLE + " — " + m);
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(function () {
      setBadge("");
      setTitle(DEFAULT_TITLE);
    }, BADGE_CLEAR_MS);
  }
}

function getConfig() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["agentUrl", "token", "mode"], function (got) {
      resolve({
        agentUrl: (got.agentUrl || DEFAULT_AGENT).trim().replace(/\/+$/, ""),
        token: (got.token || "").trim(),
        mode: got.mode === "newtab" ? "newtab" : "replace"
      });
    });
  });
}

function postJson(url, body, token) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    body: JSON.stringify(body),
    signal: ctrl.signal
  }).then(function (res) {
    clearTimeout(timer);
    return res;
  }, function (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw new Error("agent unreachable (no response within " + FETCH_TIMEOUT_MS / 1000 + "s)");
    }
    throw err;
  });
}

function setBadge(text) {
  try {
    chrome.action.setBadgeText({ text: text });
    if (text) chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  } catch (e) {
    // Badge is cosmetic; never let it mask the real failure.
  }
}

function setTitle(title) {
  try {
    chrome.action.setTitle({ title: title });
  } catch (e) {
    // Cosmetic.
  }
}

// ---------------------------------------------------------------------------
// Closing a viewer tab closes its tab on the work Mac.
//
// chrome.tabs.onRemoved does not carry the URL, so we keep a map
// chromeTabId -> agent tabId in chrome.storage.session (survives service
// worker restarts) and update it from onUpdated. Navigating a viewer tab away
// from the viewer counts as closing it; a reload does not (URL unchanged).
// ---------------------------------------------------------------------------

var VIEWER_PREFIX = chrome.runtime.getURL("viewer.html");

function agentTabOf(url) {
  if (!url || url.indexOf(VIEWER_PREFIX) !== 0) return null;
  try { return new URL(url).searchParams.get("tab") || null; } catch (e) { return null; }
}

function loadViewerMap() {
  return chrome.storage.session.get("viewers").then(function (got) {
    return got.viewers || {};
  });
}

function saveViewerMap(map) {
  return chrome.storage.session.set({ viewers: map });
}

// Serialize map updates so concurrent tab events can't clobber each other.
var mapQueue = Promise.resolve();
function withViewerMap(fn) {
  mapQueue = mapQueue.then(function () {
    return loadViewerMap().then(function (map) {
      var orphaned = fn(map);
      return saveViewerMap(map).then(function () {
        if (orphaned) return closeIfOrphan(orphaned, map);
      });
    });
  }).catch(function (err) {
    console.error("gproxy: viewer map: " + (err && err.message ? err.message : err));
  });
  return mapQueue;
}

async function closeIfOrphan(agentTab, map) {
  for (var k in map) if (map[k] === agentTab) return; // still shown elsewhere
  var c = await getConfig();
  if (!c.token) return;
  try {
    var res = await postJson(c.agentUrl + "/v1/close", { tabId: agentTab }, c.token);
    if (!res.ok && res.status !== 404) console.error("gproxy: /v1/close HTTP " + res.status);
  } catch (err) {
    console.error("gproxy: /v1/close: " + (err && err.message ? err.message : err));
  }
}

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  var url = changeInfo.url || (tab && (tab.pendingUrl || tab.url));
  if (!url) return;
  var now = agentTabOf(url);
  withViewerMap(function (map) {
    var before = map[tabId] || null;
    if (before === now) return null;
    if (now) map[tabId] = now; else delete map[tabId];
    return before; // navigated away from (or to another) viewer
  });
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  withViewerMap(function (map) {
    var before = map[tabId] || null;
    delete map[tabId];
    return before;
  });
});

// Rebuild on every service-worker start (covers extension reloads, which
// clear storage.session, and viewers opened before this code existed).
chrome.tabs.query({}).then(function (tabs) {
  withViewerMap(function (map) {
    for (var k in map) delete map[k];
    tabs.forEach(function (t) {
      var a = agentTabOf(t.pendingUrl || t.url);
      if (a) map[t.id] = a;
    });
    return null;
  });
});
