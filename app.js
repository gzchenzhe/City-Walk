"use strict";

const STORAGE_KEY = "city-walk-turf-demo-v1";
const EARTH_RADIUS = 6378137;
const MAX_LAT = 85.05112878;
const DEFAULT_CENTER = [31.2304, 121.4737];
const GPS_TARGET_ACCURACY = 100;
const GPS_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 20000,
};
const OWNER_COLORS = {
  me: "#20a879",
  rivalA: "#eb4967",
  rivalB: "#f2aa25",
  rivalC: "#4777e6",
};

const ownerOrder = ["rivalA", "rivalB", "rivalC"];

let map;
let territoryLayer;
let gridLayer;
let pathLayer;
let playerMarker;
let watchId = null;
let autoTimer = null;
let autoBearing = 55;
let lastPoint = null;
let gpsSessionId = 0;
let lastReverseGeocodeAt = 0;
let reverseGeocodeController = null;

const state = loadState();

const els = {
  status: document.getElementById("statusText"),
  ownedCount: document.getElementById("ownedCount"),
  footprintCount: document.getElementById("footprintCount"),
  captureCount: document.getElementById("captureCount"),
  areaCount: document.getElementById("areaCount"),
  locationText: document.getElementById("locationText"),
  controlPanel: document.getElementById("controlPanel"),
  panelToggleButton: document.getElementById("panelToggleButton"),
  gpsButton: document.getElementById("gpsButton"),
  autoButton: document.getElementById("autoButton"),
  claimCenterButton: document.getElementById("claimCenterButton"),
  centerOnPlayerButton: document.getElementById("centerOnPlayerButton"),
  seedButton: document.getElementById("seedButton"),
  exportButton: document.getElementById("exportButton"),
  resetButton: document.getElementById("resetButton"),
};

init();

function init() {
  map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  }).setView(state.map.center, state.map.zoom);

  L.control.zoom({ position: "bottomleft" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  gridLayer = L.layerGroup().addTo(map);
  territoryLayer = L.layerGroup().addTo(map);
  pathLayer = L.layerGroup().addTo(map);

  bindEvents();
  syncCellSizeButtons();
  syncPanelState();
  createIcons();

  const start = state.lastPoint || { lat: state.map.center[0], lng: state.map.center[1] };
  setPlayerPosition(start, { pan: false, record: false });

  redraw();
  updateStats();
  setStatus("点击地图或方向键开始染色");
}

function bindEvents() {
  map.on("moveend zoomend", () => {
    const center = map.getCenter();
    state.map.center = [center.lat, center.lng];
    state.map.zoom = map.getZoom();
    saveState();
    redraw();
  });

  map.on("click", (event) => {
    movePlayer(event.latlng, "manual");
  });

  document.querySelectorAll("[data-layer-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.layerMode = button.dataset.layerMode;
      document.querySelectorAll("[data-layer-mode]").forEach((item) => {
        item.classList.toggle("is-active", item === button);
      });
      redraw();
      saveState();
    });
  });

  document.querySelectorAll("[data-bearing]").forEach((button) => {
    button.addEventListener("click", () => {
      stepByBearing(Number(button.dataset.bearing));
    });
  });

  document.querySelectorAll("[data-cell-size]").forEach((button) => {
    button.addEventListener("click", () => {
      changeCellSize(Number(button.dataset.cellSize));
    });
  });

  els.gpsButton.addEventListener("click", toggleGps);
  els.panelToggleButton.addEventListener("click", togglePanel);
  els.autoButton.addEventListener("click", toggleAutoWalk);
  els.claimCenterButton.addEventListener("click", claimMapCenter);
  els.centerOnPlayerButton.addEventListener("click", centerOnPlayer);
  els.seedButton.addEventListener("click", seedRivals);
  els.exportButton.addEventListener("click", exportSave);
  els.resetButton.addEventListener("click", resetSave);

  window.addEventListener("beforeunload", saveState);
}

function createIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function syncPanelState() {
  els.controlPanel.classList.toggle("is-collapsed", state.panelCollapsed);
  els.panelToggleButton.setAttribute("aria-expanded", String(!state.panelCollapsed));
  els.panelToggleButton.setAttribute(
    "title",
    state.panelCollapsed ? "打开操作面板" : "收起操作面板",
  );
  els.panelToggleButton.innerHTML = state.panelCollapsed
    ? '<i data-lucide="sliders-horizontal"></i><span>面板</span>'
    : '<i data-lucide="panel-bottom-close"></i><span>收起</span>';
  createIcons();
}

function togglePanel() {
  state.panelCollapsed = !state.panelCollapsed;
  syncPanelState();
  saveState();
}

