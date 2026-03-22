const DATA_URL_RECENT = "./data/alerts-recent.json";
const DATA_URL_FULL = "./data/alerts.json";
const PAGE_SIZE = 100;
const VOLLEY_WINDOW_MS = 120000; // 2 minutes
const QUICK_CITIES = ["\u05D9\u05E8\u05D5\u05D7\u05DD", "\u05EA\u05DC \u05D0\u05D1\u05D9\u05D1", "\u05D9\u05D1\u05E0\u05D4", "\u05D1\u05D0\u05E8 \u05E9\u05D1\u05E2", "\u05D0\u05E9\u05D3\u05D5\u05D3", "\u05D0\u05E9\u05E7\u05DC\u05D5\u05DF", "\u05E8\u05D0\u05E9\u05D5\u05DF \u05DC\u05E6\u05D9\u05D5\u05DF"];
// ירוחם, תל אביב, יבנה, באר שבע, אשדוד, אשקלון, ראשון לציון

const state = {
  allAlerts: [],
  filteredAlerts: [],
  cities: [],
  metadata: null,
  currentPage: 1,
  volleyView: false,
  featuredCity: "",
  period: "24h",
  fullDataLoaded: false,
};

// Cache for parsed dates: alert object -> Date
const dateCache = new WeakMap();

// Leaflet map state (lazy-initialized)
let leafletMap = null;
let heatLayer = null;
let markerLayer = null;
let mapInitialized = false;

/* ── Utility ── */

