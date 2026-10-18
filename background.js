const AUTH_ENDPOINT = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_ENDPOINT = "https://api.linkedin.com/oauth/v2/accessToken";
const USERINFO_ENDPOINT = "https://api.linkedin.com/v2/userinfo";
const ME_ENDPOINT =
  "https://api.linkedin.com/v2/me?projection=(id,firstName,lastName,localizedFirstName,localizedLastName,profilePicture(displayImage~:playableStreams))";
const EMAIL_ENDPOINT =
  "https://api.linkedin.com/v2/emailAddress?q=members&projection=(elements*(handle~))";

const SCOPE_SETS = {
  oidc: ["openid", "profile", "email"],
  legacy: ["r_liteprofile", "r_emailaddress"]
};

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("sidePanel behavior:", e));

function toBase64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toBase64Url(new Uint8Array(digest));
}

function formBody(params) {
  return new URLSearchParams(params).toString();
}

async function logStep(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  console.log("[LCR]", line);
  const { debugLog = [] } = await chrome.storage.local.get("debugLog");
  debugLog.push(line);
  await chrome.storage.local.set({ debugLog: debugLog.slice(-40) });
}

async function getConfig() {
  const { clientId } = await chrome.storage.local.get("clientId");
  if (!clientId) throw new Error("LinkedIn Client ID save nahi hua — panel me Client ID daalo.");
  return { clientId, redirectUri: chrome.identity.getRedirectURL() };
}

