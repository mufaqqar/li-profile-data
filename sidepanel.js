const $ = (id) => document.getElementById(id);

let busy = false;

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res || res.ok === false) throw new Error((res && res.error) || "Extension error");
  return res;
}

function setError(text) {
  const el = $("authError");
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function renderProfile(profile, expiresAt, scopeMode) {
  const has = !!profile;
  $("profileWrap").classList.toggle("hidden", !has);
  $("profileEmpty").classList.toggle("hidden", has);
  $("pScopes").textContent = scopeMode === "legacy" ? "legacy (r_liteprofile + r_emailaddress)" : "openid profile email";
  if (!has) return;

  $("avatar").src = profile.picture || "";
  $("avatar").style.display = profile.picture ? "" : "none";
  $("pName").textContent = profile.name || [profile.given_name, profile.family_name].filter(Boolean).join(" ") || "Unknown";
  $("pSub").textContent = profile.sub || "";
  $("pEmail").textContent = profile.email || "—";
  $("pLocale").textContent = profile.locale || "—";
  $("pVerified").textContent = profile.email_verified ? "Yes" : "No";
  $("pExpires").textContent = expiresAt ? new Date(expiresAt).toLocaleString() : "—";
}

function setAuthState(authenticated) {
  $("login").classList.toggle("hidden", authenticated);
  $("logout").classList.toggle("hidden", !authenticated);
  $("refresh").classList.toggle("hidden", !authenticated);
  $("statusDot").textContent = authenticated ? "● connected" : "○ not signed in";
}

async function refreshStatus() {
  const res = await send({ type: "status" });
  $("clientId").value = res.clientId || "";
  $("redirectUri").textContent = res.redirectUri;
  setAuthState(res.authenticated);
  renderProfile(res.profile, res.expiresAt, res.scopeMode);
  setError(res.error || "");
}

function renderDebug(lines) {
  $("debugLog").textContent = (lines || []).join("\n") || "—";
}

async function loadDebug() {
  const res = await chrome.runtime.sendMessage({ type: "debug" });
  if (res && res.ok) renderDebug(res.log);
}

function withBusy(button, fn) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  setError("");
  fn()
    .catch((e) => setError(e.message || String(e)))
    .finally(() => {
      busy = false;
      button.disabled = false;
      refreshStatus().catch(() => {});
      loadDebug().catch(() => {});
    });
}

$("save").onclick = () => withBusy($("save"), async () => {
  const clientId = $("clientId").value.trim();
  if (!clientId) throw new Error("Client ID daalo.");
  await chrome.storage.local.set({ clientId });
});

$("login").onclick = () => withBusy($("login"), async () => {
  const res = await send({ type: "login" });
  setAuthState(true);
  renderProfile(res.profile, res.expiresAt, res.scopeMode);
});

$("logout").onclick = () => withBusy($("logout"), async () => {
  await send({ type: "logout" });
  setAuthState(false);
  renderProfile(null, 0, "");
});

$("refresh").onclick = () => withBusy($("refresh"), async () => {
  const res = await send({ type: "refresh" });
  renderProfile(res.profile, Date.now());
});

$("copyRedirect").onclick = () => {
  navigator.clipboard.writeText($("redirectUri").textContent).then(() => {
    const b = $("copyRedirect");
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = "Copy"), 1000);
  });
};

$("reloadDebug").onclick = () => loadDebug();
$("clearDebug").onclick = () => send({ type: "clearDebug" }).then(loadDebug).catch(() => {});

refreshStatus().catch((e) => setError(e.message || String(e)));
loadDebug().catch(() => {});