function normalizeCity(value) {
  return (value || "").trim().toLocaleLowerCase();
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Parse date from an alert object, using WeakMap cache to avoid re-parsing. */
function alertDate(alert) {
  if (dateCache.has(alert)) return dateCache.get(alert);
  const d = parseDate(alert.time);
  if (d) dateCache.set(alert, d);
  return d;
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

/** Return the category key string for an alert description. */
function categoryKey(description) {
  if (!description) return "other";
  if (description.includes("\u05E8\u05E7\u05D8\u05D5\u05EA") || description.includes("\u05D8\u05D9\u05DC\u05D9\u05DD")) return "rockets";
  if (description.includes("\u05DB\u05DC\u05D9 \u05D8\u05D9\u05E1") || description.includes("\u05DE\u05E1\u05D5\u05E7")) return "aircraft";
  if (description.includes("\u05E8\u05E2\u05D9\u05D3\u05EA \u05D0\u05D3\u05DE\u05D4") || description.includes("\u05E6\u05D5\u05E0\u05DE\u05D9")) return "earthquake";
  return "other";
}

function isRecent(timeStr, thresholdMs) {
  const d = parseDate(timeStr);
  if (!d) return false;
  return Date.now() - d.getTime() < (thresholdMs || 3600000);
}

/** Return the cutoff timestamp for a period string, or 0 for "all". */
function periodCutoff(period) {
  const now = Date.now();
  if (period === "24h") return now - 24 * 3600000;
  if (period === "7d") return now - 7 * 24 * 3600000;
  if (period === "30d") return now - 30 * 24 * 3600000;
  return 0; // "all"
}

/** Filter allAlerts by period string, returning a subset array. */
function alertsInPeriod(period) {
  const cutoff = periodCutoff(period);
  if (cutoff === 0) return state.allAlerts;
  return state.allAlerts.filter((a) => {
    const d = alertDate(a);
    return d && d.getTime() >= cutoff;
  });
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

/* ── Volley Grouping (O(n) – only check last volley) ── */

function groupIntoVolleys(alerts) {
  const volleys = [];
  for (const alert of alerts) {
    const d = alertDate(alert);
    if (!d) continue;
    const ms = d.getTime();

    // Since alerts are sorted newest-first, only compare against the last volley.
    const last = volleys.length > 0 ? volleys[volleys.length - 1] : null;
    if (last && Math.abs(ms - last.time) <= VOLLEY_WINDOW_MS) {
      if (!last.cities.includes(alert.city)) last.cities.push(alert.city);
      last.alerts.push(alert);
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

/* ── Render: Metadata & City Options ── */

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
  const frag = document.createDocumentFragment();
  state.cities.forEach((city) => {
    const opt = document.createElement("option");
    opt.value = city;
    frag.appendChild(opt);
  });
  datalist.appendChild(frag);
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
  const normalizedFeatured = normalizeCity(city);
  const cityAlerts = state.allAlerts.filter((a) => normalizeCity(a.city) === normalizedFeatured);

  if (cityAlerts.length === 0) return;

  panel.style.display = "";
  document.getElementById("featuredName").textContent = city;
  document.getElementById("featuredTotal").textContent = String(cityAlerts.length);

  const lastAlert = cityAlerts[0]; // allAlerts is already reversed (newest first)
  document.getElementById("featuredLast").textContent = lastAlert ? formatTime(lastAlert.time) : "-";

  // Count volleys in last 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600000;
  const recentAlerts = cityAlerts.filter((a) => {
    const d = alertDate(a);
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

/* ── Render: Table ── */

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
    renderPagination(state.filteredAlerts.length);
    return;
  }

  const featuredNorm = normalizeCity(state.featuredCity);
  const frag = document.createDocumentFragment();

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
    frag.appendChild(row);
  }

  body.appendChild(frag);
  // BUG FIX: always pass totalItems to renderPagination in flat view
  renderPagination(state.filteredAlerts.length);
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
  const frag = document.createDocumentFragment();

  for (const volley of pageVolleys) {
    const cat = categoryClass(volley.description);
    const hasFeatured = featuredNorm && volley.cities.some((c) => normalizeCity(c) === featuredNorm);

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
    frag.appendChild(headerRow);
  }

  body.appendChild(frag);
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
  const total = totalItems != null ? totalItems : state.filteredAlerts.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
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
      document.querySelector(".table-wrap").scrollTop = 0;
    });
    container.appendChild(btn);
  };

  addBtn("\u00AB", 1, state.currentPage === 1);
  addBtn("\u2039", state.currentPage - 1, state.currentPage === 1);

  const startPage = Math.max(1, state.currentPage - 2);
  const endPage = Math.min(totalPages, state.currentPage + 2);
  for (let i = startPage; i <= endPage; i++) {
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
    const d = alertDate(alert);
    if (!d) return false;
    if (normalizedCity && !normalizeCity(alert.city).includes(normalizedCity)) return false;
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });

  state.currentPage = 1;
  updateUrl();
  renderActiveFilters(city, fromValue, toValue);
  renderTable();
  // renderTable now always calls renderPagination internally with the correct totalItems
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
  // renderTable now always calls renderPagination internally
}

/* ── Statistics Dashboard ── */

function computeStats(period) {
  const alerts = alertsInPeriod(period);
  const cityCount = new Map();
  const catCount = { rockets: 0, aircraft: 0, earthquake: 0, other: 0 };

  for (const a of alerts) {
    const c = a.city || "unknown";
    cityCount.set(c, (cityCount.get(c) || 0) + 1);
    catCount[categoryKey(a.description)]++;
  }

  // Most targeted city
  let mostCity = "-";
  let mostCount = 0;
  for (const [city, count] of cityCount) {
    if (count > mostCount) {
      mostCount = count;
      mostCity = city;
    }
  }

  // Top 10 cities
  const topCities = [...cityCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Volleys
  const volleys = groupIntoVolleys(alerts);

  // Timeline: hourly buckets
  const cutoff = periodCutoff(period);
  const now = Date.now();
  const hourlyBuckets = new Map();

  for (const a of alerts) {
    const d = alertDate(a);
    if (!d) continue;
    // Bucket by hour: floor to the hour
    const hourTs = Math.floor(d.getTime() / 3600000) * 3600000;
    hourlyBuckets.set(hourTs, (hourlyBuckets.get(hourTs) || 0) + 1);
  }

  // Sort buckets by time
  const sortedBuckets = [...hourlyBuckets.entries()].sort((a, b) => a[0] - b[0]);

  return {
    totalAlerts: alerts.length,
    totalVolleys: volleys.length,
    citiesHit: cityCount.size,
    mostTargeted: mostCity,
    mostTargetedCount: mostCount,
    catCount,
    topCities,
    hourlyBuckets: sortedBuckets,
  };
}

function renderStats() {
  const stats = computeStats(state.period);

  // Stat cards
  document.getElementById("statAlerts").textContent = stats.totalAlerts.toLocaleString();
  document.getElementById("statVolleys").textContent = stats.totalVolleys.toLocaleString();
  document.getElementById("statCitiesHit").textContent = stats.citiesHit.toLocaleString();
  document.getElementById("statMostTargeted").textContent =
    stats.mostTargeted !== "-" ? `${stats.mostTargeted} (${stats.mostTargetedCount.toLocaleString()})` : "-";

  // Category bar chart
  renderCategoryChart(stats.catCount);

  // Top cities bar chart
  renderTopCitiesChart(stats.topCities);

  // Timeline
  renderTimeline(stats.hourlyBuckets);
}

function renderCategoryChart(catCount) {
  const container = document.getElementById("categoryChart");
  container.innerHTML = "";
  const maxVal = Math.max(...Object.values(catCount), 1);
  const labels = { rockets: "Rockets", aircraft: "Aircraft", earthquake: "Earthquake", other: "Other" };
  const colors = { rockets: "#ef4444", aircraft: "#3b82f6", earthquake: "#f59e0b", other: "#6b7280" };

  const frag = document.createDocumentFragment();
  for (const key of ["rockets", "aircraft", "earthquake", "other"]) {
    const count = catCount[key] || 0;
    const pct = maxVal > 0 ? (count / maxVal) * 100 : 0;

    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span class="bar-label">${labels[key]}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width:${pct}%;background:${colors[key]}"></div>
      </div>
      <span class="bar-value">${count.toLocaleString()}</span>
    `;
    frag.appendChild(row);
  }
  container.appendChild(frag);
}

function renderTopCitiesChart(topCities) {
  const container = document.getElementById("topCitiesChart");
  container.innerHTML = "";
  if (!topCities.length) {
    container.textContent = "No data";
    return;
  }
  const maxVal = topCities[0][1] || 1;

  const frag = document.createDocumentFragment();
  for (const [city, count] of topCities) {
    const pct = (count / maxVal) * 100;
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span class="bar-label" dir="rtl">${escapeHtml(city)}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width:${pct}%;background:#6366f1"></div>
      </div>
      <span class="bar-value">${count.toLocaleString()}</span>
    `;
    frag.appendChild(row);
  }
  container.appendChild(frag);
}

function renderTimeline(hourlyBuckets) {
  const canvas = document.getElementById("timelineCanvas");
  const ctx = canvas.getContext("2d");

  // High-DPI support
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  if (!hourlyBuckets.length) {
    ctx.fillStyle = "#888";
    ctx.font = "14px Space Grotesk, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No data for this period", W / 2, H / 2);
    return;
  }

  const maxCount = Math.max(...hourlyBuckets.map((b) => b[1]), 1);
  const padding = { top: 10, bottom: 25, left: 5, right: 5 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;
  const barW = Math.max(1, chartW / hourlyBuckets.length);

  // Draw bars
  ctx.fillStyle = "rgba(99, 102, 241, 0.7)";
  for (let i = 0; i < hourlyBuckets.length; i++) {
    const [ts, count] = hourlyBuckets[i];
    const barH = (count / maxCount) * chartH;
    const x = padding.left + i * barW;
    const y = padding.top + chartH - barH;
    ctx.fillRect(x, y, Math.max(barW - 1, 1), barH);
  }

  // Draw x-axis labels (show a few dates)
  ctx.fillStyle = "#aaa";
  ctx.font = "10px Space Grotesk, sans-serif";
  ctx.textAlign = "center";
  const labelCount = Math.min(6, hourlyBuckets.length);
  const step = Math.max(1, Math.floor(hourlyBuckets.length / labelCount));
  for (let i = 0; i < hourlyBuckets.length; i += step) {
    const [ts] = hourlyBuckets[i];
    const d = new Date(ts);
    const label = `${d.getDate()}/${d.getMonth() + 1}`;
    const x = padding.left + i * barW + barW / 2;
    ctx.fillText(label, x, H - 5);
  }

  // Draw baseline
  ctx.strokeStyle = "#444";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top + chartH);
  ctx.lineTo(padding.left + chartW, padding.top + chartH);
  ctx.stroke();
}

/* ── Heatmap ── */

function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;

  leafletMap = L.map("map", { zoomControl: true }).setView([31.5, 34.8], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(leafletMap);
}

function renderHeatmap(period) {
  initMap();

  const alerts = alertsInPeriod(period);

  // Count alerts per city
  const cityCount = new Map();
  for (const a of alerts) {
    const c = a.city || "";
    if (c) cityCount.set(c, (cityCount.get(c) || 0) + 1);
  }

  // Build heatmap data points
  const heatPoints = [];
  const cityEntries = [];

  for (const [city, count] of cityCount) {
    const coords = typeof CITY_COORDS !== "undefined" ? CITY_COORDS[city] : null;
    if (!coords) continue;
    heatPoints.push([coords[0], coords[1], count]);
    cityEntries.push({ city, count, lat: coords[0], lng: coords[1] });
  }

  // Normalize intensity: find max count
  const maxIntensity = Math.max(...cityEntries.map((e) => e.count), 1);
  const normalizedPoints = heatPoints.map(([lat, lng, count]) => [lat, lng, count / maxIntensity]);

  // Remove old layers
  if (heatLayer) {
    leafletMap.removeLayer(heatLayer);
    heatLayer = null;
  }
  if (markerLayer) {
    leafletMap.removeLayer(markerLayer);
    markerLayer = null;
  }

  // Add heat layer
  if (normalizedPoints.length > 0) {
    heatLayer = L.heatLayer(normalizedPoints, {
      radius: 20,
      blur: 15,
      maxZoom: 10,
      max: 1.0,
    }).addTo(leafletMap);
  }

  // Add circle markers for top 20 cities
  markerLayer = L.layerGroup().addTo(leafletMap);
  const top20 = cityEntries
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  for (const entry of top20) {
    const radius = Math.max(5, Math.min(20, (entry.count / maxIntensity) * 20));
    L.circleMarker([entry.lat, entry.lng], {
      radius: radius,
      fillColor: "#ef4444",
      color: "#fff",
      weight: 1,
      opacity: 0.8,
      fillOpacity: 0.6,
    })
      .bindPopup(`<strong dir="rtl">${escapeHtml(entry.city)}</strong><br>${entry.count.toLocaleString()} alerts`)
      .addTo(markerLayer);
  }
}

/** Lazy-initialize the map when it becomes visible (IntersectionObserver). */
function setupMapObserver() {
  const mapSection = document.querySelector(".map-section");
  if (!mapSection) return;

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            renderHeatmap(state.period);
            observer.disconnect();
            break;
          }
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(mapSection);
  } else {
    // Fallback: render after a short delay
    setTimeout(() => renderHeatmap(state.period), 500);
  }
}