async function requestToken(params) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody(params)
  });
  if (!res.ok) {
    const text = await res.text();
    await logStep(`token request fail ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`Token request fail (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function storeTokens(tokens) {
  await chrome.storage.local.set({
    access_token: tokens.access_token,
    expires_at: Date.now() + (tokens.expires_in || 0) * 1000,
    refresh_token: tokens.refresh_token || "",
    id_token: tokens.id_token || ""
  });
}

function authedGet(url, accessToken) {
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function fetchProfile(accessToken, mode = "oidc") {
  if (mode === "legacy") {
    const meRes = await authedGet(ME_ENDPOINT, accessToken);
    if (!meRes.ok) throw new Error(`/v2/me fail (${meRes.status}): ${(await meRes.text()).slice(0, 200)}`);
    const me = await meRes.json();

    let email = "";
    try {
      const emailRes = await authedGet(EMAIL_ENDPOINT, accessToken);
      if (emailRes.ok) {
        const data = await emailRes.json();
        email = data.elements?.[0]?.["handle~"]?.emailAddress || "";
      }
    } catch (_) {}

    const elements = me.profilePicture?.["displayImage~"]?.elements || [];
    const picture = elements.length ? elements[elements.length - 1].identifiers?.[0]?.url || "" : "";

    const profile = {
      sub: me.id || "",
      name: me.localizedFirstName
        ? `${me.localizedFirstName} ${me.localizedLastName || ""}`.trim()
        : [me.firstName?.localized?.en_US, me.lastName?.localized?.en_US].filter(Boolean).join(" "),
      given_name: me.localizedFirstName || "",
      family_name: me.localizedLastName || "",
      picture,
      email,
      email_verified: !!email,
      locale: ""
    };
    await chrome.storage.local.set({ profile });
    await logStep(`legacy profile ok: ${JSON.stringify(profile).slice(0, 200)}`);
    return profile;
  }

  const res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text();
    await logStep(`userinfo fail ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`Profile fetch fail (${res.status}): ${text.slice(0, 200)}`);
  }
  const profile = await res.json();
  await chrome.storage.local.set({ profile });
  return profile;
}

async function getValidAccessToken() {
  const { access_token, expires_at, refresh_token } = await chrome.storage.local.get([
    "access_token",
    "expires_at",
    "refresh_token"
  ]);
  if (!access_token) throw new Error("Signed in nahi ho.");
  if (Date.now() < (expires_at || 0) - 60000) return access_token;
  if (!refresh_token) throw new Error("Session expire ho gaya — dobara sign in karo.");

  const { clientId } = await getConfig();
  const tokens = await requestToken({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refresh_token
  });
  await storeTokens(tokens);
  return tokens.access_token;
}

async function authorizeOnce(clientId, redirectUri, mode) {
  const verifier = randomString(32);
  const challenge = await sha256Base64Url(verifier);
  const state = randomString(16);

  const authUrl =
    `${AUTH_ENDPOINT}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(SCOPE_SETS[mode].join(" "))}` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256`;

  await logStep(`authorize(${mode}) | scopes=${SCOPE_SETS[mode].join(" ")}`);

  let redirectUrl;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (e) {
    await logStep(`launchWebAuthFlow threw: ${e.message || e}`);
    throw new Error(
      `Login window fail: ${e.message || e}. ` +
        `Aksar wajah: LinkedIn app me redirect URL exact nahi hai (https:// aur trailing / chahiye).`
    );
  }

  await logStep(`redirect: ${redirectUrl}`);
  const returned = new URL(redirectUrl);
  const error = returned.searchParams.get("error");
  if (error) {
    const desc = returned.searchParams.get("error_description") || "";
    await logStep(`oauth error: ${error} ${desc}`);
    const err = new Error(`${error} ${desc}`.trim());
    err.oauthError = error;
    throw err;
  }
  if (returned.searchParams.get("state") !== state) throw new Error("OAuth state mismatch — flow dobara chalao.");
  const code = returned.searchParams.get("code");
  if (!code) throw new Error("Authorization code nahi mila.");

  const tokens = await requestToken({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier
  });
  await logStep(`token ok (${mode}), expires_in=${tokens.expires_in}, refresh=${tokens.refresh_token ? "yes" : "no"}`);
  return tokens;
}

async function login() {
  const { clientId, redirectUri } = await getConfig();
  const { scopeMode } = await chrome.storage.local.get("scopeMode");
  const order = scopeMode === "legacy" ? ["legacy", "oidc"] : ["oidc", "legacy"];

  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const mode = order[i];
    try {
      const tokens = await authorizeOnce(clientId, redirectUri, mode);
      await storeTokens(tokens);
      await chrome.storage.local.set({ scopeMode: mode });
      const profile = await fetchProfile(tokens.access_token, mode);
      return { profile, expiresAt: Date.now() + (tokens.expires_in || 0) * 1000, scopeMode: mode };
    } catch (e) {
      lastErr = e;
      if (!/invalid_scope/i.test(e.message || "") || i === order.length - 1) throw e;
      await logStep(`scopes "${mode}" invalid LinkedIn ko — fallback "${order[i + 1]}" try kar rahe hain`);
    }
  }
  throw lastErr;
}

async function logout() {
  await chrome.storage.local.remove([
    "access_token",
    "expires_at",
    "refresh_token",
    "id_token",
    "profile",
    "scopeMode"
  ]);
}

async function status() {
  const { access_token, expires_at, profile, clientId, scopeMode } = await chrome.storage.local.get([
    "access_token",
    "expires_at",
    "profile",
    "clientId",
    "scopeMode"
  ]);
  const authenticated = !!access_token;
  let freshProfile = profile || null;
  let error = "";

  if (authenticated) {
    try {
      const token = await getValidAccessToken();
      freshProfile = await fetchProfile(token, scopeMode || "oidc");
    } catch (e) {
      error = e.message || String(e);
    }
  }

  return {
    ok: true,
    authenticated,
    profile: freshProfile,
    expiresAt: expires_at || 0,
    clientId: clientId || "",
    redirectUri: chrome.identity.getRedirectURL(),
    scopeMode: scopeMode || "",
    error
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    switch (msg.type) {
      case "status":
        return await status();
      case "login":
        return { ok: true, ...(await login()) };
      case "logout":
        await logout();
        return { ok: true };
      case "debug":
        return { ok: true, log: (await chrome.storage.local.get("debugLog")).debugLog || [] };
      case "clearDebug":
        await chrome.storage.local.remove("debugLog");
        return { ok: true };
      case "refresh": {
        const token = await getValidAccessToken();
        const { scopeMode } = await chrome.storage.local.get("scopeMode");
        const profile = await fetchProfile(token, scopeMode || "oidc");
        return { ok: true, profile };
      }
      default:
        return { ok: false, error: "Unknown message" };
    }
  };

  run()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});
