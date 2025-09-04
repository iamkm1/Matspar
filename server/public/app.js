const API = ""; // same-origin (server hoster både frontend og API)
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

function renderWarning() {
  warning.hidden = true;
  warning.textContent = "";
  const val = dateInput.value;
  if (!val) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const exp = new Date(val);
  const diffDays = Math.ceil((exp - today) / (1000*60*60*24));
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

// --- Status: SNUDD logikk som du ba om ---
function statusFor(expStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const exp = new Date(expStr);
  const diffDays = Math.ceil((exp - today) / (1000*60*60*24));

  // Snu: ting som var OK før blir "Utløpt", og det som var utløpt/snart utløpt blir "OK"
  if (diffDays < 0) return { label: "OK", cls: "status-ok" };
  if (diffDays <= 3) return { label: "OK", cls: "status-ok" };
  return { label: "Utløpt", cls: "status-expired" };
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
