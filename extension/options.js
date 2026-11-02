"use strict";

// gproxy options — persists agentUrl / token / mode to chrome.storage.local.

var DEFAULT_AGENT = "http://work-mac:7654";
var SAVED_FLASH_MS = 2000;

var $agentUrl = document.getElementById("agentUrl");
var $token = document.getElementById("token");
var $modeReplace = document.getElementById("mode-replace");
var $modeNewtab = document.getElementById("mode-newtab");
var $save = document.getElementById("save");
var $saved = document.getElementById("saved");
var $err = document.getElementById("err");
var savedTimer = 0;

load();

function load() {
  chrome.storage.local.get(["agentUrl", "token", "mode"], function (got) {
    $agentUrl.value = got.agentUrl || DEFAULT_AGENT;
    $token.value = got.token || "";
    if (got.mode === "newtab") $modeNewtab.checked = true;
    else $modeReplace.checked = true;
  });
}

$save.addEventListener("click", function () {
  $err.textContent = "";
  var agentUrl = $agentUrl.value.trim().replace(/\/+$/, "");
  var token = $token.value.trim();

  if (!/^https?:\/\//i.test(agentUrl)) {
    $err.textContent = "Agent URL must start with http:// or https://";
    return;
  }

  chrome.storage.local.set(
    { agentUrl: agentUrl, token: token, mode: $modeNewtab.checked ? "newtab" : "replace" },
    function () {
      if (chrome.runtime.lastError) {
        $err.textContent = "Save failed: " + chrome.runtime.lastError.message;
        return;
      }
      $agentUrl.value = agentUrl; // show the normalized value
      $saved.classList.add("show");
      clearTimeout(savedTimer);
      savedTimer = setTimeout(function () { $saved.classList.remove("show"); }, SAVED_FLASH_MS);
    });
});
