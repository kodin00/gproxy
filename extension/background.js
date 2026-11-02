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