function loadState() {
  const fallback = {
    version: 1,
    cellSize: 80,
    layerMode: "territory",
    map: { center: DEFAULT_CENTER, zoom: 15 },
    territory: {},
    footprints: {},
    path: [],
    stats: { captures: 0 },
    lastPoint: null,
    panelCollapsed: false,
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      ...fallback,
      ...parsed,
      map: { ...fallback.map, ...parsed.map },
      stats: { ...fallback.stats, ...parsed.stats },
      territory: parsed.territory || {},
      footprints: parsed.footprints || {},
      path: Array.isArray(parsed.path) ? parsed.path : [],
    };
  } catch {
    return fallback;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function setStatus(text) {
  els.status.textContent = text;
}

function setLocationText(text) {
  els.locationText.textContent = text;
}

function clampLat(lat) {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

function project(lat, lng) {
  const safeLat = clampLat(lat);
  const x = EARTH_RADIUS * lng * Math.PI / 180;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + safeLat * Math.PI / 360));
  return { x, y };
}

function unproject(x, y) {
  const lng = x / EARTH_RADIUS * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180 / Math.PI;
  return { lat, lng };
}

function cellFromLatLng(lat, lng) {
  const point = project(lat, lng);
  const x = Math.floor(point.x / state.cellSize);
  const y = Math.floor(point.y / state.cellSize);
  return {
    key: `${state.cellSize}:${x}:${y}`,
    x,
    y,
    size: state.cellSize,
  };
}

function parseCellKey(key) {
  const [size, x, y] = key.split(":").map(Number);
  return { size, x, y };
}

function cellPolygon(key) {
  const cell = parseCellKey(key);
  const minX = cell.x * cell.size;
  const minY = cell.y * cell.size;
  const maxX = minX + cell.size;
  const maxY = minY + cell.size;
  const sw = unproject(minX, minY);
  const se = unproject(maxX, minY);
  const ne = unproject(maxX, maxY);
  const nw = unproject(minX, maxY);
  return [
    [sw.lat, sw.lng],
    [se.lat, se.lng],
    [ne.lat, ne.lng],
    [nw.lat, nw.lng],
  ];
}

function cellCenter(key) {
  const cell = parseCellKey(key);
  return unproject((cell.x + 0.5) * cell.size, (cell.y + 0.5) * cell.size);
}

function visibleCellKeys() {
  const bounds = map.getBounds().pad(0.05);
  const sw = project(bounds.getSouth(), bounds.getWest());
  const ne = project(bounds.getNorth(), bounds.getEast());
  const minX = Math.floor(Math.min(sw.x, ne.x) / state.cellSize) - 1;
  const maxX = Math.floor(Math.max(sw.x, ne.x) / state.cellSize) + 1;
  const minY = Math.floor(Math.min(sw.y, ne.y) / state.cellSize) - 1;
  const maxY = Math.floor(Math.max(sw.y, ne.y) / state.cellSize) + 1;
  const total = (maxX - minX + 1) * (maxY - minY + 1);

  if (total > 1600) return [];

  const keys = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      keys.push(`${state.cellSize}:${x}:${y}`);
    }
  }
  return keys;
}

function redraw() {
  gridLayer.clearLayers();
  territoryLayer.clearLayers();
  pathLayer.clearLayers();

  drawGrid();
  drawCells();
  drawPath();
}

function drawGrid() {
  if (map.getZoom() < 14) return;

  visibleCellKeys().forEach((key) => {
    L.polygon(cellPolygon(key), {
      color: "rgba(20, 33, 30, 0.18)",
      weight: 1,
      fillOpacity: 0,
      interactive: false,
    }).addTo(gridLayer);
  });
}

function drawCells() {
  const bounds = map.getBounds().pad(0.25);
  const source = state.layerMode === "footprint" ? state.footprints : state.territory;

  Object.entries(source).forEach(([key, cell]) => {
    if (!isCellVisible(key, bounds)) return;

    const isFootprint = state.layerMode === "footprint";
    const owner = isFootprint ? "me" : cell.owner;
    L.polygon(cellPolygon(key), {
      color: owner === "me" ? "rgba(8, 119, 85, 0.9)" : "rgba(20, 33, 30, 0.42)",
      weight: owner === "me" ? 1.5 : 1,
      fillColor: OWNER_COLORS[owner] || OWNER_COLORS.me,
      fillOpacity: isFootprint ? 0.34 : owner === "me" ? 0.48 : 0.4,
      interactive: false,
    }).addTo(territoryLayer);
  });
}

