const API = ""; // same-origin (server hoster API + frontend)
const $ = (sel) => document.querySelector(sel);
const $tbody = $("#itemsTable tbody");

const searchInput = $("#foodSearch");
const suggestions = $("#suggestions");
const quantityInput = $("#quantity");
const dateInput = $("#exp");
const warning = $("#warning");
const saveBtn = $("#saveBtn");

let selectedFood = null;
let debounceTimer;
let latestQuery = "";

// ---------- Hjelpere for dato ----------
function parseLocalDate(ymd) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1); // Lokal midnatt
}
function todayLocal() { const t = new Date(); t.setHours(0,0,0,0); return t; }
function daysDiff(a, b) { return Math.ceil((a.getTime() - b.getTime()) / (1000*60*60*24)); }

// ---------- Varsel ved valg av dato ----------
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
  if (latestQuery !== q) return []; // ignorer utdaterte svar
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

// ---------- Status-beregning ----------
function statusFor(expStr) {
  const exp = parseLocalDate(expStr);
  const diffDays = daysDiff(exp, todayLocal());
  if (diffDays < 0) return { label: "Utløpt", cls: "status-expired" };
  if (diffDays <= 3) return { label: "Snart utløpt", cls: "status-soon" };
  return { label: "OK", cls: "status-ok" };
}

// ---------- Hent og tegn rader ----------
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

  // Slett
  document.querySelectorAll(".deleteBtn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.getAttribute("data-id");
      if (confirm("Slette denne varen?")) {
        await fetch(`${API}/api/items/${id}`, { method: "DELETE" });
        await refreshItems();
      }
    });
  });

  // Endre (antall/utløpsdato via enkle prompts)
  document.querySelectorAll(".editBtn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.getAttribute("data-id");

      const newQuantityRaw = prompt("Nytt antall (tom = uendret):");
      const newDateRaw = prompt("Ny utløpsdato (YYYY-MM-DD) (tom = uendret):");

      const payload = {};
      if (newQuantityRaw && !Number.isNaN(Number(newQuantityRaw))) {
        payload.quantity = Number(newQuantityRaw);
      }
      if (newDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(newDateRaw)) {
        payload.expirationDate = newDateRaw;
      }

      if (Object.keys(payload).length === 0) return;

      await fetch(`${API}/api/items/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      await refreshItems();
    });
  });
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

// Init
refreshItems();
