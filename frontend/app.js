const state = { selectedFile: null, result: null, controlPoints: [], research: null, userFloodPhotos: [], analysisRunning: false };
let map;
let building3DMap;
let building3DReferencePins = [];
let mapLayer;
let studyLayers = {};
let activeFixedZonePopup;
let userFloodPhotoMode = false;
let uploadPreviewObjectUrl;
let cmGallery = [];
let cmGalleryIndex = 0;

const $ = (selector) => document.querySelector(selector);
function appUrl(path) {
  const clean = String(path || "").replace(/^\/+/, "");
  return new URL(clean, document.baseURI).toString();
}

window.appUrl = appUrl;
const colours = { Background: "#cfd6dc", Water: "#001d4f", "Built area": "#a62035", "Green area": "#26734d", Vehicle: "#d59a22" };
const galleryAreaColours = { "พื้นที่น้ำ": "#146bb0", "พื้นที่สิ่งปลูกสร้าง": "#a62035", "พื้นที่สีเขียว": "#26734d", "พื้นที่อื่น ๆ": "#9aa9b8" };
const captions = { water: "พื้นที่น้ำที่ DINOv3 ทำนาย", buildings: "จำนวนอาคารที่ SAM3 ตรวจจับได้ — กรอบสีเหลืองแสดงขอบเขตอาคาร", vehicles: "จำนวนยานพาหนะที่ SAM3 ตรวจจับได้ — กรอบสีขาวแสดงขอบเขตยานพาหนะ", trees: "พื้นที่ต้นไม้และพืชพรรณสีเขียวที่ DINOv3 ทำนาย", semantic: "ผลการจำแนกองค์ประกอบพื้นที่จาก DINOv3" };
const userFloodPhotoStorageKey = "floodwatch-user-flood-photos-v1";
const sampleImages = {
  TEST_IMAGE_1: { label: "น้ำท่วมน่าน", filename: "TEST_IMAGE_1.jpg" },
  TEST_IMAGE_2: { label: "น้ำท่วมเชียงใหม่", filename: "TEST_IMAGE_2.jpg" },
  TEST_IMAGE_3: { label: "น้ำท่วมเชียงราย", filename: "TEST_IMAGE_3.jpg" },
  TEST_IMAGE_4: { label: "น้ำท่วมกรุงเทพ", filename: "TEST_IMAGE_4.png" },
};

function percent(value, digits = 2) { return `${(Number(value) * 100).toFixed(digits)}%`; }
function number(value) { return Number(value).toLocaleString("th-TH"); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character])); }

async function serviceHealth() {
  try {
    const response = await fetch(appUrl("api/health"));
    const data = await response.json();
    $("#service-state").textContent = data.mode === "local GPU inference" ? "พร้อมเชื่อมต่อการประมวลผลในเครื่อง" : "ตรวจสอบการตั้งค่าบริการ";
  } catch { $("#service-state").textContent = "ยังเชื่อมต่อบริการไม่ได้"; }
}

