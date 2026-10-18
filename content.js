// LinkedIn Contact Reader - content script
// Sirf wohi data parse karta hai jo Contact info popup mein already screen par dikh raha hai.

(function () {
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const PHONE_RE = /\+?\d[\d\s\-().]{6,}\d/;

  let debounceTimer = null;
  let lastSavedKey = "";

  function getSlug() {
    const m = location.pathname.match(/\/in\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function findContactDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal');
    for (const d of dialogs) {
      const text = d.innerText || "";
      if (/contact info/i.test(text) || d.querySelector('a[href^="mailto:"]')) return d;
    }
    return null;
  }

  function parseName(dialog) {
    // Modal ke andar h1 aksar naam hota hai, warna page ka h1
    const candidates = [
      dialog.querySelector("h1"),
      document.querySelector("main h1"),
      document.querySelector("h1")
    ];
    for (const el of candidates) {
      const t = el && el.innerText.trim();
      if (t && !/^contact info$/i.test(t)) return t;
    }
    return document.title.replace(/\s*\|\s*LinkedIn.*$/i, "").trim() || "Unknown";
  }

  function parseEmail(dialog) {
    const a = dialog.querySelector('a[href^="mailto:"]');
    if (a) return a.getAttribute("href").replace(/^mailto:/i, "").split("?")[0].trim();
    const m = (dialog.innerText || "").match(EMAIL_RE);
    return m ? m[0] : "";
  }

  function parsePhone(dialog) {
    // 1) tel: link
    const tel = dialog.querySelector('a[href^="tel:"]');
    if (tel) return tel.getAttribute("href").replace(/^tel:/i, "").trim();

    // 2) "Phone" heading ke baad wala text
    const headings = dialog.querySelectorAll("h1,h2,h3,h4,header");
    for (const h of headings) {
      if (/^phone/i.test(h.innerText.trim())) {
        const block = h.parentElement ? h.parentElement.innerText : "";
        const m = block.match(PHONE_RE);
        if (m) return m[0].trim();
      }
    }
    return "";
  }

  function parseExtras(dialog) {
    const websites = [...dialog.querySelectorAll("a[href^='http']")]
      .map((a) => a.href)
      .filter((h) => !/linkedin\.com\/(in|company|legal|help)/i.test(h))
      .slice(0, 3);
    return websites.join(" | ");
  }

  function toast(msg) {
    const old = document.getElementById("lcr-toast");
    if (old) old.remove();
    const el = document.createElement("div");
    el.id = "lcr-toast";
    el.textContent = msg;
    el.style.cssText =
      "position:fixed;bottom:24px;right:24px;z-index:2147483647;background:#0a66c2;color:#fff;" +
      "padding:10px 16px;border-radius:8px;font:14px system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.25)";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  function save(record) {
    chrome.storage.local.get({ contacts: {} }, ({ contacts }) => {
      contacts[record.slug] = { ...contacts[record.slug], ...record };
      chrome.storage.local.set({ contacts }, () => {
        const parts = [record.email, record.phone].filter(Boolean);
        toast(parts.length ? "Saved: " + parts.join(" · ") : "Contact info mein email/phone nahi mila");
      });
    });
  }

  function scan() {
    const slug = getSlug();
    if (!slug) return;
    const dialog = findContactDialog();
    if (!dialog) { lastSavedKey = ""; return; }

    const email = parseEmail(dialog);
    const phone = parsePhone(dialog);
    const key = slug + "|" + email + "|" + phone;
    if (key === lastSavedKey) return;
    if (!email && !phone) return; // modal abhi load ho raha hoga

    lastSavedKey = key;
    save({
      slug,
      name: parseName(dialog),
      profileUrl: "https://www.linkedin.com/in/" + slug + "/",
      email,
      phone,
      other: parseExtras(dialog),
      savedAt: new Date().toISOString()
    });
  }

  // LinkedIn SPA hai, isliye DOM changes observe karte hain
  new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, 400);
  }).observe(document.body, { childList: true, subtree: true });
})();
