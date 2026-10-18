const listEl = document.getElementById("list");
const countEl = document.getElementById("count");
const qEl = document.getElementById("q");

let contacts = {};

function load() {
  chrome.storage.local.get({ contacts: {} }, (res) => {
    contacts = res.contacts;
    render();
  });
}

function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = old), 1000);
  });
}

function makeRow(label, value) {
  if (!value) return null;
  const row = document.createElement("div");
  row.className = "row";
  const l = document.createElement("span");
  l.textContent = label;
  l.style.width = "44px";
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = value;
  const b = document.createElement("button");
  b.textContent = "Copy";
  b.onclick = () => copy(value, b);
  row.append(l, v, b);
  return row;
}

function render() {
  const q = qEl.value.trim().toLowerCase();
  const items = Object.values(contacts)
    .filter((c) => !q || [c.name, c.email, c.phone].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));

  countEl.textContent = Object.keys(contacts).length + " saved";
  listEl.textContent = "";

  if (!items.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Abhi koi contact save nahi hua. Kisi connection ka LinkedIn profile kholo aur 'Contact info' par click karo.";
    listEl.appendChild(e);
    return;
  }

  for (const c of items) {
    const card = document.createElement("div");
    card.className = "card";

    const name = document.createElement("div");
    name.className = "name";
    const a = document.createElement("a");
    a.href = c.profileUrl;
    a.target = "_blank";
    a.textContent = c.name || c.slug;
    name.appendChild(a);
    card.appendChild(name);

    for (const r of [makeRow("Email", c.email), makeRow("Phone", c.phone), makeRow("Other", c.other)]) {
      if (r) card.appendChild(r);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const d = document.createElement("span");
    d.textContent = c.savedAt ? new Date(c.savedAt).toLocaleString() : "";
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "danger";
    del.onclick = () => {
      delete contacts[c.slug];
      chrome.storage.local.set({ contacts }, render);
    };
    meta.append(d, del);
    card.appendChild(meta);

    listEl.appendChild(card);
  }
}

function csvEscape(s) {
  s = String(s ?? "");
  // CSV/Excel formula injection se bachao
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

document.getElementById("export").onclick = () => {
  const rows = [["Name", "Email", "Phone", "Other", "Profile URL", "Saved At"]];
  for (const c of Object.values(contacts)) {
    rows.push([c.name, c.email, c.phone, c.other, c.profileUrl, c.savedAt]);
  }
  const csv = "\ufeff" + rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "linkedin-contacts.csv";
  a.click();
  URL.revokeObjectURL(url);
};

document.getElementById("clear").onclick = () => {
  if (confirm("Saare saved contacts delete karne hain?")) {
    chrome.storage.local.set({ contacts: {} }, load);
  }
};

qEl.addEventListener("input", render);
load();
