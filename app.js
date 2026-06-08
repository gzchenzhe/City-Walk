"use strict";

const STORAGE_KEY = "city-walk-turf-demo-v1";
const EARTH_RADIUS = 6378137;
const MAX_LAT = 85.05112878;
const DEFAULT_CENTER = [31.2304, 121.4737];
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

const state = loadState();

const els = {
  status: document.getElementById("statusText"),
  ownedCount: document.getElementById("ownedCount"),
  footprintCount: document.getElementById("footprintCount"),
  captureCount: document.getElementById("captureCount"),
  areaCount: document.getElementById("areaCount"),
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
  createIcons();

  const start = state.lastPoint || { lat: state.map.center[0], lng: state.map.center[1] };
  setPlayerPosition(start, { pan: false, record: false });
  if (Object.keys(state.footprints).length === 0) {
    claimRoute(start, start, "manual");
  }
  if (state.path.length === 0) {
    appendPath(start, "manual");
  }

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
  els.autoButton.addEventListener("click", toggleAutoWalk);
  els.claimCenterButton.addEventListener("click", () => movePlayer(map.getCenter(), "manual"));
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
    version: 1,
    cellSize: 80,
    layerMode: "territory",
    map: { center: DEFAULT_CENTER, zoom: 15 },
    territory: {},
    footprints: {},
    path: [],
    stats: { captures: 0 },
    lastPoint: null,
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
  const from = lastPoint || target;
  claimRoute(from, target, source);
  setPlayerPosition(target, { pan: true, source });
  saveState();
  redraw();
  updateStats();
  setStatus(source === "gps" ? "GPS 轨迹已计入" : "模拟轨迹已计入");
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
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    els.gpsButton.classList.remove("is-active");
    els.gpsButton.querySelector("span").textContent = "GPS";
    setStatus("GPS 已停止");
    return;
  }

  if (!navigator.geolocation) {
    setStatus("当前浏览器不支持 GPS");
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude, accuracy, speed } = position.coords;
      if (accuracy && accuracy > 90) {
        setStatus(`GPS 精度 ${Math.round(accuracy)}m，未计入`);
        return;
      }
      if (speed && speed > 9) {
        setStatus("移动速度过高，未计入");
        return;
      }
      movePlayer({ lat: latitude, lng: longitude }, "gps");
    },
    () => {
      setStatus("GPS 无法启用");
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      els.gpsButton.classList.remove("is-active");
      els.gpsButton.querySelector("span").textContent = "GPS";
    },
    {
      enableHighAccuracy: true,
      maximumAge: 2500,
      timeout: 12000,
    },
  );

  els.gpsButton.classList.add("is-active");
  els.gpsButton.querySelector("span").textContent = "停止";
  setStatus("GPS 监听中");
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
  const ok = window.confirm("清空本地足迹、领地和模拟对手？");
  if (!ok) return;

  if (autoTimer) toggleAutoWalk();
  if (watchId !== null) toggleGps();
  localStorage.removeItem(STORAGE_KEY);
  window.location.reload();
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
