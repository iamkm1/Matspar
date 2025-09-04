const API = ""; // same-origin
const $ = (sel) => document.querySelector(sel);
const $tbody = $("#itemsTable tbody");

// Auth elements
const authEmail = $("#authEmail");
const authPass  = $("#authPass");
const registerBtn = $("#registerBtn");
const loginBtn    = $("#loginBtn");
const logoutBtn   = $("#logoutBtn");
const authStatus  = $("#authStatus");
const needLoginHint = $("#needLoginHint");

// Add item elements
const searchInput   = $("#foodSearch");
const suggestions   = $("#suggestions");
const quantityInput = $("#quantity");
const dateInput     = $("#exp");
const warning       = $("#warning");
const saveBtn       = $("#saveBtn");

// ---- State ----
let selectedFood = null;
let debounceTimer;
let latestQuery = "";

// =====================
// Auth helpers
// =====================
function getToken() { return localStorage.getItem("matspar_token") || ""; }
function setToken(t) { t ? localStorage.setItem("matspar_token", t) : localStorage.removeItem("matspar_token"); }
function isAuthed()  { return !!getToken(); }
function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function whoAmI() {
  const t = getToken();
  if (!t) {
    authStatus.textContent = "Ikke innlogget";
    needLoginHint.textContent = "Tips: Logg inn for å kunne lagre og se varer.";
    setSaveDisabled(true);
    return null;
  }
  try {
    const res = await fetch(`${API}/api/auth/me`, { headers: authHeaders() });
    if (!res.ok) throw new Error("not ok");
    const data = await res.json();
    authStatus.textContent = `Innlogget som ${data.user.email}`;
    needLoginHint.textContent = "";
    enableSaveIfReady(); // re-aktiver hvis feltene er fylt
    return data.user;
  } catch {
    setToken("");
    authStatus.textContent = "Ikke innlogget";
    needLoginHint.textContent = "Logg inn for å kunne lagre og se varer.";
    setSaveDisabled(true);
    return null;
  }
}

registerBtn.addEventListener("click", async () => {
  const email = authEmail.value.trim();
  const password = authPass.value;
  if (!email || !password) { alert("Skriv e-post og passord"); return; }
  const res = await fetch(`${API}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || "Registrering feilet"); return; }
  setToken(data.token);
  await whoAmI();
  await refreshItems();
});

loginBtn.addEventListener("click", async () => {
  const email = authEmail.value.trim();
  const password = authPass.value;
  if (!email || !password) { alert("Skriv e-post og passord"); return; }
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || "Innlogging feilet"); return; }
  setToken(data.token);
  await whoAmI();
  await refreshItems();
});

logoutBtn.addEventListener("click", async () => {
  setToken("");
  authStatus.textContent = "Ikke innlogget";
  needLoginHint.textContent = "Logg inn for å kunne lagre og se varer.";
  $tbody.innerHTML = "";
  setSaveDisabled(true);
});

// =====================
// Dato-hjelpere (YYYY-MM-DD)
// =====================
function parseLocalDate(ymd) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function todayLocal() { const t = new Date(); t.setHours(0,0,0,0); return t; }
function daysDiff(a, b) { return Math.ceil((a.getTime() - b.getTime()) / (1000*60*60*24)); }

// =====================
// Varsel ved dato
// =====================
function renderWarning() {
  warning.hidden = true;
  warning.textContent = "";
  const val = dateInput.value;
  if (!val) return;

  const exp = parseLocalDate(val);
  const diffDays = daysDiff(exp, todayLocal());

  if (diffDays < 0) {
    warning.hidden = false;
    warning.textContent = `⚠️ Utløpt (${Math.abs(diffDays)} dag(er) siden).`;
  } else if (diffDays <= 3) {
    warning.hidden = false;
    warning.textContent = `⏰ Snart utløpt (om ${diffDays} dag(er)).`;
  }
}

// =====================
// Autoforslag
// =====================
async function fetchSuggestions(q) {
  latestQuery = q;
  const res = await fetch(`${API}/api/foods?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  if (latestQuery !== q) return [];
  return data;
}
function clearSuggestions() { suggestions.innerHTML = ""; }
function showSuggestions(list) {
  clearSuggestions();
  list.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item.name;
    li.addEventListener("click", () => selectFood(item));
    suggestions.appendChild(li);
  });
}
function selectFood(item) {
  selectedFood = item;
  searchInput.value = item.name;
  clearSuggestions();
  enableSaveIfReady();
}