function drawPath() {
  if (state.path.length < 2) return;
  const bounds = map.getBounds().pad(0.35);
  const points = state.path
    .filter((point) => bounds.contains([point.lat, point.lng]))
    .map((point) => [point.lat, point.lng]);

  if (points.length < 2) return;

  L.polyline(points, {
    color: "#087755",
    weight: 4,
    opacity: 0.72,
    lineCap: "round",
    interactive: false,
  }).addTo(pathLayer);
}

function isCellVisible(key, bounds) {
  const center = cellCenter(key);
  return bounds.contains([center.lat, center.lng]);
}

function setPlayerPosition(latlng, options = {}) {
  const point = {
    lat: Number(latlng.lat),
    lng: Number(latlng.lng),
  };

  if (!playerMarker) {
    const icon = L.divIcon({
      className: "",
      html: '<span class="player-pin"></span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    playerMarker = L.marker([point.lat, point.lng], { icon, zIndexOffset: 1000 }).addTo(map);
  } else {
    playerMarker.setLatLng([point.lat, point.lng]);
  }

  state.lastPoint = point;
  lastPoint = point;

  if (options.pan) {
    map.panTo([point.lat, point.lng], { animate: true, duration: 0.35 });
  }

  if (options.record !== false) {
    appendPath(point, options.source || "manual");
  }
}

function movePlayer(latlng, source) {
  const target = { lat: Number(latlng.lat), lng: Number(latlng.lng) };
  const from = hasVisited() ? lastPoint || target : target;
  claimRoute(from, target, source);
  setPlayerPosition(target, { pan: true, source });
  saveState();
  redraw();
  updateStats();
  setStatus(statusForSource(source));
}

function hasVisited() {
  return state.path.length > 0 || Object.keys(state.footprints).length > 0;
}

function statusForSource(source) {
  if (source === "gps") return "GPS 真实定位已计入";
  if (source === "center") return "已染当前地图中心";
  return "模拟轨迹已计入";
}

function claimRoute(from, to, source) {
  const distance = haversine(from, to);
  const steps = Math.max(1, Math.ceil(distance / Math.max(24, state.cellSize * 0.45)));

  for (let i = 0; i <= steps; i += 1) {
    const ratio = steps === 0 ? 1 : i / steps;
    const point = interpolateProjected(from, to, ratio);
    claimCell(point, source);
  }
}

function claimCell(point, source) {
  const now = Date.now();
  const cell = cellFromLatLng(point.lat, point.lng);
  const footprint = state.footprints[cell.key] || {
    firstAt: now,
    visits: 0,
  };

  footprint.lastAt = now;
  footprint.visits += 1;
  state.footprints[cell.key] = footprint;

  const previous = state.territory[cell.key];
  if (previous && previous.owner !== "me") {
    state.stats.captures += 1;
  }

  state.territory[cell.key] = {
    owner: "me",
    firstAt: previous?.firstAt || now,
    lastAt: now,
    source,
    visits: (previous?.owner === "me" ? previous.visits || 0 : 0) + 1,
  };
}

function appendPath(point, source) {
  state.path.push({
    lat: point.lat,
    lng: point.lng,
    source,
    ts: Date.now(),
  });

  if (state.path.length > 1200) {
    state.path.splice(0, state.path.length - 1200);
  }
}

function stepByBearing(bearing) {
  const origin = lastPoint || {
    lat: map.getCenter().lat,
    lng: map.getCenter().lng,
  };
  const target = destination(origin, bearing, Math.max(32, state.cellSize * 0.6));
  movePlayer(target, "manual");
}

function toggleAutoWalk() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    els.autoButton.classList.remove("is-active");
    els.autoButton.querySelector("span").textContent = "模拟";
    setStatus("自动模拟已停止");
    return;
  }

  autoTimer = window.setInterval(() => {
    autoBearing = (autoBearing + 22 + Math.sin(Date.now() / 2400) * 14) % 360;
    const origin = lastPoint || {
      lat: map.getCenter().lat,
      lng: map.getCenter().lng,
    };
    movePlayer(destination(origin, autoBearing, Math.max(24, state.cellSize * 0.52)), "auto");
  }, 900);

  els.autoButton.classList.add("is-active");
  els.autoButton.querySelector("span").textContent = "停止";
  setStatus("自动模拟进行中");
}

