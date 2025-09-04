const API = ""; // same-origin
const $ = (sel) => document.querySelector(sel);
const $tbody = $("#itemsTable tbody");

// Inputs / buttons
const searchInput   = $("#foodSearch");
const suggestions   = $("#suggestions");
const quantityInput = $("#quantity");
const dateInput     = $("#exp");
const warning       = $("#warning");
const saveBtn       = $("#saveBtn");

// Notification UI
const notifBell   = $("#notifBell");
const notifBadge  = $("#notifBadge");
const notifPanel  = $("#notifPanel");
const notifClose  = $("#notifClose");
const notifContent= $("#notifContent");

let selectedFood = null;
let debounceTimer;
let latestQuery = "";

// ---------- Dato-hjelpere (YYYY-MM-DD) ----------
function parseLocalDate(ymd) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function todayLocal() { const t = new Date(); t.setHours(0,0,0,0); return t; }
function daysDiff(a, b) { return Math.ceil((a.getTime() - b.getTime()) / (1000*60*60*24)); }

// ---------- Varsel under dato-input ----------
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

function enableSaveIfReady() {
  saveBtn.disabled = !(selectedFood && dateInput.value && Number(quantityInput.value) > 0);
}

// ---------- Autoforslag ----------
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

// ---------- Status ----------
function statusFor(expStr) {
  const exp = parseLocalDate(expStr);
  const diffDays = daysDiff(exp, todayLocal());
  if (diffDays < 0) return { label: "Utløpt", cls: "status-expired", diff: diffDays };
  if (diffDays <= 3) return { label: "Snart utløpt", cls: "status-soon", diff: diffDays };
  return { label: "OK", cls: "status-ok", diff: diffDays };
}

// ---------- Notification bell ----------
function updateNotifications(rows) {
  // klassifiser
  const expired = [];
  const soon = [];
  rows.forEach(r => {
    const st = statusFor(r.expiration_date);
    if (st.label === "Utløpt") expired.push({ ...r, st });
    else if (st.label === "Snart utløpt") soon.push({ ...r, st });
  });

  const total = expired.length + soon.length;
  if (total > 0) {
    notifBadge.hidden = false;
    notifBadge.textContent = String(total);
  } else {
    notifBadge.hidden = true;
  }

  // bygg panelinnhold
  notifContent.innerHTML = "";
  const addSection = (title, items, kind) => {
    if (items.length === 0) return;
    const sec = document.createElement("div");
    sec.className = "notif-section";
    sec.innerHTML = `<div class="notif-title">${title}</div>`;
    items
      .sort((a,b)=> a.expiration_date.localeCompare(b.expiration_date))
      .forEach(i => {
        const el = document.createElement("div");
        el.className = "notif-item";
        el.innerHTML = `
          <span class="dot ${kind==='expired'?'dot-expired':'dot-soon'}"></span>
          <div>
            <div><strong>${i.name}</strong> — ${i.quantity} stk</div>
            <div style="color:#6b7280;font-size:.9rem;">Utløpsdato: ${i.expiration_date}</div>
          </div>
        `;
        sec.appendChild(el);
      });
    notifContent.appendChild(sec);
  };

  addSection("Snart utløper (≤ 3 dager)", soon, "soon");
  addSection("Allerede utløpt", expired, "expired");

  if (total === 0) {
    notifContent.innerHTML = `<div class="notif-section"><div class="notif-item"><div>🎉 Ingen varsler – alt ser bra ut!</div></div></div>`;
  }
}

function openPanel() {
  notifPanel.hidden = false;
  notifBell.setAttribute("aria-expanded", "true");
}
function closePanel() {
  notifPanel.hidden = true;
  notifBell.setAttribute("aria-expanded", "false");
}

notifBell.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = notifBell.getAttribute("aria-expanded") === "true";
  isOpen ? closePanel() : openPanel();
});
notifClose.addEventListener("click", (e) => { e.stopPropagation(); closePanel(); });
document.addEventListener("click", (e) => {
  if (!notifPanel.hidden && !notifPanel.contains(e.target) && e.target !== notifBell) {
    closePanel();
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });

// ---------- Hent/tegn rader ----------
async function refreshItems() {
  const res = await fetch(`${API}/api/items`);
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

  // koble knapper
  document.querySelectorAll(".deleteBtn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.getAttribute("data-id");
      if (confirm("Slette denne varen?")) {
        await fetch(`${API}/api/items/${id}`, { method: "DELETE" });
        await refreshItems();
      }
    });
  });

  document.querySelectorAll(".editBtn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.getAttribute("data-id");
      const newQuantityRaw = prompt("Nytt antall (tom = uendret):");
      const newDateRaw = prompt("Ny utløpsdato (YYYY-MM-DD) (tom = uendret):");

      function normalizeISO(s) { if (!s) return undefined; const t = s.trim(); return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined; }

      const payload = {};
      if (newQuantityRaw && !Number.isNaN(Number(newQuantityRaw))) payload.quantity = Number(newQuantityRaw);
      const iso = normalizeISO(newDateRaw || "");
      if (newDateRaw && !iso) { alert("Ugyldig dato. Bruk YYYY-MM-DD (f.eks. 2025-09-15)."); return; }
      if (iso) payload.expirationDate = iso;

      if (Object.keys(payload).length === 0) return;

      await fetch(`${API}/api/items/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      await refreshItems();
    });
  });

  // oppdater notifikasjoner
  updateNotifications(rows);
}

// ---------- Lagre ny vare ----------
saveBtn.addEventListener("click", async () => {
  const payload = {
    userId: null,
    foodId: selectedFood.foodId,
    name: selectedFood.name,
    quantity: Number(quantityInput.value) || 1,
    expirationDate: dateInput.value
  };
  const res = await fetch(`${API}/api/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.ok) {
    await refreshItems();
    searchInput.value = "";
    selectedFood = null;
    quantityInput.value = 1;
    dateInput.value = "";
    renderWarning();
    enableSaveIfReady();
  } else {
    alert("Kunne ikke lagre (se konsoll).");
    console.error(data);
  }
});

// init
refreshItems();
