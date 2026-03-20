const DATA_URL = "./data/alerts.json";
const PAGE_SIZE = 100;
const VOLLEY_WINDOW_MS = 120000; // 2 minutes
const QUICK_CITIES = ["\u05D9\u05E8\u05D5\u05D7\u05DD", "\u05EA\u05DC \u05D0\u05D1\u05D9\u05D1 - \u05D9\u05E4\u05D5", "\u05D1\u05D0\u05E8 \u05E9\u05D1\u05E2", "\u05D0\u05E9\u05D3\u05D5\u05D3", "\u05D0\u05E9\u05E7\u05DC\u05D5\u05DF", "\u05E8\u05D0\u05E9\u05D5\u05DF \u05DC\u05E6\u05D9\u05D5\u05DF"];
// ירוחם, תל אביב - יפו, באר שבע, אשדוד, אשקלון, ראשון לציון

const state = {
  allAlerts: [],
  filteredAlerts: [],
  cities: [],
  metadata: null,
  currentPage: 1,
  volleyView: false,
  featuredCity: "",
};

/* ── Utility ── */

function normalizeCity(value) {
  return (value || "").trim().toLocaleLowerCase();
}

function parseDate(value) {
  if (!value) return null;
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

function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function formatTime(value) {
  const date = parseDate(value);
  if (!date) return value || "-";
  return date.toLocaleString("he-IL");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function categoryClass(description) {
  if (!description) return "alert-other";
  if (description.includes("\u05E8\u05E7\u05D8\u05D5\u05EA") || description.includes("\u05D8\u05D9\u05DC\u05D9\u05DD")) return "alert-rockets";
  if (description.includes("\u05DB\u05DC\u05D9 \u05D8\u05D9\u05E1") || description.includes("\u05DE\u05E1\u05D5\u05E7")) return "alert-aircraft";
  if (description.includes("\u05E8\u05E2\u05D9\u05D3\u05EA \u05D0\u05D3\u05DE\u05D4") || description.includes("\u05E6\u05D5\u05E0\u05DE\u05D9")) return "alert-earthquake";
  return "alert-other";
}

function isRecent(timeStr, thresholdMs) {
  const d = parseDate(timeStr);
  if (!d) return false;
  return Date.now() - d.getTime() < (thresholdMs || 3600000);
}

/* ── URL Parameters ── */

function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    city: params.get("city") || "",
    from: params.get("from") || "",
    to: params.get("to") || "",
  };
}

function updateUrl() {
  const city = document.getElementById("cityInput").value.trim();
  const from = document.getElementById("fromInput").value;
  const to = document.getElementById("toInput").value;
  const params = new URLSearchParams();
  if (city) params.set("city", city);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

/* ── Volley Grouping ── */

function groupIntoVolleys(alerts) {
  const volleys = [];
  for (const alert of alerts) {
    const t = parseDate(alert.time);
    if (!t) continue;
    const ms = t.getTime();

    let matched = null;
    for (const v of volleys) {
      if (Math.abs(ms - v.time) <= VOLLEY_WINDOW_MS) {
        matched = v;
        break;
      }
    }

    if (matched) {
      if (!matched.cities.includes(alert.city)) matched.cities.push(alert.city);
      matched.alerts.push(alert);
    } else {
      volleys.push({
        time: ms,
        timeStr: alert.time,
        description: alert.description || "",
        cities: [alert.city],
        alerts: [alert],
      });
    }
  }
  return volleys;
}

/* ── Render ── */

function renderMeta() {
  const m = state.metadata || {};
  document.getElementById("generatedAt").textContent = m.generated_at ? formatTime(m.generated_at) : "-";
  document.getElementById("totalAlerts").textContent = m.total_alerts ?? "-";
  document.getElementById("totalCities").textContent = m.total_cities ?? "-";
  const statusEl = document.getElementById("orefStatus");
  if (m.oref_status === "ok") {
    statusEl.textContent = "Connected";
    statusEl.className = "value oref-ok";
  } else {
    statusEl.textContent = "Archive only";
    statusEl.className = "value oref-fallback";
  }
}

function renderCityOptions() {
  const datalist = document.getElementById("cityOptions");
  datalist.innerHTML = "";
  state.cities.forEach((city) => {
    const opt = document.createElement("option");
    opt.value = city;
    datalist.appendChild(opt);
  });
}

function renderQuickCities() {
  const container = document.getElementById("quickCities");
  container.innerHTML = "";
  QUICK_CITIES.forEach((city) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quick-city-btn";
    btn.textContent = city;
    btn.addEventListener("click", () => {
      document.getElementById("cityInput").value = city;
      applyFilters();
    });
    container.appendChild(btn);
  });
}