function toggleGps() {
  if (watchId !== null) {
    stopGpsTracking("GPS 已停止");
    return;
  }

  if (!navigator.geolocation) {
    setStatus("当前浏览器不支持 GPS");
    setLocationText("当前浏览器不支持 GPS");
    return;
  }

  const sessionId = gpsSessionId + 1;
  gpsSessionId = sessionId;
  els.gpsButton.classList.add("is-active");
  els.gpsButton.querySelector("span").textContent = "停止";
  setStatus("正在获取高精度 GPS");
  setLocationText(`正在获取设备真实位置，目标误差 ${GPS_TARGET_ACCURACY}m 以内`);

  navigator.geolocation.getCurrentPosition(
    (position) => handleGpsPosition(position, sessionId, true),
    (error) => handleGpsError(error, sessionId),
    GPS_OPTIONS,
  );

  watchId = navigator.geolocation.watchPosition(
    (position) => handleGpsPosition(position, sessionId, false),
    (error) => handleGpsError(error, sessionId),
    GPS_OPTIONS,
  );
}

function stopGpsTracking(message) {
  gpsSessionId += 1;
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (reverseGeocodeController) {
    reverseGeocodeController.abort();
    reverseGeocodeController = null;
  }
  els.gpsButton.classList.remove("is-active");
  els.gpsButton.querySelector("span").textContent = "GPS";
  setStatus(message);
  setLocationText(message);
}

function handleGpsPosition(position, sessionId, isInitialFix) {
  if (sessionId !== gpsSessionId || watchId === null) return;

  const { latitude, longitude, accuracy, speed } = position.coords;
  const point = { lat: latitude, lng: longitude };
  const readableAccuracy = accuracy ? Math.round(accuracy) : "未知";
  updateGpsLocationText(point, accuracy);

  if (speed && speed > 9) {
    setPlayerPosition(point, { pan: isInitialFix, record: false });
    setStatus("移动速度过高，GPS 未计入");
    return;
  }

  if (!accuracy || accuracy > GPS_TARGET_ACCURACY) {
    setPlayerPosition(point, { pan: isInitialFix, record: false });
    setStatus(`已定位，误差 ${readableAccuracy}m，继续等待 100m 内精度`);
    return;
  }

  movePlayer(point, "gps");
  lookupAddress(point, accuracy);
}

function handleGpsError(error, sessionId) {
  if (sessionId !== gpsSessionId) return;

  const messageByCode = {
    1: "GPS 未授权，请允许浏览器定位",
    2: "暂时无法获取设备位置",
    3: "GPS 定位超时，请到开阔处重试",
  };
  const message = messageByCode[error.code] || "GPS 无法启用";
  setStatus(message);
  setLocationText(message);
}

function updateGpsLocationText(point, accuracy) {
  const precision = accuracy ? ` · 误差约 ${Math.round(accuracy)}m` : "";
  setLocationText(`真实设备定位 · ${formatCoordinate(point.lat)}, ${formatCoordinate(point.lng)}${precision}`);
}

async function lookupAddress(point, accuracy) {
  const now = Date.now();
  if (now - lastReverseGeocodeAt < 15000) return;

  lastReverseGeocodeAt = now;
  if (reverseGeocodeController) {
    reverseGeocodeController.abort();
  }

  reverseGeocodeController = new AbortController();
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(point.lat));
  url.searchParams.set("lon", String(point.lng));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("accept-language", "zh-CN,zh,en");

  try {
    const response = await fetch(url, {
      signal: reverseGeocodeController.signal,
      headers: {
        "Accept": "application/json",
      },
    });
    if (!response.ok) return;
    const data = await response.json();
    const address = data.display_name || buildAddress(data.address);
    if (!address) return;
    const precision = accuracy ? ` · 误差约 ${Math.round(accuracy)}m` : "";
    setLocationText(`真实设备定位 · ${address}${precision}`);
  } catch (error) {
    if (error.name !== "AbortError") {
      updateGpsLocationText(point, accuracy);
    }
  }
}

function buildAddress(address = {}) {
  return [
    address.city || address.town || address.village || address.county,
    address.suburb || address.neighbourhood,
    address.road,
    address.house_number,
  ].filter(Boolean).join(" ");
}

function formatCoordinate(value) {
  return Number(value).toFixed(6);
}

function claimMapCenter() {
  movePlayer(map.getCenter(), "center");
}

function centerOnPlayer() {
  if (!lastPoint) {
    setStatus("暂无玩家位置");
    return;
  }
  map.panTo([lastPoint.lat, lastPoint.lng], { animate: true, duration: 0.35 });
  setStatus("已回到当前位置");
}

function changeCellSize(size) {
  if (state.cellSize === size) return;

  state.cellSize = size;
  state.territory = {};
  state.footprints = {};
  state.path = [];
  state.stats.captures = 0;
  const point = lastPoint || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  claimRoute(point, point, "manual");
  appendPath(point, "manual");
  syncCellSizeButtons();
  saveState();
  redraw();
  updateStats();
  setStatus(`格子已切换为 ${size}m`);
}

