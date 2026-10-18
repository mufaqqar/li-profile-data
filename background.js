const AUTH_ENDPOINT = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_ENDPOINT = "https://api.linkedin.com/oauth/v2/accessToken";
const USERINFO_ENDPOINT = "https://api.linkedin.com/v2/userinfo";
const SCOPES = ["openid", "profile", "email"];

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

async function fetchProfile(accessToken) {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const text = await res.text();
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

async function login() {
  const { clientId, redirectUri } = await getConfig();

  const verifier = randomString(32);
  const challenge = await sha256Base64Url(verifier);
  const state = randomString(16);

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.search = formBody({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });

  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });

  const returned = new URL(redirectUrl);
  const error = returned.searchParams.get("error");
  if (error) {
    throw new Error(`LinkedIn ne mana kiya: ${error} ${returned.searchParams.get("error_description") || ""}`);
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
  await storeTokens(tokens);
  const profile = await fetchProfile(tokens.access_token);
  return { profile, expiresAt: Date.now() + (tokens.expires_in || 0) * 1000 };
}

async function logout() {
  await chrome.storage.local.remove([
    "access_token",
    "expires_at",
    "refresh_token",
    "id_token",
    "profile"
  ]);
}

async function status() {
  const { access_token, expires_at, profile, clientId } = await chrome.storage.local.get([
    "access_token",
    "expires_at",
    "profile",
    "clientId"
  ]);
  const authenticated = !!access_token;
  let freshProfile = profile || null;
  let error = "";

  if (authenticated) {
    try {
      const token = await getValidAccessToken();
      freshProfile = await fetchProfile(token);
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
      case "refresh": {
        const token = await getValidAccessToken();
        const profile = await fetchProfile(token);
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