function renderFeaturedCity() {
  const city = state.featuredCity;
  if (!city) return;

  const panel = document.getElementById("featuredCity");
  const cityAlerts = state.allAlerts.filter((a) => normalizeCity(a.city) === normalizeCity(city));

  if (cityAlerts.length === 0) return;

  panel.style.display = "";
  document.getElementById("featuredName").textContent = city;

  document.getElementById("featuredTotal").textContent = String(cityAlerts.length);

  const lastAlert = cityAlerts[0]; // allAlerts is already reversed (newest first)
  document.getElementById("featuredLast").textContent = lastAlert ? formatTime(lastAlert.time) : "-";

  // Count volleys in last 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600000;
  const recentAlerts = cityAlerts.filter((a) => {
    const d = parseDate(a.time);
    return d && d.getTime() >= sevenDaysAgo;
  });
  const recentVolleys = groupIntoVolleys(recentAlerts);
  document.getElementById("featuredVolleys").textContent = String(recentVolleys.length);

  document.getElementById("featuredFilterBtn").textContent = `Show ${city} Alerts`;
  document.getElementById("featuredFilterBtn").onclick = () => {
    document.getElementById("cityInput").value = city;
    applyFilters();
  };
}

function renderTable() {
  const body = document.getElementById("resultsBody");
  body.innerHTML = "";

  if (state.volleyView) {
    renderVolleyTable(body);
    return;
  }

  const start = (state.currentPage - 1) * PAGE_SIZE;
  const pageAlerts = state.filteredAlerts.slice(start, start + PAGE_SIZE);

  if (!pageAlerts.length) {
    body.innerHTML = '<tr><td colspan="5">No alerts matched the current filters.</td></tr>';
    return;
  }

  const featuredNorm = normalizeCity(state.featuredCity);

  for (const alert of pageAlerts) {
    const row = document.createElement("tr");
    const cat = categoryClass(alert.description);
    row.className = cat;
    if (featuredNorm && normalizeCity(alert.city) === featuredNorm) {
      row.classList.add("featured-row");
    }

    const recentDot = isRecent(alert.time) ? '<span class="recent-badge"></span> ' : "";
    row.innerHTML = `
      <td>${recentDot}${escapeHtml(formatTime(alert.time))}</td>
      <td dir="rtl">${escapeHtml(alert.city || "-")}</td>
      <td dir="rtl">${escapeHtml(alert.description || "-")}</td>
      <td>${escapeHtml(alert.origin || "-")}</td>
      <td>${escapeHtml(alert.source || "-")}</td>
    `;
    body.appendChild(row);
  }
}

function renderVolleyTable(body) {
  const volleys = groupIntoVolleys(state.filteredAlerts);
  const start = (state.currentPage - 1) * PAGE_SIZE;
  const pageVolleys = volleys.slice(start, start + PAGE_SIZE);

  if (!pageVolleys.length) {
    body.innerHTML = '<tr><td colspan="5">No alerts matched the current filters.</td></tr>';
    renderPagination(volleys.length);
    return;
  }

  const featuredNorm = normalizeCity(state.featuredCity);

  for (const volley of pageVolleys) {
    const cat = categoryClass(volley.description);
    const hasFeatured = featuredNorm && volley.cities.some((c) => normalizeCity(c) === featuredNorm);

    // Volley header row
    const headerRow = document.createElement("tr");
    headerRow.className = `volley-header ${cat}${hasFeatured ? " featured-row" : ""}`;
    const recentDot = isRecent(volley.timeStr) ? '<span class="recent-badge"></span> ' : "";
    headerRow.innerHTML = `
      <td>${recentDot}${escapeHtml(formatTime(volley.timeStr))}</td>
      <td dir="rtl" colspan="2">
        <details>
          <summary><span class="volley-badge">${volley.cities.length} cities</span> ${escapeHtml(volley.description)}</summary>
          <ul class="volley-cities">${volley.cities.map((c) => `<li${featuredNorm && normalizeCity(c) === featuredNorm ? ' class="highlight"' : ""}>${escapeHtml(c)}</li>`).join("")}</ul>
        </details>
      </td>
      <td>${escapeHtml(volley.alerts[0]?.origin || "-")}</td>
      <td>${escapeHtml(volley.alerts[0]?.source || "-")}</td>
    `;
    body.appendChild(headerRow);
  }

  renderPagination(volleys.length);
}

function renderActiveFilters(city, fromValue, toValue) {
  const parts = [];
  if (city) parts.push(`City: ${city}`);
  if (fromValue) parts.push(`From: ${formatTime(fromValue)}`);
  if (toValue) parts.push(`To: ${formatTime(toValue)}`);

  document.getElementById("activeFilters").textContent = parts.join(" | ") || "Showing all data";

  const total = state.volleyView
    ? groupIntoVolleys(state.filteredAlerts).length
    : state.filteredAlerts.length;
  document.getElementById("resultCount").textContent = `${total}${state.volleyView ? " volleys" : ""}`;
}