/* ── Init ── */

async function loadData(url) {
  const dataUrl = url || DATA_URL_RECENT;
  const response = await fetch(dataUrl, { cache: "no-store" });
  if (!response.ok) {
    // Fall back to full archive if recent file doesn't exist yet
    if (dataUrl === DATA_URL_RECENT) {
      return loadData(DATA_URL_FULL);
    }
    throw new Error(`Failed to load data: ${response.status}`);
  }

  const payload = await response.json();
  state.metadata = payload.metadata;
  state.cities = payload.cities || [];
  state.allAlerts = (payload.alerts || []).slice().reverse();
  state.filteredAlerts = [...state.allAlerts];

  // Pre-cache all alert dates for performance
  for (const a of state.allAlerts) {
    alertDate(a);
  }

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

  // Render statistics
  renderStats();

  // Lazy-init map when scrolled into view
  setupMapObserver();
}

// Event listeners
document.getElementById("applyButton").addEventListener("click", applyFilters);
document.getElementById("resetButton").addEventListener("click", resetFilters);

// Volley toggle - BUG FIX: don't call renderPagination separately since renderTable handles it
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
  // renderTable now internally calls renderPagination with the correct totalItems
});

// Unified period buttons (controls both stats + map)
function switchPeriod(period) {
  const needsFull = (period === "30d" || period === "all") && !state.fullDataLoaded;

  document.querySelectorAll("#periodBtns .period-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector(`#periodBtns .period-btn[data-period="${period}"]`)?.classList.add("active");
  state.period = period;

  const note = document.getElementById("periodNote");

  if (needsFull) {
    // Auto-load full archive for 30d/All
    if (note) note.textContent = "Loading full archive...";
    loadData(DATA_URL_FULL).then(() => {
      state.fullDataLoaded = true;
      if (note) note.textContent = "";
      const wrap = document.getElementById("loadFullWrap");
      if (wrap) wrap.style.display = "none";
      renderStats();
      if (mapInitialized) renderHeatmap(state.period);
    }).catch(() => {
      if (note) note.textContent = "Failed to load full data";
    });
    return;
  }

  renderStats();
  if (mapInitialized) renderHeatmap(state.period);
}

document.querySelectorAll("#periodBtns .period-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchPeriod(btn.dataset.period));
});

// Load full archive button
const loadFullBtn = document.getElementById("loadFullBtn");
if (loadFullBtn) {
  loadFullBtn.addEventListener("click", () => {
    loadFullBtn.textContent = "Loading...";
    loadFullBtn.disabled = true;
    loadData(DATA_URL_FULL).then(() => {
      state.fullDataLoaded = true;
      const wrap = document.getElementById("loadFullWrap");
      if (wrap) wrap.style.display = "none";
    }).catch((error) => {
      loadFullBtn.textContent = "Failed - try again";
      loadFullBtn.disabled = false;
    });
  });
}

loadData().catch((error) => {
  document.getElementById("resultsBody").innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
});
