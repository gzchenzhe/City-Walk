"use strict";

const STORAGE_KEY = "city-walk-turf-demo-v3-leaflet-hex";
const LEGACY_STORAGE_KEYS = ["city-walk-turf-demo-v2-amap-hex"];
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

let map = null;
let gridLayer = null;
let cellLayer = null;
let pathLayer = null;
let gridOverlays = [];
let cellOverlayCache = new Map();
let pathOverlay = null;
let playerMarker = null;
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
  bindEvents();
  syncCellSizeButtons();
  syncPanelState();
  createIcons();

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
  cellLayer = L.layerGroup().addTo(map);
  pathLayer = L.layerGroup().addTo(map);

  map.on("click", (event) => movePlayer(event.latlng, "manual"));
  map.on("moveend zoomend", syncMapView);

  if (state.lastPoint) {
    setPlayerPosition(state.lastPoint, { pan: false, record: false });
  }

  redraw();
  updateStats();
  setStatus("点击地图或方向键开始染色");
}

function bindEvents() {
  document.querySelectorAll("[data-layer-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.layerMode = button.dataset.layerMode;
      document.querySelectorAll("[data-layer-mode]").forEach((item) => {
        item.classList.toggle("is-active", item === button);
      });
      clearCellOverlays();
      redraw();
      saveState();
    });
  });

  document.querySelectorAll("[data-bearing]").forEach((button) => {
    button.addEventListener("click", () => stepByBearing(Number(button.dataset.bearing)));
  });

  document.querySelectorAll("[data-cell-size]").forEach((button) => {
    button.addEventListener("click", () => changeCellSize(Number(button.dataset.cellSize)));
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

function loadState() {
  const fallback = {
    version: 3,
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
    const raw = localStorage.getItem(STORAGE_KEY) ||
      LEGACY_STORAGE_KEYS.map((key) => localStorage.getItem(key)).find(Boolean);
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

function syncMapView() {
  if (!map) return;
  const center = map.getCenter();
  state.map.center = [center.lat, center.lng];
  state.map.zoom = map.getZoom();
  saveState();
  redraw();
}

function ensureMapReady() {
  if (map) return true;
  setStatus("地图还在加载");
  return false;
}

function clampLat(lat) {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

function project(lat, lng) {
  const safeLat = clampLat(lat);
  return {
    x: EARTH_RADIUS * lng * Math.PI / 180,
    y: EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + safeLat * Math.PI / 360)),
  };
}

function unproject(x, y) {
  return {
    lng: x / EARTH_RADIUS * 180 / Math.PI,
    lat: (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180 / Math.PI,
  };
}

function hexRadius() {
  return hexRadiusFor(state.cellSize);
}

function hexRadiusFor(size) {
  return size / Math.sqrt(3);
}

function axialFromMeters(point) {
  const size = hexRadius();
  return {
    q: (Math.sqrt(3) / 3 * point.x - point.y / 3) / size,
    r: (2 / 3 * point.y) / size,
  };
}

function roundAxial(q, r) {
  let x = q;
  let z = r;
  let y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { q: rx, r: rz };
}

function metersFromAxial(q, r, cellSize = state.cellSize) {
  const size = hexRadiusFor(cellSize);
  return {
    x: size * Math.sqrt(3) * (q + r / 2),
    y: size * 1.5 * r,
  };
}

function cellFromLatLng(lat, lng) {
  const fractional = axialFromMeters(project(lat, lng));
  const axial = roundAxial(fractional.q, fractional.r);
  return {
    key: `hex:${state.cellSize}:${axial.q}:${axial.r}`,
    q: axial.q,
    r: axial.r,
  };
}

function parseCellKey(key) {
  const [, size, q, r] = key.split(":").map((part, index) => index === 0 ? part : Number(part));
  return { size, q, r };
}

function cellCenter(key) {
  const cell = parseCellKey(key);
  const meters = metersFromAxial(cell.q, cell.r, cell.size);
  return unproject(meters.x, meters.y);
}

function cellPolygon(key) {
  const cell = parseCellKey(key);
  const center = metersFromAxial(cell.q, cell.r, cell.size);
  const size = hexRadiusFor(cell.size);

  return Array.from({ length: 6 }, (_, index) => {
    const angle = Math.PI / 180 * (60 * index - 30);
    const point = unproject(
      center.x + size * Math.cos(angle),
      center.y + size * Math.sin(angle),
    );
    return [point.lat, point.lng];
  });
}

function visibleCellKeys() {
  if (!map) return [];
  const bounds = map.getBounds();
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const corners = [
    project(sw.lat, sw.lng),
    project(sw.lat, ne.lng),
    project(ne.lat, ne.lng),
    project(ne.lat, sw.lng),
  ].map(axialFromMeters);
  const minQ = Math.floor(Math.min(...corners.map((item) => item.q))) - 3;
  const maxQ = Math.ceil(Math.max(...corners.map((item) => item.q))) + 3;
  const minR = Math.floor(Math.min(...corners.map((item) => item.r))) - 3;
  const maxR = Math.ceil(Math.max(...corners.map((item) => item.r))) + 3;
  const total = (maxQ - minQ + 1) * (maxR - minR + 1);

  if (total > 1800) return [];

  const keys = [];
  for (let q = minQ; q <= maxQ; q += 1) {
    for (let r = minR; r <= maxR; r += 1) {
      keys.push(`hex:${state.cellSize}:${q}:${r}`);
    }
  }
  return keys;
}

function redraw() {
  if (!map) return;
  drawGrid();
  drawCells();
  drawPath();
}

function drawGrid() {
  gridLayer.clearLayers();
  gridOverlays = [];
  if (map.getZoom() < 14) return;

  gridOverlays = visibleCellKeys().map((key) => L.polygon(cellPolygon(key), {
    color: "rgba(20, 33, 30, 0.2)",
    weight: 1,
    fillOpacity: 0,
    interactive: false,
  }).addTo(gridLayer));
}

function drawCells() {
  const source = state.layerMode === "footprint" ? state.footprints : state.territory;
  const visibleKeys = new Set();

  Object.entries(source).forEach(([key, cell]) => {
    if (!isCellVisible(key)) return;
    visibleKeys.add(key);
    upsertCellOverlay(key, cell);
  });

  cellOverlayCache.forEach((entry, key) => {
    if (visibleKeys.has(key)) return;
    cellLayer.removeLayer(entry.overlay);
    cellOverlayCache.delete(key);
  });
}

function drawPath() {
  const path = state.path.map((point) => [point.lat, point.lng]);

  if (path.length < 2) {
    if (pathOverlay) {
      pathLayer.removeLayer(pathOverlay);
      pathOverlay = null;
    }
    return;
  }

  if (pathOverlay) {
    pathOverlay.setLatLngs(path);
    return;
  }

  pathOverlay = L.polyline(path, {
    color: "#087755",
    weight: 5,
    opacity: 0.72,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  }).addTo(pathLayer);
}

function upsertCellOverlay(key, cell) {
  const style = cellOverlayStyle(cell);
  const existing = cellOverlayCache.get(key);

  if (existing && existing.mode === state.layerMode && existing.owner === style.owner) {
    return;
  }

  if (existing) {
    existing.overlay.setStyle(style.options);
    existing.mode = state.layerMode;
    existing.owner = style.owner;
    return;
  }

  const overlay = L.polygon(cellPolygon(key), {
    ...style.options,
    interactive: false,
  }).addTo(cellLayer);
  cellOverlayCache.set(key, {
    overlay,
    mode: state.layerMode,
    owner: style.owner,
  });
}

function cellOverlayStyle(cell) {
  const isFootprint = state.layerMode === "footprint";
  const owner = isFootprint ? "me" : cell.owner;
  return {
    owner,
    options: {
      color: owner === "me" ? "rgba(8, 119, 85, 0.9)" : "rgba(20, 33, 30, 0.42)",
      weight: owner === "me" ? 2 : 1,
      fillColor: OWNER_COLORS[owner] || OWNER_COLORS.me,
      fillOpacity: isFootprint ? 0.34 : owner === "me" ? 0.5 : 0.42,
    },
  };
}

function clearCellOverlays() {
  cellOverlayCache.forEach((entry) => cellLayer.removeLayer(entry.overlay));
  cellOverlayCache.clear();
}

function isCellVisible(key) {
  if (!map) return false;
  const bounds = map.getBounds().pad(0.15);
  const center = cellCenter(key);
  return bounds.contains([center.lat, center.lng]);
}

function setPlayerPosition(latlng, options = {}) {
  if (!ensureMapReady()) return;
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
    map.panTo([point.lat, point.lng], { animate: true, duration: 0.28 });
  }

  if (options.record !== false) {
    appendPath(point, options.source || "manual");
  }
}

function movePlayer(latlng, source) {
  if (!ensureMapReady()) return;
  const target = { lat: Number(latlng.lat), lng: Number(latlng.lng) };
  const from = hasVisited() ? lastPoint || target : target;
  claimRoute(from, target, source);
  setPlayerPosition(target, { pan: true, source });
  saveState();
  drawCells();
  drawPath();
  updateStats();
  setStatus(statusForSource(source));
}

function hasVisited() {
  return state.path.length > 0 || Object.keys(state.footprints).length > 0;
}

function statusForSource(source) {
  if (source === "gps") return "GPS 真实定位已计入";
  if (source === "center") return "已染当前地图中心";
  if (source === "step") return "已移动 1 个六边形";
  return "模拟轨迹已计入";
}

function claimRoute(from, to, source) {
  const distance = haversine(from, to);
  const steps = Math.max(1, Math.ceil(distance / Math.max(18, state.cellSize * 0.4)));

  for (let i = 0; i <= steps; i += 1) {
    const ratio = steps === 0 ? 1 : i / steps;
    claimCell(interpolateProjected(from, to, ratio), source);
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
  if (!ensureMapReady()) return;
  const origin = lastPoint || getMapCenterPoint();
  const currentCell = cellFromLatLng(origin.lat, origin.lng);
  const currentCenter = cellCenter(currentCell.key);
  const probePoint = destination(currentCenter, bearing, state.cellSize);
  const nextCell = cellFromLatLng(probePoint.lat, probePoint.lng);
  const targetKey = nextCell.key === currentCell.key
    ? neighborCellKey(currentCell, bearing)
    : nextCell.key;

  movePlayer(cellCenter(targetKey), "step");
}

function neighborCellKey(cell, bearing) {
  const directions = [
    { q: 0, r: 1, bearing: 30 },
    { q: 1, r: 0, bearing: 90 },
    { q: 1, r: -1, bearing: 150 },
    { q: 0, r: -1, bearing: 210 },
    { q: -1, r: 0, bearing: 270 },
    { q: -1, r: 1, bearing: 330 },
  ];
  const direction = directions.reduce((best, item) => {
    const diff = angularDistance(bearing, item.bearing);
    return diff < best.diff ? { ...item, diff } : best;
  }, { ...directions[0], diff: Infinity });

  return `hex:${state.cellSize}:${cell.q + direction.q}:${cell.r + direction.r}`;
}

function angularDistance(a, b) {
  const diff = Math.abs(((a - b + 540) % 360) - 180);
  return diff;
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

  if (!ensureMapReady()) return;

  autoTimer = window.setInterval(() => {
    autoBearing = (autoBearing + 22 + Math.sin(Date.now() / 2400) * 14) % 360;
    const origin = lastPoint || getMapCenterPoint();
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
  if (reverseGeocodeController) reverseGeocodeController.abort();

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
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!data.display_name) return;
    const precision = accuracy ? ` · 误差约 ${Math.round(accuracy)}m` : "";
    setLocationText(`真实设备定位 · ${data.display_name}${precision}`);
  } catch (error) {
    if (error.name !== "AbortError") updateGpsLocationText(point, accuracy);
  }
}

function claimMapCenter() {
  if (!ensureMapReady()) return;
  movePlayer(getMapCenterPoint(), "center");
}

function centerOnPlayer() {
  if (!ensureMapReady()) return;
  if (!lastPoint) {
    setStatus("暂无玩家位置");
    return;
  }
  map.panTo([lastPoint.lat, lastPoint.lng], { animate: true, duration: 0.28 });
  setStatus("已回到当前位置");
}

function changeCellSize(size) {
  if (state.cellSize === size) return;

  state.cellSize = size;
  state.territory = {};
  state.footprints = {};
  state.path = [];
  state.stats.captures = 0;
  clearCellOverlays();
  if (pathOverlay) {
    pathLayer.removeLayer(pathOverlay);
    pathOverlay = null;
  }
  syncCellSizeButtons();
  saveState();
  redraw();
  updateStats();
  setStatus(`六边形已切换为 ${size}m`);
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
  if (!ensureMapReady()) return;
  const centerPoint = lastPoint || getMapCenterPoint();
  const center = cellFromLatLng(centerPoint.lat, centerPoint.lng);
  const radius = 15;
  const clusters = Array.from({ length: 8 }, (_, index) => ({
    q: center.q + randomInt(-radius, radius),
    r: center.r + randomInt(-radius, radius),
    owner: ownerOrder[index % ownerOrder.length],
    reach: randomInt(3, 6),
  }));
  let seeded = 0;

  clusters.forEach((cluster) => {
    for (let dq = -cluster.reach; dq <= cluster.reach; dq += 1) {
      for (let dr = -cluster.reach; dr <= cluster.reach; dr += 1) {
        if (hexDistance(0, 0, dq, dr) > cluster.reach || Math.random() < 0.22) continue;
        const key = `hex:${state.cellSize}:${cluster.q + dq}:${cluster.r + dr}`;
        if (state.footprints[key]) continue;
        state.territory[key] = createRivalCell(cluster.owner);
        seeded += 1;
      }
    }
  });

  [
    { dq: 1, dr: 0, owner: "rivalA" },
    { dq: 2, dr: 0, owner: "rivalA" },
    { dq: 3, dr: 0, owner: "rivalB" },
    { dq: 0, dr: 1, owner: "rivalC" },
    { dq: 0, dr: 2, owner: "rivalC" },
    { dq: -1, dr: 0, owner: "rivalB" },
  ].forEach((nearby) => {
    const key = `hex:${state.cellSize}:${center.q + nearby.dq}:${center.r + nearby.dr}`;
    state.territory[key] = createRivalCell(nearby.owner);
    seeded += 1;
  });

  saveState();
  drawCells();
  updateStats();
  setStatus(`已生成 ${seeded} 个对手六边形`);
}

function createRivalCell(owner) {
  const now = Date.now();
  return {
    owner,
    firstAt: now,
    lastAt: now,
    visits: 1,
    source: "rival-seed",
  };
}

function hexDistance(q1, r1, q2, r2) {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

function updateStats() {
  const owned = Object.values(state.territory).filter((cell) => cell.owner === "me").length;
  const footprints = Object.keys(state.footprints).length;
  const approximateArea = owned * hexArea();

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
  link.download = `city-walk-leaflet-hex-${new Date().toISOString().slice(0, 10)}.json`;
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
  if (pathOverlay) {
    pathLayer.removeLayer(pathOverlay);
    pathOverlay = null;
  }
  clearCellOverlays();

  saveState();
  redraw();
  updateStats();
  setLocationText("未启用 GPS");
  setStatus("已清空全部六边形和路线");
}

function getMapCenterPoint() {
  const center = map.getCenter();
  return { lat: center.lat, lng: center.lng };
}

function hexArea() {
  const size = hexRadius();
  return 3 * Math.sqrt(3) / 2 * size * size;
}

function compactNumber(value) {
  if (value < 1000) return String(Math.round(value));
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

function formatCoordinate(value) {
  return Number(value).toFixed(6);
}