searchInput.addEventListener("input", () => {
  selectedFood = null;
  enableSaveIfReady();
  const q = searchInput.value.trim();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (!q) { clearSuggestions(); return; }
    const list = await fetchSuggestions(q);
    showSuggestions(list);
  }, 180);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = suggestions.querySelector("li");
    if (first) first.click();
  }
});

[quantityInput, dateInput].forEach((el) =>
  el.addEventListener("input", () => { renderWarning(); enableSaveIfReady(); })
);

// =====================
// Statusfelt
// =====================
function statusFor(expStr) {
  const exp = parseLocalDate(expStr);
  const diffDays = daysDiff(exp, todayLocal());
  if (diffDays < 0) return { label: "Utløpt", cls: "status-expired" };
  if (diffDays <= 3) return { label: "Snart utløpt", cls: "status-soon" };
  return { label: "OK", cls: "status-ok" };
}

// =====================
// Hent/tegn rader
// =====================
async function refreshItems() {
  if (!isAuthed()) {
    $tbody.innerHTML = "";
    return;
  }
  const res = await fetch(`${API}/api/items`, { headers: authHeaders() });
  if (!res.ok) {
    if (res.status === 401) {
      setToken("");
      await whoAmI();
      return;
    }
    alert("Kunne ikke hente varer.");
    return;
  }
  const rows = await res.json();
  $tbody.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const s = statusFor(r.expiration_date);
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.quantity}</td>
      <td>${r.expiration_date}</td>
      <td class="${s.cls}">${s.label}</td>
      <td><button data-id="${r.id}" class="deleteBtn">Slett</button></td>
      <td><button data-id="${r.id}" class="editBtn">Endre</button></td>
    `;
    $tbody.appendChild(tr);
  });

  // Slett
  document.querySelectorAll(".deleteBtn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.getAttribute("data-id");
      if (confirm("Slette denne varen?")) {
        await fetch(`${API}/api/items/${id}`, {
          method: "DELETE",
          headers: { ...authHeaders() }
        });
        await refreshItems();
      }
    });
  });

  // Endre
  document.querySelectorAll(".editBtn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.getAttribute("data-id");

      const newQuantityRaw = prompt("Nytt antall (tom = uendret):");
      const newDateRaw = prompt("Ny utløpsdato (ÅÅÅÅ-MM-DD, f.eks. 2025-09-15) (tom = uendret):");

      function normalizeISO(s) {
        if (!s) return undefined;
        const t = s.trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined;
      }

      const payload = {};
      if (newQuantityRaw && !Number.isNaN(Number(newQuantityRaw))) {
        payload.quantity = Number(newQuantityRaw);
      }

      const iso = normalizeISO(newDateRaw || "");
      if (newDateRaw && !iso) {
        alert("Ugyldig dato. Bruk formatet ÅÅÅÅ-MM-DD (f.eks. 2025-09-15).");
        return;
      }
      if (iso) payload.expirationDate = iso;

      if (Object.keys(payload).length === 0) return;

      await fetch(`${API}/api/items/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload)
      });

      await refreshItems();
    });
  });
}

// =====================
// Lagre ny vare
// =====================
function setSaveDisabled(v) { saveBtn.disabled = v; }
function enableSaveIfReady() {
  const ready = selectedFood && dateInput.value && Number(quantityInput.value) > 0 && isAuthed();
  setSaveDisabled(!ready);
}

saveBtn.addEventListener("click", async () => {
  if (!isAuthed()) { alert("Logg inn først."); return; }
  const payload = {
    foodId: selectedFood.foodId,
    name: selectedFood.name,
    quantity: Number(quantityInput.value) || 1,
    expirationDate: dateInput.value // HTML <input type="date"> gir ISO (YYYY-MM-DD)
  };
  const res = await fetch(`${API}/api/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (res.ok && data.ok) {
    await refreshItems();
    searchInput.value = "";
    selectedFood = null;
    quantityInput.value = 1;
    dateInput.value = "";
    renderWarning();
    enableSaveIfReady();
  } else {
    alert(data.error || "Kunne ikke lagre.");
    if (res.status === 401) { setToken(""); await whoAmI(); }
  }
});

// =====================
// Init
// =====================
(async function init() {
  await whoAmI();
  await refreshItems();
})();
