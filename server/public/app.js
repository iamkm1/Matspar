const API = ""; // same-origin
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

// --- HJELPER: lag lokal dato fra 'YYYY-MM-DD' uten tidsone-problemer ---
function parseLocalDate(ymd) {
  if (!ymd) return null;
  // Forventer "YYYY-MM-DD"
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1); // Lokal tid, midnatt
}

// --- HJELPER: dagens dato (lokal) satt til 00:00 ---
function todayLocal() {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

function daysDiff(a, b) {
  const ms = a.getTime() - b.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function renderWarning() {
  warning.hidden = true;
  warning.textContent = "";
  const val = dateInput.value;
  if (!val) return;

  const exp = parseLocalDate(val);
  const today = todayLocal();
  const diffDays = daysDiff(exp, today);

  if (diffDays < 0) {
    warning.hidden = false;
    warning.textContent = `⚠️ Varen er utløpt (${Math.abs(diffDays)} dag(er) siden).`;
  } else if (diffDays <= 3) {
    warning.hidden = false;
    warning.textContent = `⏰ Utløper snart (om ${diffDays} dag(er)).`;
  }
}

function enableSaveIfReady() {
  saveBtn.disabled = !(selectedFood && dateInput.value && Number(quantityInput.value) > 0);
}

async function fetchSuggestions(q) {
  const res = await fetch(`${API}/api/foods?q=${encodeURIComponent(q)}`);
  return res.json();
}

function clearSuggestions() { suggestions.innerHTML = ""; }

function showSuggestions(list) {
  clearSuggestions();
  list.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = `${item.name}`;
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
  el.addEventListener("input", () => {
    renderWarning();
    enableSaveIfReady();
  })
);

// --- KORREKT statuslogikk (lokal dato): Utløpt / Snart utløpt (<=3) / OK ---
function statusFor(expStr) {
  const exp = parseLocalDate(expStr);
  const today = todayLocal();
  const diffDays = daysDiff(exp, today);

  if (diffDays < 0) return { label: "Utløpt", cls: "status-expired" };
  if (diffDays <= 3) return { label: `Snart utløpt`, cls: "status-soon" };
  return { label: "OK", cls: "status-ok" };
}

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
    `;
    $tbody.appendChild(tr);
  });

  document.querySelectorAll(".deleteBtn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.getAttribute("data-id");
      if (confirm("Er du sikker på at du vil slette denne varen?")) {
        await fetch(`${API}/api/items/${id}`, { method: "DELETE" });
        await refreshItems();
      }
    });
  });
}

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

refreshItems();
