const DATA_URL = "./data/alerts.json";

const state = {
  allAlerts: [],
  filteredAlerts: [],
  cities: [],
  metadata: null,
};

function parseDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateTimeLocalValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatTime(value) {
  const date = parseDate(value);
  if (!date) {
    return value || "-";
  }
  return date.toLocaleString();
}

function renderMeta() {
  const metadata = state.metadata || {};
  document.getElementById("generatedAt").textContent = metadata.generated_at ? formatTime(metadata.generated_at) : "-";
  document.getElementById("totalAlerts").textContent = metadata.total_alerts ?? "-";
  document.getElementById("totalCities").textContent = metadata.total_cities ?? "-";
  document.getElementById("orefStatus").textContent = metadata.oref_status === "ok" ? "OK" : "CSV fallback";
}

function renderCityOptions() {
  const options = document.getElementById("cityOptions");
  options.innerHTML = "";
  state.cities.forEach((city) => {
    const option = document.createElement("option");
    option.value = city;
    options.appendChild(option);
  });
}

function renderTable() {
  const body = document.getElementById("resultsBody");
  body.innerHTML = "";

  if (!state.filteredAlerts.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="5">No alerts matched the current filters.</td>';
    body.appendChild(row);
    return;
  }

  for (const alert of state.filteredAlerts) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${formatTime(alert.time)}</td>
      <td>${alert.city || "-"}</td>
      <td>${alert.description || "-"}</td>
      <td>${alert.origin || "-"}</td>
      <td>${alert.source || "-"}</td>
    `;
    body.appendChild(row);
  }
}

function renderActiveFilters(city, fromValue, toValue) {
  const parts = [];
  if (city) {
    parts.push(`City: ${city}`);
  }
  if (fromValue) {
    parts.push(`From: ${formatTime(fromValue)}`);
  }
  if (toValue) {
    parts.push(`To: ${formatTime(toValue)}`);
  }

  document.getElementById("activeFilters").textContent = parts.join(" | ") || "Showing all data";
  document.getElementById("resultCount").textContent = String(state.filteredAlerts.length);
}

function applyFilters() {
  const city = document.getElementById("cityInput").value.trim();
  const fromValue = document.getElementById("fromInput").value;
  const toValue = document.getElementById("toInput").value;
  const fromDate = parseDate(fromValue);
  const toDate = parseDate(toValue);

  state.filteredAlerts = state.allAlerts.filter((alert) => {
    const alertDate = parseDate(alert.time);
    if (!alertDate) {
      return false;
    }
    if (city && !alert.city.toLowerCase().includes(city.toLowerCase())) {
      return false;
    }
    if (fromDate && alertDate < fromDate) {
      return false;
    }
    if (toDate && alertDate > toDate) {
      return false;
    }
    return true;
  });

  renderActiveFilters(city, fromValue, toValue);
  renderTable();
}

function resetFilters() {
  document.getElementById("cityInput").value = "";
  document.getElementById("fromInput").value = "";
  document.getElementById("toInput").value = "";
  state.filteredAlerts = [...state.allAlerts];
  renderActiveFilters("", "", "");
  renderTable();
}

async function loadData() {
  const response = await fetch(DATA_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${DATA_URL}: ${response.status}`);
  }
  const payload = await response.json();
  state.metadata = payload.metadata;
  state.cities = payload.cities || [];
  state.allAlerts = (payload.alerts || []).slice().reverse();
  state.filteredAlerts = [...state.allAlerts];

  renderMeta();
  renderCityOptions();

  if (state.allAlerts.length) {
    const newest = parseDate(state.allAlerts[0].time);
    const oldest = parseDate(state.allAlerts[state.allAlerts.length - 1].time);
    if (newest) {
      document.getElementById("toInput").value = toDateTimeLocalValue(newest);
    }
    if (oldest) {
      document.getElementById("fromInput").value = toDateTimeLocalValue(oldest);
    }
  }

  applyFilters();
}

document.getElementById("applyButton").addEventListener("click", applyFilters);
document.getElementById("resetButton").addEventListener("click", resetFilters);

loadData().catch((error) => {
  document.getElementById("resultsBody").innerHTML = `<tr><td colspan="5">${error.message}</td></tr>`;
});
