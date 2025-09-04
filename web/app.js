const API_BASE = "http://localhost:8080/api";

const $ = sel => document.querySelector(sel);
const foodInput = $("#food-input");
const sugg = $("#suggestions");
const form = $("#add-form");
const alertsList = $("#alerts");

function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function renderSuggestions(items) {
  sugg.innerHTML = "";
  if (!items?.length) {
    sugg.classList.add("hidden");
    return;
  }

  items.forEach(it => {
    const li = document.createElement("li");
    li.textContent = it.name;
    li.addEventListener("click", () => {
      foodInput.value = it.name;
      sugg.classList.add("hidden");
    });
    sugg.appendChild(li);
  });

  sugg.classList.remove("hidden");
}

const searchFoods = debounce(async () => {
  const q = foodInput.value.trim();
  if (!q) {
    sugg.classList.add("hidden");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/foods?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error("Kunne ikke hente matvarer");
    const data = await res.json();
    renderSuggestions(data);
  } catch (e) {
    console.error("Feil ved søk:", e.message);
    sugg.classList.add("hidden");
  }
}, 200);

foodInput.addEventListener("input", searchFoods);

document.addEventListener("click", e => {
  if (!sugg.contains(e.target) && e.target !== foodInput) {
    sugg.classList.add("hidden");
  }
});

form.addEventListener("submit", async e => {
  e.preventDefault();

  const email = document.querySelector("#email").value.trim();
  const productName = foodInput.value.trim();
  const expirationDate = document.querySelector("#exp").value;

  if (!email || !productName || !expirationDate) {
    return alert("Fyll ut alle feltene.");
  }

  try {
    const res = await fetch(`${API_BASE}/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, productName, expirationDate })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Ukjent feil" }));
      return alert("Kunne ikke lagre: " + err.error);
    }

    alert("Lagret! ✅");
    form.reset();
    sugg.classList.add("hidden");
  } catch (e) {
    console.error("Feil ved lagring:", e.message);
    alert("Noe gikk galt, prøv igjen.");
  }
});

document.querySelector("#check-alerts").addEventListener("click", async () => {
  const email = document.querySelector("#email").value.trim();
  const days = document.querySelector("#days").value || 3;

  if (!email) {
    return alert("Skriv inn e-post først.");
  }

  try {
    const res = await fetch(
      `${API_BASE}/alerts?email=${encodeURIComponent(email)}&days=${days}`
    );
    if (!res.ok) throw new Error("Kunne ikke hente varsler");

    const data = await res.json();
    alertsList.innerHTML = "";

    if (!data.length) {
      alertsList.innerHTML = "<li>Ingen varsler 🎉</li>";
      return;
    }

    data.forEach(({ name, expiration_date, status }) => {
      const li = document.createElement("li");
      const badge = `<span class="badge ${status}">${
        status === "expired" ? "Utløpt" : "Snart utløpt"
      }</span>`;
      li.innerHTML = `${name} – ${new Date(expiration_date).toLocaleDateString()} ${badge}`;
      alertsList.appendChild(li);
    });
  } catch (e) {
    console.error("Feil ved varsler:", e.message);
    alertsList.innerHTML = "<li>Kunne ikke hente varsler</li>";
  }
});