function showSelectedFile(file, options = {}) {
  state.selectedFile = file || null;
  const dropzone = $("#dropzone");
  const empty = $("#dropzone-empty");
  const preview = $("#dropzone-preview");
  if (uploadPreviewObjectUrl) {
    URL.revokeObjectURL(uploadPreviewObjectUrl);
    uploadPreviewObjectUrl = undefined;
  }
  if (file) {
    const previewUrl = options.previewUrl || URL.createObjectURL(file);
    if (!options.previewUrl) uploadPreviewObjectUrl = previewUrl;
    $("#upload-preview").src = previewUrl;
    $("#preview-title").textContent = options.label || file.name;
    $("#file-name").textContent = `${options.label || file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    dropzone.classList.add("has-preview");
    empty.hidden = true;
    preview.hidden = false;
  } else {
    $("#upload-preview").removeAttribute("src");
    $("#preview-title").textContent = "";
    $("#file-name").textContent = "ยังไม่ได้เลือกไฟล์";
    dropzone.classList.remove("has-preview");
    empty.hidden = false;
    preview.hidden = true;
  }
  $("#analyse-button").disabled = !file;
}

async function selectSampleImage(sampleId) {
  const sample = sampleImages[sampleId];
  if (!sample) {
    showSelectedFile(null);
    return;
  }
  const selector = $("#sample-image-select");
  selector.disabled = true;
  $("#file-name").textContent = "กำลังโหลดภาพตัวอย่าง…";
  try {
    const response = await fetch(appUrl(`api/sample-images/${encodeURIComponent(sampleId)}`));
    if (!response.ok) throw new Error("ไม่สามารถโหลดภาพตัวอย่างได้");
    const blob = await response.blob();
    const file = new File([blob], sample.filename, { type: blob.type || "image/jpeg" });
    showSelectedFile(file, {
      label: sample.label,
      previewUrl: appUrl(`api/sample-images/${encodeURIComponent(sampleId)}`),
    });
  } catch (error) {
    showSelectedFile(null);
    alert(error.message || "ไม่สามารถโหลดภาพตัวอย่างได้");
  } finally {
    selector.disabled = false;
  }
}

function setStatus(text, kind = "") {
  const el = $("#analysis-status");
  el.textContent = text;
  el.className = `status-pill ${kind}`.trim();
}

function renderClassBars(container, values, palette = colours) {
  container.replaceChildren();
  const template = $("#class-bar-template");
  Object.entries(values).forEach(([label, value]) => {
    const row = template.content.cloneNode(true);
    row.querySelector("span").textContent = label;
    const bar = row.querySelector("i");
    bar.style.width = `${Math.max(1, value)}%`;
    bar.style.background = palette[label] || "#6d7f91";
    row.querySelector("strong").textContent = `${Number(value).toFixed(2)}%`;
    container.append(row);
  });
}

function renderResult(data) {
  state.result = data;
  $("#empty-result").hidden = true;
  $("#result-content").hidden = false;
  $("#water-percent").textContent = `${data.water_percent.toFixed(2)}%`;
  $("#building-count").textContent = number(data.building_objects);
  $("#vehicle-count").textContent = number(data.vehicle_objects || 0);
  $("#green-percent").textContent = `${data.class_area_percent["Green area"].toFixed(2)}%`;
  $("#built-percent").textContent = `${data.class_area_percent["Built area"].toFixed(2)}%`;
  $("#result-image").src = appUrl(data.images.water);
  $("#result-caption").textContent = captions.water;
  $("#trees-result-tab").hidden = !data.images.trees;
  if (!data.images.trees) {
    $("#result-caption").textContent = "ผลลัพธ์ต้นไม้จะปรากฏหลังรีสตาร์ต FloodWatch backend ด้วยโค้ดล่าสุด";
  }
  $("#sam-threshold-note").textContent = `ผลวิเคราะห์นี้ใช้ SAM3 confidence threshold ${percent(data.sam_threshold, 0)}`;
  const samNote = $("#sam-region-note");
  samNote.hidden = data.sam_analysis_region !== "fallback_without_sky";
  if (!samNote.hidden) samNote.textContent = "GeoCalib ไม่สามารถกำหนดบริเวณ near/mid ของภาพนี้ได้ จึงใช้เขต fallback ที่ตัด 22% ด้านบนของภาพออก เพื่อไม่ให้ SAM ตรวจจับบนท้องฟ้าหรือเส้นขอบฟ้า";
  renderClassBars($("#class-bars"), data.class_area_percent);
  setStatus("วิเคราะห์เสร็จแล้ว", "is-ready");
  renderPoints();
}

async function runAnalysis() {
  if (!state.selectedFile || state.analysisRunning) return;
  state.analysisRunning = true;
  const button = $("#analyse-button");
  button.disabled = true;
  button.textContent = "กำลังวิเคราะห์…";
  setStatus("กำลังประมวลผล", "is-running");
  const form = new FormData();
  form.append("image", state.selectedFile);
  form.append("apply_geo_filter", $("#geo-filter").checked);
  try {
    const response = await fetch(appUrl("api/analyse"), { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "ไม่สามารถวิเคราะห์ภาพได้");
    renderResult(data);
  } catch (error) {
    setStatus("วิเคราะห์ไม่สำเร็จ", "is-error");
    alert(error.message);
  } finally {
    state.analysisRunning = false;
    button.disabled = false;
    button.textContent = "เริ่มวิเคราะห์ภาพ";
  }
}

function switchResult(kind) {
  if (!state.result || !state.result.images[kind]) return;
  document.querySelectorAll(".result-tab").forEach((button) => button.classList.toggle("is-active", button.dataset.result === kind));
  $("#result-image").src = appUrl(state.result.images[kind]);
  $("#result-caption").textContent = captions[kind];
}

function researchCard(label, value, note = "") {
  return `<article class="metric-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
}

function renderCmGallery() {
  const image = $("#cm-gallery-image");
  if (!cmGallery.length) {
    image.removeAttribute("src");
    $("#cm-gallery-title").textContent = "ไม่พบภาพสรุป CM";
    $("#cm-gallery-stats").replaceChildren();
    $("#cm-gallery-counter").textContent = "0 / 0";
    $("#cm-gallery-prev").disabled = true;
    $("#cm-gallery-next").disabled = true;
    return;
  }
  const item = cmGallery[cmGalleryIndex];
  const statistics = item.statistics || {};
  image.src = appUrl(item.url);
  image.alt = `ภาพสรุปผล ${item.id}`;
  $("#cm-gallery-title").textContent = item.id;
  const areaPercent = statistics.class_area_percent || {};
  const probabilityMap = item.class_probability_url ? `<section class="cm-gallery-probability-report"><div><p class="eyebrow">DINOV3 CLASS PROBABILITIES</p></div><figure><img src="${appUrl(item.class_probability_url)}" alt="DINOv3 probability maps for water, built area, green area, and vehicle in ${item.id}" /></figure></section>` : "";
  $("#cm-gallery-stats").innerHTML = `${probabilityMap}<section class="cm-gallery-area-report"><div><p class="eyebrow">DINOV3 AREA REPORT</p><h3>สัดส่วนพื้นที่รายภาพ</h3></div><p class="small-note">สัดส่วนพื้นที่ที่ DINOv3 คาดการณ์จากภาพ ${item.id}</p><div id="cm-gallery-class-bars" class="class-summary"></div><p class="small-note gallery-area-note">พื้นที่อื่น ๆ รวมพื้นหลังและยานพาหนะ</p></section>`;
  renderClassBars($("#cm-gallery-class-bars"), {
    "พื้นที่น้ำ": Number(areaPercent["พื้นที่น้ำ"]) || 0,
    "พื้นที่สิ่งปลูกสร้าง": Number(areaPercent["พื้นที่สิ่งปลูกสร้าง"]) || 0,
    "พื้นที่สีเขียว": Number(areaPercent["พื้นที่สีเขียว"]) || 0,
    "พื้นที่อื่น ๆ": Number(areaPercent["พื้นที่อื่น ๆ"]) || 0,
  }, galleryAreaColours);
  $("#cm-gallery-counter").textContent = `${cmGalleryIndex + 1} / ${cmGallery.length}`;
  $("#cm-gallery-prev").disabled = cmGallery.length < 2;
  $("#cm-gallery-next").disabled = cmGallery.length < 2;
}

function changeCmGallery(offset) {
  if (!cmGallery.length) return;
  cmGalleryIndex = (cmGalleryIndex + offset + cmGallery.length) % cmGallery.length;
  renderCmGallery();
}

function renderResearch(data) {
  const metrics = data.water_metrics;
  $("#research-overview").innerHTML = [
    researchCard("ภาพทั้งหมด", number(data.dataset.images), `ฝึก ${data.dataset.train} · ตรวจสอบ ${data.dataset.validation} · ทดสอบ ${data.dataset.test}`),
    researchCard("Water IoU", percent(metrics["Water IoU"]), "ผลหลักแบบรวมพิกเซลบนชุดทดสอบ"),
    researchCard("Water Precision", percent(metrics["Water Precision"]), "ความถูกต้องของพิกเซลที่ทำนายเป็นน้ำ"),
    researchCard("Water Recall", percent(metrics["Water Recall"]), "ความครอบคลุมของพื้นที่น้ำจริง"),
    researchCard("SAM3 instance F1", percent(data.sam_validation.instance_f1), `threshold ${data.sam_validation.threshold.toFixed(2)} บนภาพ validation ${data.sam_validation.validation_images} ภาพ`),
  ].join("");
  cmGallery = Array.isArray(data.assets?.cm_gallery) ? data.assets.cm_gallery : [];
  cmGalleryIndex = 0;
  renderCmGallery();
}
async function loadResearch() {
  try {
    const response = await fetch(appUrl("assets/study-assets/manifest.json?v=class-probability-strip-6"));
    if (!response.ok) throw new Error("ไม่พบชุดข้อมูลรายงานการศึกษา");
    state.research = await response.json();
    renderResearch(state.research);
    // The map tab may have been opened while the research manifest was loading.
    // Initialise it now that its GeoJSON and raster URLs are available.
    if ($("#map").classList.contains("is-active")) {
      await initStudyMap();
      map?.invalidateSize();
    }
  } catch (error) {
    $("#research-overview").innerHTML = `<p class="small-note">${error.message}</p>`;
  }
}

function renderPoints() {
  const list = $("#control-list");
  if (!list) return;
  list.replaceChildren();
  state.controlPoints.forEach((point, index) => {
    const item = document.createElement("li");
    item.textContent = `จุด ${index + 1}: (${point.image_x}, ${point.image_y}) → ${point.latitude}, ${point.longitude}`;
    list.append(item);
  });
  const fit = state.controlPoints.filter((point) => point.role === "fit").length;
  const check = state.controlPoints.filter((point) => point.role === "check").length;
  $("#save-points").disabled = !state.result || fit < 4 || check < 1;
}

async function uploadRaster() {
  const file = $("#raster-input").files[0];
  if (!file) return;
  const form = new FormData(); form.append("raster", file);
  $("#raster-status").textContent = "กำลังบันทึกภาพฐาน…";
  try {
    const response = await fetch(appUrl("api/map/raster"), { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "บันทึกภาพฐานไม่สำเร็จ");
    $("#raster-status").textContent = data.message;
  } catch (error) { $("#raster-status").textContent = error.message; }
}

async function savePoints() {
  if (!state.result) return;
  try {
    const response = await fetch(appUrl("api/map/georeference"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: state.result.job_id, points: state.controlPoints }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "บันทึกจุดอ้างอิงไม่สำเร็จ");
    $("#georef-status").textContent = `Fit RMSE ${data.fit_rmse_m.toFixed(2)} m | Check RMSE ${data.check_rmse_m.toFixed(2)} m | ผลตำแหน่งเป็นข้อมูลโดยประมาณ`;
    renderMap(data.geojson);
  } catch (error) { $("#georef-status").textContent = error.message; }
}

async function getGeoJson(url) {
  const response = await fetch(appUrl(url));
  if (!response.ok) throw new Error(`โหลดชั้นข้อมูลไม่ได้: ${url}`);
  return response.json();
}

const cmPalette = [
  "#663A44", "#B8926A", "#43474D", "#976C62", "#B89169",
  "#DFD187", "#D6985C", "#64685C", "#924D3C", "#7D7F63",
  "#4E7286", "#622A1F", "#964D32", "#D5B6B9", "#9AA374",
  "#D7C0AE", "#E5BD77",
];

const fixedImageZoneDefinitions = [
  { number: 1, imageIds: ["CM_18", "CM_19", "CM_20"], source: "ทีมอาสาโดรนเชียงใหม่" },
  { number: 2, imageIds: ["CM_23"], source: "ทีมอาสาโดรนเชียงใหม่" },
  { number: 3, imageIds: ["CM_29", "CM_30", "CM_31"], source: "ทีมอาสาโดรนเชียงใหม่" },
  { number: 4, imageIds: ["CM_34"], source: "dronethai.ig" },
  { number: 5, imageIds: ["CM_32"], source: "dronethai.ig" },
  { number: 6, imageIds: ["CM_15", "CM_16", "CM_17"], source: "ทีมอาสาโดรนเชียงใหม่" },
  { number: 7, imageIds: ["CM_11", "CM_12", "CM_13"], source: "ทีมอาสาโดรนเชียงใหม่" },
  { number: 8, imageIds: ["CM_25", "CM_26"], source: "ทีมอาสาโดรนเชียงใหม่" },
  { number: 9, imageIds: ["CM_1", "CM_2", "CM_3", "CM_4", "CM_5", "CM_6", "CM_7"], source: "มูลนิธิฮุก 31" },
];
let activeFixedZone;
let activeFixedZoneIndex = 0;

function cmNumber(imageId) {
  return Number(String(imageId).split("_")[1]);
}

function groupColours(imageIds) {
  return Object.fromEntries(
    [...imageIds]
      .sort((a, b) => cmNumber(a) - cmNumber(b))
      .map((imageId, index) => [imageId, cmPalette[index]])
  );
}

function referencePinIcon(colour) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34" aria-hidden="true">
      <path d="M13 1 C6.2 1 1 6.2 1 13 C1 21.7 13 33 13 33 C13 33 25 21.7 25 13 C25 6.2 19.8 1 13 1 Z"
            fill="${colour}" stroke="#ffffff" stroke-width="2"
            style="filter:drop-shadow(0px 1.5px 1.2px rgba(0,0,0,.42))" />
      <circle cx="13" cy="13" r="5.5" fill="#ffffff" />
      <text x="13" y="16.2" text-anchor="middle" font-family="Arial, sans-serif"
            font-size="10.5" font-weight="bold" fill="${colour}">i</text>
    </svg>`;

  return L.divIcon({
    className: "reference-pin-icon",
    html: svg,
    iconSize: [26, 34],
    iconAnchor: [13, 33],
    popupAnchor: [0, -30],
  });
}

function buildingPopup(properties) {
  const distance = Number(properties.nearest_reference_control_m);
  const distanceText = Number.isFinite(distance)
    ? `<br>จุดอ้างอิงใกล้สุด: ${distance.toFixed(1)} ม.`
    : "";

  return `<b>${properties.image_id} — อาคารจาก SAM</b>`
    + `<br>รหัส: ${properties.instance_id}`
    + `<br>สถานะ: ${properties.position_status || "approximate"}`
    + distanceText
    + `<br><small>ตำแหน่งโดยประมาณจากการตรึงภาพ</small>`;
}

function referencePopup(properties) {
  const error = Number(properties.reference_error_m);
  const errorText = Number.isFinite(error)
    ? `<br>reference error: ${error.toFixed(2)} ม.`
    : "";

  return `<b>${properties.image_id} — จุดอ้างอิง ${properties.ref_id}</b>`
    + `<br>ละติจูด: ${Number(properties.latitude).toFixed(7)}`
    + `<br>ลองจิจูด: ${Number(properties.longitude).toFixed(7)}`
    + errorText
    + `<br><small>${properties.result_source || "current reference"}</small>`;
}

async function loadOriginalImageIndex() {
  const response = await fetch(appUrl("api/map/source-images"));
  if (!response.ok) throw new Error("ไม่สามารถโหลดภาพต้นฉบับของชุด CM ได้");
  const data = await response.json();
  return new Map((data.images || []).map((image) => [image.image_id, image]));
}

function fixedZoneExtent(definition, features) {
  const wanted = new Set(definition.imageIds);
  const points = features
    .filter((feature) => wanted.has(feature.properties.image_id))
    .map((feature) => feature.geometry.coordinates);
  if (!points.length) return null;
  const longitudes = points.map((point) => point[0]);
  const latitudes = points.map((point) => point[1]);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const latitude = (south + north) / 2;
  const longitude = (west + east) / 2;
  const metresEastWest = (east - west) * 111320 * Math.cos(latitude * Math.PI / 180);
  const metresNorthSouth = (north - south) * 110574;
  return { latitude, longitude, spanMetres: Math.max(metresEastWest, metresNorthSouth) };
}

function fixedTileBounds(extent, sideMetres) {
  const halfLatitude = sideMetres / (2 * 110574);
  const halfLongitude = sideMetres / (2 * 111320 * Math.cos(extent.latitude * Math.PI / 180));
  return [
    [extent.latitude - halfLatitude, extent.longitude - halfLongitude],
    [extent.latitude + halfLatitude, extent.longitude + halfLongitude],
  ];
}

function fixedZonePopupHtml(zone) {
  const images = zone.images;
  const image = images[activeFixedZoneIndex];
  const preview = image
    ? `<figure><img src="${escapeHtml(appUrl(image.url))}" alt="${escapeHtml(image.name)}"><figcaption><b>${escapeHtml(image.image_id)}</b><small>ที่มา: ${escapeHtml(zone.source)}</small></figcaption></figure>`
    : `<p class="zone-popup-empty">ไม่พบไฟล์ภาพต้นฉบับใน Pics_CM_Flood สำหรับชุดนี้</p>`;
  return `<section class="fixed-zone-popup-content"><p class="eyebrow">FLOOD IMAGE ZONE</p><h3>${escapeHtml(zone.imageIds.join(", "))}</h3><p class="small-note">${number(zone.count)} ภาพ · ที่มา: ${escapeHtml(zone.source)}</p>${preview}<div class="fixed-zone-popup-controls"><button type="button" data-fixed-zone-step="-1" ${images.length < 2 ? "disabled" : ""} aria-label="ภาพก่อนหน้า">←</button><output>${images.length ? `${activeFixedZoneIndex + 1} / ${images.length}` : "0 / 0"}</output><button type="button" data-fixed-zone-step="1" ${images.length < 2 ? "disabled" : ""} aria-label="ภาพถัดไป">→</button></div></section>`;
}

function renderFixedZoneGallery() {
  if (!activeFixedZone || !activeFixedZonePopup) return;
  activeFixedZonePopup.setContent(fixedZonePopupHtml(activeFixedZone));
}

function openFixedZoneGallery(zone) {
  activeFixedZone = zone;
  activeFixedZoneIndex = 0;
  if (activeFixedZonePopup) map.closePopup(activeFixedZonePopup);
  const [[south, west], [north, east]] = zone.bounds;
  const latitude = (south + north) / 2;
  const rightEdge = map.latLngToContainerPoint([latitude, east]);
  const openToRight = rightEdge.x + 292 < map.getSize().x;
  activeFixedZonePopup = L.popup({
    className: "fixed-zone-popup",
    minWidth: 278,
    maxWidth: 278,
    autoPan: false,
    // Leaflet anchors a popup at its lower edge. Move it down so its centre
    // aligns with the tile, while keeping it beside (rather than over) it.
    offset: [openToRight ? 139 : -139, 185],
    closeButton: true,
  }).setLatLng(L.latLng(latitude, openToRight ? east : west)).setContent(fixedZonePopupHtml(zone));
  activeFixedZonePopup.on("remove", () => { activeFixedZonePopup = undefined; });
  activeFixedZonePopup.openOn(map);
}

function fixedZoneCountIcon(count) {
  return L.divIcon({
    className: "fixed-zone-count-badge",
    html: `<b>${number(count)}</b><span>ภาพ</span>`,
    iconSize: [74, 30],
    iconAnchor: [37, 15],
  });
}

function setFixedZoneBadgeVisible(marker, visible) {
  const element = marker.getElement();
  if (element) element.classList.toggle("is-visible", visible);
}

function moveFixedZoneGallery(step) {
  if (!activeFixedZone?.images.length) return;
  activeFixedZoneIndex = (activeFixedZoneIndex + step + activeFixedZone.images.length) % activeFixedZone.images.length;
  renderFixedZoneGallery();
}

function setFixedZonesVisible(enabled) {
  if (!map || !studyLayers.fixedZones) return;
  if (enabled) {
    studyLayers.fixedZones.addTo(map);
    Object.values(studyLayers.cmLayers).forEach((layer) => map.removeLayer(layer));
  } else {
    map.removeLayer(studyLayers.fixedZones);
    Object.values(studyLayers.cmLayers).forEach((layer) => layer.addTo(map));
    if (activeFixedZonePopup) map.closePopup(activeFixedZonePopup);
  }
  if (studyLayers.fixedZoneToggle) {
    studyLayers.fixedZoneToggle.checked = enabled;
    studyLayers.fixedZoneToggle.setAttribute("aria-checked", String(enabled));
  }
}

function addFixedZoneToggle() {
  const FixedZoneControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const container = L.DomUtil.create("div", "leaflet-bar fixed-zone-toggle");
      container.innerHTML = '<label title="เปิดกรอบภาพและซ่อนหมุดอ้างอิงกับจุดอาคาร"><input type="checkbox"><span>กรอบภาพ</span></label>';
      const input = container.querySelector("input");
      input.addEventListener("change", () => setFixedZonesVisible(input.checked));
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      studyLayers.fixedZoneToggle = input;
      return container;
    },
  });
  map.addControl(new FixedZoneControl());
}

async function renderFixedImageZones(buildings, references) {
  if (!map || !studyLayers.fixedZones) return;
  studyLayers.fixedZones.clearLayers();
  let imageIndex = new Map();
  try { imageIndex = await loadOriginalImageIndex(); } catch (error) { console.warn(error.message); }
  const features = [...buildings.features, ...references.features];
  const zoneExtents = fixedImageZoneDefinitions
    .map((definition) => ({ definition, extent: fixedZoneExtent(definition, features) }))
    .filter(({ extent }) => extent);
  const sharedTileSideMetres = Math.max(1200, ...zoneExtents.map(({ extent }) => extent.spanMetres + 420));
  const maxCount = Math.max(...fixedImageZoneDefinitions.map((definition) => definition.imageIds.length));
  zoneExtents.forEach(({ definition, extent }) => {
    const bounds = fixedTileBounds(extent, sharedTileSideMetres);
    const count = definition.imageIds.length;
    const intensity = count / maxCount;
    const zone = {
      ...definition,
      count,
      bounds,
      images: definition.imageIds.map((imageId) => imageIndex.get(imageId)).filter(Boolean),
    };
    const rectangle = L.rectangle(bounds, {
      color: "#b87900", weight: .75,
      fillColor: "#d9a72b", fillOpacity: .30 + intensity * .40,
    });
    const badge = L.marker(L.latLngBounds(bounds).getCenter(), {
      icon: fixedZoneCountIcon(count), interactive: false, keyboard: false,
    });
    rectangle.on("mouseover", () => setFixedZoneBadgeVisible(badge, true));
    rectangle.on("mouseout", () => setFixedZoneBadgeVisible(badge, false));
    rectangle.on("click", () => openFixedZoneGallery(zone));
    rectangle.addTo(studyLayers.fixedZones);
    badge.addTo(studyLayers.fixedZones);
  });
}

function mapLayerLabel(imageId, colour) {
  return `<span class="cm-layer-label"><i style="background:${colour}"></i>${imageId}</span>`;
}

function buildMapLayerControl(baseLayers, overlays) {
  L.control.layers(baseLayers, overlays, {
    collapsed: false,
    position: "topright",
  }).addTo(map);
}

async function initStudyMap() {
  if (map || !window.L || !state.research) return;

  map = L.map("leaflet-map", { zoomControl: true }).setView([18.795, 99.005], 13);

  const lightGray = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles © Esri" }
  );

  const lightGrayLabels = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles © Esri", pane: "overlayPane" }
  );

  const imagery = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles © Esri" }
  );

  const street = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles © Esri" }
  );

  lightGray.addTo(map);
  lightGrayLabels.addTo(map);

  const a = state.research.assets;
  const [boundary, buildings, references] = await Promise.all([
    getGeoJson(a.municipality_boundary),
    getGeoJson(a.georeferenced_buildings),
    getGeoJson(a.georeferenced_references),
  ]);

  const depth = L.imageOverlay(
    a.flood_depth,
    state.research.flood_depth_bounds,
    { opacity: 0.38, interactive: false }
  );

  const municipality = L.geoJSON(boundary, {
    style: { color: "#c52d2d", weight: 1.3, fillOpacity: 0 },
  }).bindPopup("ขอบเขตเทศบาลนครเชียงใหม่");

  const imageIds = new Set([
    ...buildings.features.map((feature) => feature.properties.image_id),
    ...references.features.map((feature) => feature.properties.image_id),
  ]);

  const coloursByImage = groupColours(imageIds);
  const cmLayers = Object.fromEntries(
    [...imageIds]
      .sort((a, b) => cmNumber(a) - cmNumber(b))
      .map((imageId) => [imageId, L.layerGroup().addTo(map)])
  );

  const allSpatialPoints = L.featureGroup();

  buildings.features.forEach((feature) => {
    const properties = feature.properties;
    const imageId = properties.image_id;
    const [longitude, latitude] = feature.geometry.coordinates;
    const colour = coloursByImage[imageId];

    const point = L.circleMarker([latitude, longitude], {
      radius: 2.5,
      color: colour,
      fillColor: colour,
      fillOpacity: 0.86,
      weight: 1,
    });

    point.bindPopup(buildingPopup(properties));
    point.bindTooltip(`${imageId} | ${properties.instance_id}`, { sticky: true });
    point.addTo(cmLayers[imageId]);
    point.addTo(allSpatialPoints);
  });

  references.features.forEach((feature) => {
    const properties = feature.properties;
    const imageId = properties.image_id;
    const [longitude, latitude] = feature.geometry.coordinates;
    const colour = coloursByImage[imageId];

    const pin = L.marker([latitude, longitude], {
      icon: referencePinIcon(colour),
      zIndexOffset: 1000,
    });

    pin.bindPopup(referencePopup({
      ...properties,
      latitude,
      longitude,
    }));
    pin.bindTooltip(`${imageId} | Ref ${properties.ref_id}`, { sticky: true });
    pin.addTo(cmLayers[imageId]);
    pin.addTo(allSpatialPoints);
  });

  depth.addTo(map);

  studyLayers = {
    depth,
    municipality,
    cmLayers,
    fixedZones: L.layerGroup(),
    userFloodPhotos: L.layerGroup().addTo(map),
    userApprox: L.layerGroup(),
  };

  const baseLayers = {
    "Esri Light Gray": lightGray,
    "Esri Satellite": imagery,
    "Esri Street Map": street,
  };

  const overlays = {
    "Esri place labels": lightGrayLabels,
    "ระดับน้ำ": depth,
    "ขอบเขตเทศบาล": municipality,
  };

  [...imageIds]
    .sort((a, b) => cmNumber(a) - cmNumber(b))
    .forEach((imageId) => {
      overlays[mapLayerLabel(imageId, coloursByImage[imageId])] = cmLayers[imageId];
    });

  // User-added frames and flood-photo markers remain visible, without extra rows in the layer control.

  buildMapLayerControl(baseLayers, overlays);
  addFixedZoneToggle();

  $("#map-reference-note").textContent =
    `แสดงอาคารจาก SAM ${buildings.features.length.toLocaleString("th-TH")} จุด `
    + `และจุดอ้างอิง ${references.features.length.toLocaleString("th-TH")} จุด `
    + `จาก ${imageIds.size} กลุ่มภาพ สีเดียวกันหมายถึงภาพกลุ่มเดียวกัน`;

  map.on("mousemove", (event) => {
    $("#map-cursor").textContent =
      `${event.latlng.lat.toFixed(5)}, ${event.latlng.lng.toFixed(5)}`;
  });

  map.on("click", (event) => {
    registerUserFloodLocation(event);
  });

  if (allSpatialPoints.getLayers().length) {
    map.fitBounds(allSpatialPoints.getBounds().pad(0.08));
  } else {
    map.fitBounds(municipality.getBounds().pad(0.05));
  }

  restoreUserFloodPhotos();
  await renderFixedImageZones(buildings, references);
  setFixedZonesVisible(false);
  map.getContainer().addEventListener("click", (event) => {
    const button = event.target.closest("[data-fixed-zone-step]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    moveFixedZoneGallery(Number(button.dataset.fixedZoneStep));
  });
  requestAnimationFrame(() => {
    map.invalidateSize();
    if (allSpatialPoints.getLayers().length) map.fitBounds(allSpatialPoints.getBounds().pad(0.08));
  });
}

function map3DCamera() {
  const center = map?.getCenter();
  return {
    center: center ? [center.lng, center.lat] : [99.005, 18.795],
    zoom: Math.max(15, map?.getZoom() || 15),
  };
}

function set3DMapStatus(message) {
  const status = $("#map-3d-status");
  if (status) status.textContent = message;
}

function map3DPointData(features, coloursByImage) {
  return {
    type: "FeatureCollection",
    features: features.map((feature) => ({
      ...feature,
      properties: { ...feature.properties, group_colour: coloursByImage[feature.properties.image_id] || "#496b80" },
    })),
  };
}

function add3DPointerInteractions() {
  const popup = new window.maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 10 });
  const popupText = (feature) => {
    const point = feature.properties;
    const kind = point.ref_id ? `จุดอ้างอิง ${point.ref_id}` : `อาคาร ${point.instance_id || "SAM"}`;
    return `<b>${point.image_id} — ${kind}</b><br><small>ตำแหน่งโดยประมาณจากการตรึงภาพ</small>`;
  };
  ["sam-building-points-3d"].forEach((layerId) => {
    building3DMap.on("mouseenter", layerId, () => { building3DMap.getCanvas().style.cursor = "pointer"; });
    building3DMap.on("mouseleave", layerId, () => { building3DMap.getCanvas().style.cursor = "grab"; });
    building3DMap.on("click", layerId, (event) => {
      const feature = event.features?.[0];
      if (feature) popup.setLngLat(event.lngLat).setHTML(popupText(feature)).addTo(building3DMap);
    });
  });
}

function referencePinElement(colour) {
  const element = document.createElement("div");
  element.className = "reference-pin-3d";
  element.innerHTML = `
    <svg viewBox="0 0 26 34" aria-hidden="true">
      <path d="M13 1 C6.2 1 1 6.2 1 13 C1 21.7 13 33 13 33 C13 33 25 21.7 25 13 C25 6.2 19.8 1 13 1 Z" fill="${colour}" stroke="#ffffff" stroke-width="2" />
      <circle cx="13" cy="13" r="5.5" fill="#ffffff" />
      <text x="13" y="16.2" text-anchor="middle" font-family="Arial, sans-serif" font-size="10.5" font-weight="bold" fill="${colour}">i</text>
    </svg>`;
  return element;
}

function add3DReferencePins(references, coloursByImage) {
  building3DReferencePins.forEach((marker) => marker.remove());
  building3DReferencePins = references.features.map((feature) => {
    const [longitude, latitude] = feature.geometry.coordinates;
    const point = feature.properties;
    const marker = new window.maplibregl.Marker({ element: referencePinElement(coloursByImage[point.image_id]), anchor: "bottom" })
      .setLngLat([longitude, latitude])
      .setPopup(new window.maplibregl.Popup({ offset: 20 }).setHTML(
        `<b>${point.image_id} — จุดอ้างอิง ${point.ref_id}</b><br><small>Pin – reference coordinate</small>`
      ))
      .addTo(building3DMap);
    return marker;
  });
}

function enableMiddleMouseRotation() {
  const canvas = building3DMap.getCanvas();
  canvas.style.cursor = "grab";
  canvas.addEventListener("mousedown", (startEvent) => {
    if (startEvent.button !== 1) return;
    startEvent.preventDefault();
    const start = { x: startEvent.clientX, y: startEvent.clientY, bearing: building3DMap.getBearing(), pitch: building3DMap.getPitch() };
    canvas.style.cursor = "grabbing";
    const rotate = (event) => {
      building3DMap.rotateTo(start.bearing + (event.clientX - start.x) * 0.34, { duration: 0 });
      building3DMap.setPitch(Math.max(0, Math.min(75, start.pitch - (event.clientY - start.y) * 0.22)), { duration: 0 });
    };
    const stop = () => {
      canvas.style.cursor = "grab";
      window.removeEventListener("mousemove", rotate);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", rotate);
    window.addEventListener("mouseup", stop, { once: true });
  });
}

async function add3DStudyLayers() {
  const assets = state.research.assets;
  const [buildings, references] = await Promise.all([
    getGeoJson(assets.georeferenced_buildings),
    getGeoJson(assets.georeferenced_references),
  ]);
  const imageIds = new Set([
    ...buildings.features.map((feature) => feature.properties.image_id),
    ...references.features.map((feature) => feature.properties.image_id),
  ]);
  const coloursByImage = groupColours(imageIds);
  const [[south, west], [north, east]] = state.research.flood_depth_bounds;
  const labelLayer = building3DMap.getStyle().layers?.find(
    (layer) => layer.type === "symbol" && layer.layout?.["text-field"]
  )?.id;

  building3DMap.addSource("idw-flood-depth-3d", {
    type: "image",
    url: assets.flood_depth,
    coordinates: [[west, north], [east, north], [east, south], [west, south]],
  });
  building3DMap.addLayer({
    id: "idw-flood-depth-3d", source: "idw-flood-depth-3d", type: "raster",
    paint: { "raster-opacity": 0.44 },
  }, labelLayer);

  building3DMap.addSource("openfreemap-3d-buildings", {
    type: "vector",
    url: "https://tiles.openfreemap.org/planet",
  });
  building3DMap.addLayer({
    id: "openfreemap-3d-buildings",
    source: "openfreemap-3d-buildings",
    "source-layer": "building",
    type: "fill-extrusion",
    minzoom: 15,
    filter: ["!=", ["get", "hide_3d"], true],
    paint: {
      "fill-extrusion-color": [
        "interpolate", ["linear"], ["get", "render_height"],
        0, "#d9e4ec",
        25, "#bdcedb",
        60, "#98adbe",
        120, "#728da4",
      ],
      "fill-extrusion-height": [
        "interpolate", ["linear"], ["zoom"],
        15, 0,
        16, ["*", ["get", "render_height"], 1.75],
      ],
      "fill-extrusion-base": [
        "interpolate", ["linear"], ["zoom"],
        15, 0,
        16, ["*", ["get", "render_min_height"], 1.75],
      ],
      "fill-extrusion-opacity": 0.86,
    },
  }, labelLayer);
  building3DMap.addSource("sam-building-points-3d", {
    type: "geojson", data: map3DPointData(buildings.features, coloursByImage),
  });
  building3DMap.addLayer({
    id: "sam-building-points-3d", source: "sam-building-points-3d", type: "circle",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.2, 16, 4.2],
      "circle-color": ["get", "group_colour"],
      "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.9, "circle-opacity": 0.94,
    },
  });
  add3DReferencePins(references, coloursByImage);
  add3DPointerInteractions();
}

function initialise3DMap() {
  const camera = map3DCamera();
  if (!window.maplibregl) {
    set3DMapStatus("ไม่สามารถโหลดไลบรารีแผนที่ 3D ได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่");
    return;
  }
  if (building3DMap) {
    building3DMap.jumpTo({ ...camera, pitch: 58, bearing: -22 });
    building3DMap.resize();
    set3DMapStatus("อาคาร 3D สูงขึ้น พร้อมจุด SAM, หมุดอ้างอิง และชั้นความลึกน้ำ IDW");
    return;
  }

  set3DMapStatus("กำลังโหลดอาคาร 3D จาก OpenStreetMap…");
  building3DMap = new window.maplibregl.Map({
    container: "building-3d-map",
    style: "https://tiles.openfreemap.org/styles/bright",
    ...camera,
    pitch: 58,
    bearing: -22,
    antialias: true,
    canvasContextAttributes: { antialias: true },
  });
  building3DMap.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }));
  building3DMap.on("load", async () => {
    try {
      enableMiddleMouseRotation();
      await add3DStudyLayers();
      set3DMapStatus("อาคาร 3D สูงขึ้น พร้อมจุด SAM, หมุดอ้างอิง และชั้นความลึกน้ำ IDW");
    } catch (error) {
      console.error("Unable to add 3D building layer", error);
      set3DMapStatus("เปิดแผนที่แล้ว แต่ชั้นอาคาร 3D โหลดไม่สำเร็จ กรุณาลองเปิดใหม่");
    }
  });
  building3DMap.on("error", (event) => {
    if (event.error) console.warn("3D map source error", event.error);
  });
}

function open3DMap() {
  const dialog = $("#map-3d-dialog");
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => initialise3DMap());
}

function close3DMap() {
  const dialog = $("#map-3d-dialog");
  if (dialog.open) dialog.close();
}

function renderMap(geojson) {
  if (!map) return;
  studyLayers.userApprox.clearLayers();
  const layer = L.geoJSON(geojson, { pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 5, color: "#001d4f", fillColor: "#bbd8ea", fillOpacity: .9, weight: 1 }), onEachFeature: (feature, marker) => marker.bindPopup(`SAM3 object ${feature.properties.object_id}<br>ตำแหน่งโดยประมาณ`) });
  layer.addTo(studyLayers.userApprox);
  if (geojson.features.length) map.fitBounds(layer.getBounds().pad(.15));
}

function saveUserFloodPhotos() {
  localStorage.setItem(userFloodPhotoStorageKey, JSON.stringify(state.userFloodPhotos));
}

function userFloodPhotoPopupHtml(photo) {
  const image = photo.image;
  const preview = image
    ? `<figure><img src="${escapeHtml(appUrl(image.url))}" alt="${escapeHtml(image.name)}"><figcaption>${escapeHtml(image.name)}</figcaption></figure>`
    : "";
  return `<section class="fixed-zone-popup-content"><p class="eyebrow">USER FLOOD PHOTO</p><h3>${escapeHtml(photo.name)}</h3><p class="small-note">ตำแหน่งภาพ: ${Number(photo.latitude).toFixed(5)}, ${Number(photo.longitude).toFixed(5)}</p>${preview}</section>`;
}

function userFloodPhotoBounds(photo) {
  return fixedTileBounds({ latitude: Number(photo.latitude), longitude: Number(photo.longitude) }, 700);
}

function renderUserFloodPhotos() {
  if (!map || !studyLayers.userFloodPhotos) return;
  studyLayers.userFloodPhotos.clearLayers();
  state.userFloodPhotos.forEach((photo) => {
    const popup = userFloodPhotoPopupHtml(photo);
    const frame = L.rectangle(userFloodPhotoBounds(photo), {
      color: "#b87900", weight: .75,
      fillColor: "#d9a72b", fillOpacity: .46,
      interactive: false,
    });
    const point = L.circleMarker([photo.latitude, photo.longitude], {
      radius: 6, color: "#7c5100", weight: 1.5,
      fillColor: "#f6c645", fillOpacity: 1,
    }).bindPopup(popup, { maxWidth: 278, minWidth: 240 });
    frame.addTo(studyLayers.userFloodPhotos);
    point.addTo(studyLayers.userFloodPhotos);
  });
}

function restoreUserFloodPhotos() {
  try {
    const saved = JSON.parse(localStorage.getItem(userFloodPhotoStorageKey) || "[]");
    state.userFloodPhotos = Array.isArray(saved) ? saved.filter((photo) => (
      photo && photo.name && Number.isFinite(Number(photo.latitude)) && Number.isFinite(Number(photo.longitude))
    )) : [];
  } catch { state.userFloodPhotos = []; }
  renderUserFloodPhotos();
}

function startUserFloodLocation() {
  const name = $("#user-flood-name").value.trim();
  const image = $("#user-flood-image").files[0];
  if (!name || !image) {
    $("#user-flood-status").textContent = "กรุณาตั้งชื่อจุดและเลือกรูปภาพน้ำท่วมก่อน";
    return;
  }
  userFloodPhotoMode = true;
  $("#user-flood-start").textContent = "คลิกตำแหน่งภาพบนแผนที่…";
  $("#user-flood-status").textContent = "คลิกตำแหน่งที่ถ่ายภาพบนแผนที่ 1 จุด";
}

async function registerUserFloodLocation(event) {
  if (!userFloodPhotoMode) return;
  const name = $("#user-flood-name").value.trim();
  const file = $("#user-flood-image").files[0];
  userFloodPhotoMode = false;
  $("#user-flood-start").textContent = "เลือกตำแหน่งบนแผนที่";
  $("#user-flood-status").textContent = "กำลังอัปโหลดภาพน้ำท่วม…";
  try {
    const [image] = await uploadZoneImages([file]);
    if (!image) throw new Error("ไม่สามารถบันทึกภาพได้");
    state.userFloodPhotos.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      latitude: event.latlng.lat,
      longitude: event.latlng.lng,
      image,
    });
    saveUserFloodPhotos();
    renderUserFloodPhotos();
    $("#user-flood-name").value = "";
    $("#user-flood-image").value = "";
    $("#user-flood-image-name").textContent = "ยังไม่ได้เลือกไฟล์";
    $("#user-flood-status").textContent = `เพิ่มจุด “${name}” แล้ว — คลิกหมุดเพื่อดูภาพ`;
  } catch (error) {
    $("#user-flood-status").textContent = error.message || "อัปโหลดภาพไม่สำเร็จ";
  }
}

function clearUserFloodPhotos() {
  state.userFloodPhotos = [];
  saveUserFloodPhotos();
  renderUserFloodPhotos();
  $("#user-flood-status").textContent = "ล้างจุดภาพน้ำท่วมที่เพิ่มในเบราว์เซอร์นี้แล้ว";
}

function activateTab(button) {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("is-active", item === button));
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("is-active", view.id === button.dataset.tab));
  if (button.dataset.tab === "map") setTimeout(() => { initStudyMap().then(() => map?.invalidateSize()); }, 0);
}

$("#image-input").addEventListener("change", (event) => {
  $("#sample-image-select").value = "";
  showSelectedFile(event.target.files[0]);
});
$("#sample-image-select").addEventListener("change", (event) => selectSampleImage(event.target.value));
$("#analyse-button").addEventListener("click", runAnalysis);
$("#cm-gallery-prev").addEventListener("click", () => changeCmGallery(-1));
$("#cm-gallery-next").addEventListener("click", () => changeCmGallery(1));
$("#dropzone").addEventListener("dragover", (event) => { event.preventDefault(); $("#dropzone").classList.add("is-dragging"); });
$("#dropzone").addEventListener("dragleave", () => $("#dropzone").classList.remove("is-dragging"));
$("#dropzone").addEventListener("drop", (event) => { event.preventDefault(); $("#dropzone").classList.remove("is-dragging"); $("#sample-image-select").value = ""; showSelectedFile(event.dataTransfer.files[0]); });
document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => activateTab(button)));
document.querySelectorAll(".result-tab").forEach((button) => button.addEventListener("click", () => switchResult(button.dataset.result)));
$("#user-flood-image").addEventListener("change", (event) => {
  $("#user-flood-image-name").textContent = event.target.files[0] ? event.target.files[0].name : "ยังไม่ได้เลือกไฟล์";
});
$("#user-flood-start").addEventListener("click", startUserFloodLocation);
$("#user-flood-clear").addEventListener("click", clearUserFloodPhotos);
$("#open-3d-map").addEventListener("click", open3DMap);
$("#close-3d-map").addEventListener("click", close3DMap);
serviceHealth();
loadResearch();