function renderPagination(totalItems) {
  const container = document.getElementById("pagination");
  const totalPages = Math.ceil((totalItems || state.filteredAlerts.length) / PAGE_SIZE);
  container.innerHTML = "";

  if (totalPages <= 1) return;

  const addBtn = (label, page, disabled) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.disabled = disabled;
    if (page === state.currentPage) btn.classList.add("current-page");
    btn.addEventListener("click", () => {
      state.currentPage = page;
      renderTable();
      renderPagination(totalItems);
      document.querySelector(".table-wrap").scrollTop = 0;
    });
    container.appendChild(btn);
  };

  addBtn("\u00AB", 1, state.currentPage === 1);
  addBtn("\u2039", state.currentPage - 1, state.currentPage === 1);

  // Show pages around current
  const start = Math.max(1, state.currentPage - 2);
  const end = Math.min(totalPages, state.currentPage + 2);
  for (let i = start; i <= end; i++) {
    addBtn(String(i), i, false);
  }

  addBtn("\u203A", state.currentPage + 1, state.currentPage === totalPages);
  addBtn("\u00BB", totalPages, state.currentPage === totalPages);

  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = `Page ${state.currentPage} of ${totalPages}`;
  container.appendChild(info);
}

/* ── Filters ── */

function applyFilters() {
  const city = document.getElementById("cityInput").value.trim();
  const fromValue = document.getElementById("fromInput").value;
  const toValue = document.getElementById("toInput").value;
  const fromDate = parseDate(fromValue);
  const toDate = parseDate(toValue);
  const normalizedCity = normalizeCity(city);

  state.filteredAlerts = state.allAlerts.filter((alert) => {
    const alertDate = parseDate(alert.time);
    if (!alertDate) return false;
    if (normalizedCity && normalizeCity(alert.city) !== normalizedCity) return false;
    if (fromDate && alertDate < fromDate) return false;
    if (toDate && alertDate > toDate) return false;
    return true;
  });

  state.currentPage = 1;
  updateUrl();
  renderActiveFilters(city, fromValue, toValue);
  renderTable();
  renderPagination();
}

function resetFilters() {
  document.getElementById("cityInput").value = "";
  document.getElementById("fromInput").value = "";
  document.getElementById("toInput").value = "";
  state.filteredAlerts = [...state.allAlerts];
  state.currentPage = 1;
  history.replaceState(null, "", location.pathname);
  renderActiveFilters("", "", "");
  renderTable();
  renderPagination();
}

/* ── Init ── */

async function loadData() {
  const response = await fetch(DATA_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${DATA_URL}: ${response.status}`);

  const payload = await response.json();
  state.metadata = payload.metadata;
  state.cities = payload.cities || [];
  state.allAlerts = (payload.alerts || []).slice().reverse();
  state.filteredAlerts = [...state.allAlerts];

  renderMeta();
  renderCityOptions();
  renderQuickCities();

  // Apply URL params or default to today
  const params = getUrlParams();
  if (params.city) {
    document.getElementById("cityInput").value = params.city;
    state.featuredCity = params.city;
  } else {
    state.featuredCity = QUICK_CITIES[0]; // Default featured: ירוחם
  }

  if (params.from) {
    document.getElementById("fromInput").value = params.from;
  } else {
    document.getElementById("fromInput").value = toDateTimeLocalValue(startOfToday());
  }

  if (params.to) {
    document.getElementById("toInput").value = params.to;
  } else {
    document.getElementById("toInput").value = toDateTimeLocalValue(new Date());
  }

  renderFeaturedCity();
  applyFilters();
}

// Event listeners
document.getElementById("applyButton").addEventListener("click", applyFilters);
document.getElementById("resetButton").addEventListener("click", resetFilters);
document.getElementById("volleyToggle").addEventListener("click", () => {
  state.volleyView = !state.volleyView;
  state.currentPage = 1;
  const btn = document.getElementById("volleyToggle");
  btn.textContent = state.volleyView ? "Flat View" : "Volley View";
  btn.classList.toggle("active", state.volleyView);
  const city = document.getElementById("cityInput").value.trim();
  const fromValue = document.getElementById("fromInput").value;
  const toValue = document.getElementById("toInput").value;
  renderActiveFilters(city, fromValue, toValue);
  renderTable();
  renderPagination();
});

loadData().catch((error) => {
  document.getElementById("resultsBody").innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
});