function syncCellSizeButtons() {
  document.querySelectorAll("[data-cell-size]").forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.cellSize) === state.cellSize);
  });

  document.querySelectorAll("[data-layer-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.layerMode === state.layerMode);
  });
}

function seedRivals() {
  const center = cellFromLatLng(map.getCenter().lat, map.getCenter().lng);
  const playerCell = cellFromLatLng(lastPoint?.lat || map.getCenter().lat, lastPoint?.lng || map.getCenter().lng);
  const radius = 15;
  const clusters = Array.from({ length: 8 }, (_, index) => ({
    x: center.x + randomInt(-radius, radius),
    y: center.y + randomInt(-radius, radius),
    owner: ownerOrder[index % ownerOrder.length],
    reach: randomInt(3, 6),
  }));
  let seeded = 0;

  clusters.forEach((cluster) => {
    for (let dx = -cluster.reach; dx <= cluster.reach; dx += 1) {
      for (let dy = -cluster.reach; dy <= cluster.reach; dy += 1) {
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > cluster.reach || Math.random() < 0.22) continue;

        const key = `${state.cellSize}:${cluster.x + dx}:${cluster.y + dy}`;
        if (state.footprints[key]) continue;

        state.territory[key] = {
          owner: cluster.owner,
          firstAt: Date.now(),
          lastAt: Date.now(),
          visits: 1,
          source: "rival-seed",
        };
        seeded += 1;
      }
    }
  });

  const nearbyCells = [
    { dx: 1, dy: 0, owner: "rivalA" },
    { dx: 2, dy: 0, owner: "rivalA" },
    { dx: 3, dy: 0, owner: "rivalB" },
    { dx: 0, dy: 1, owner: "rivalC" },
    { dx: 0, dy: 2, owner: "rivalC" },
    { dx: -1, dy: 0, owner: "rivalB" },
  ];

  nearbyCells.forEach((nearby) => {
    const key = `${state.cellSize}:${playerCell.x + nearby.dx}:${playerCell.y + nearby.dy}`;

    state.territory[key] = {
      owner: nearby.owner,
      firstAt: Date.now(),
      lastAt: Date.now(),
      visits: 1,
      source: "nearby-rival-seed",
    };
    seeded += 1;
  });

  saveState();
  redraw();
  updateStats();
  setStatus(`已生成 ${seeded} 个对手格`);
}

function updateStats() {
  const owned = Object.values(state.territory).filter((cell) => cell.owner === "me").length;
  const footprints = Object.keys(state.footprints).length;
  const approximateArea = owned * state.cellSize * state.cellSize;

  els.ownedCount.textContent = compactNumber(owned);
  els.footprintCount.textContent = compactNumber(footprints);
  els.captureCount.textContent = compactNumber(state.stats.captures);
  els.areaCount.textContent = formatArea(approximateArea);
}

function exportSave() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `city-walk-demo-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("本地存档已导出");
}

function resetSave() {
  if (autoTimer) toggleAutoWalk();
  if (watchId !== null) stopGpsTracking("GPS 已停止");

  state.territory = {};
  state.footprints = {};
  state.path = [];
  state.stats.captures = 0;
  state.lastPoint = null;
  lastPoint = null;

  if (playerMarker) {
    map.removeLayer(playerMarker);
    playerMarker = null;
  }

  saveState();
  redraw();
  updateStats();
  setLocationText("未启用 GPS");
  setStatus("已清空全部格子和路线");
}

function compactNumber(value) {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

function formatArea(squareMeters) {
  if (squareMeters < 10000) return `${compactNumber(squareMeters)} m²`;
  return `${(squareMeters / 1000000).toFixed(2)} km²`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function haversine(a, b) {
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function interpolateProjected(from, to, ratio) {
  const a = project(from.lat, from.lng);
  const b = project(to.lat, to.lng);
  return unproject(a.x + (b.x - a.x) * ratio, a.y + (b.y - a.y) * ratio);
}

function destination(origin, bearingDegrees, distanceMeters) {
  const bearing = bearingDegrees * Math.PI / 180;
  const lat1 = origin.lat * Math.PI / 180;
  const lng1 = origin.lng * Math.PI / 180;
  const angular = distanceMeters / EARTH_RADIUS;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
    Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
  );

  return {
    lat: lat2 * 180 / Math.PI,
    lng: ((lng2 * 180 / Math.PI + 540) % 360) - 180,
  };
}
