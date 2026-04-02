// PDF.js worker設定
pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// --- State ---
const state = {
    oldPdf: null,
    newPdf: null,
    oldFile: null,
    newFile: null,
    currentPage: 1,
    totalPages: 1,
    mode: "overlay",
    scale: 2,
    zoom: 1,
    // Pan
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    scrollStartX: 0,
    scrollStartY: 0,
    // Comparison data
    overlayData: null,
    diffOnlyData: null,
    oldColoredData: null,
    newColoredData: null,
    canvasWidth: 0,
    canvasHeight: 0,
    // Rendered canvases (for re-comparison without re-rendering PDF)
    renderedOldCanvas: null,
    renderedNewCanvas: null,
    // Position adjustment
    pageOffsets: {},
    adjustMode: false,
    isAdjusting: false,
    adjustStartX: 0,
    adjustStartY: 0,
    adjustStartOffsetX: 0,
    adjustStartOffsetY: 0,
    // Change regions
    changeRegions: [],
    currentChangeIndex: -1,
    // Display options
    fadeAmount: 0.7,
    dilateChanges: true,
    sensitivity: 30, // 変更検出閾値 (低い=厳しい, 高い=緩い)
    blurRadius: 1.0,  // 前処理ぼかし半径 (0=なし, 0.1刻み)
    noiseSize: 4,     // ノイズ除去: この面積以下の差分領域を無視
    // Scale adjustment
    pageScales: {}, // per-page scale factor for new canvas
    // Thumbnails
    pageChangeData: [],
    sidebarVisible: true,
    // Page mapping: [{oldPage: number|null, newPage: number|null}, ...]
    pageMapping: [],
    // Thumbnail caches for mapping UI
    mappingThumbsOld: [], // canvas elements
    mappingThumbsNew: [],
};

function getPageOffset(page) {
    return state.pageOffsets[page] || { x: 0, y: 0 };
}

function getPageScale(page) {
    return state.pageScales[page] || 1.0;
}

// --- DOM Elements ---
const $ = (id) => document.getElementById(id);
const uploadOld = $("upload-old");
const uploadNew = $("upload-new");
const fileOld = $("file-old");
const fileNew = $("file-new");
const uploadContentOld = $("upload-content-old");
const uploadContentNew = $("upload-content-new");
const uploadDoneOld = $("upload-done-old");
const uploadDoneNew = $("upload-done-new");
const fileNameOld = $("file-name-old");
const fileNameNew = $("file-name-new");
const btnRemoveOld = $("btn-remove-old");
const btnRemoveNew = $("btn-remove-new");
const btnCompare = $("btn-compare");
const uploadSection = $("upload-section");
const resultSection = $("result-section");
const btnBack = $("btn-back");
const btnPrev = $("btn-prev");
const btnNext = $("btn-next");
const pageInfo = $("page-info");
const canvasResult = $("canvas-result");
const canvasOld = $("canvas-old");
const canvasNew = $("canvas-new");
const viewOverlay = $("view-overlay");
const viewSideBySide = $("view-sidebyside");
const loading = $("loading");
const loadingText = $("loading-text");
const modeButtons = document.querySelectorAll(".btn-mode");
const btnZoomIn = $("btn-zoom-in");
const btnZoomOut = $("btn-zoom-out");
const btnZoomFit = $("btn-zoom-fit");
const zoomLevel = $("zoom-level");
const btnExportPdf = $("btn-export-pdf");
const canvasViewport = $("canvas-viewport");
const canvasTransform = $("canvas-transform");
const btnAdjust = $("btn-adjust");
const adjustPanel = $("adjust-panel");
const adjustOffset = $("adjust-offset");
const btnAdjustReset = $("btn-adjust-reset");


const diffBadge = $("diff-badge");
const fadeSlider = $("fade-slider");
const chkDilate = $("chk-dilate");
const btnPrevChange = $("btn-prev-change");
const btnNextChange = $("btn-next-change");
const changeInfoEl = $("change-info");
const thumbnailList = $("thumbnail-list");
const changeSummary = $("change-summary");
const btnToggleSidebar = $("btn-toggle-sidebar");
const btnOpenSidebar = $("btn-open-sidebar");
const thumbnailSidebar = $("thumbnail-sidebar");
const infoOldName = $("info-old-name");
const infoNewName = $("info-new-name");
const btnHelp = $("btn-help");
const helpModal = $("help-modal");
const btnHelpClose = $("btn-help-close");

const btnDemo = $("btn-demo");

// Mapping section
const mappingSection = $("mapping-section");
const mappingList = $("mapping-list");
const mappingLoading = $("mapping-loading");
const btnAutoMatch = $("btn-auto-match");
const btnAddPair = $("btn-add-pair");
const btnResetMapping = $("btn-reset-mapping");
const btnMappingBack = $("btn-mapping-back");
const btnMappingConfirm = $("btn-mapping-confirm");
const btnThumbSmaller = $("btn-thumb-smaller");
const btnThumbLarger = $("btn-thumb-larger");
const thumbSizeLabel = $("thumb-size-label");

// Mapping thumbnail size presets: [width, height, label]
const THUMB_SIZES = [
    [60, 45, "S"],
    [80, 60, "M"],
    [130, 100, "L"],
    [200, 150, "XL"],
];
let thumbSizeIndex = 1; // default M

function applyThumbSize() {
    const [w, h, label] = THUMB_SIZES[thumbSizeIndex];
    mappingSection.style.setProperty("--mapping-thumb-w", w + "px");
    mappingSection.style.setProperty("--mapping-thumb-h", h + "px");
    thumbSizeLabel.textContent = label;
    btnThumbSmaller.disabled = thumbSizeIndex <= 0;
    btnThumbLarger.disabled = thumbSizeIndex >= THUMB_SIZES.length - 1;
}

btnThumbSmaller.addEventListener("click", () => {
    if (thumbSizeIndex > 0) { thumbSizeIndex--; applyThumbSize(); }
});

btnThumbLarger.addEventListener("click", () => {
    if (thumbSizeIndex < THUMB_SIZES.length - 1) { thumbSizeIndex++; applyThumbSize(); }
});

// --- Demo ---
btnDemo.addEventListener("click", async () => {
    loading.hidden = false;
    loadingText.textContent = "デモデータを読み込み中...";

    try {
        const [oldResp, newResp] = await Promise.all([
            fetch("demo/old.pdf"),
            fetch("demo/new.pdf"),
        ]);

        if (!oldResp.ok || !newResp.ok) {
            throw new Error("デモファイルの取得に失敗しました");
        }

        const [oldBuf, newBuf] = await Promise.all([
            oldResp.arrayBuffer(),
            newResp.arrayBuffer(),
        ]);

        const oldData = new Uint8Array(oldBuf);
        const newData = new Uint8Array(newBuf);

        // Create File objects for state
        state.oldFile = new File([oldBuf], "構造図面_Rev.A.pdf", { type: "application/pdf" });
        state.newFile = new File([newBuf], "構造図面_Rev.B.pdf", { type: "application/pdf" });

        state.oldPdf = await pdfjsLib.getDocument({ data: oldData }).promise;
        state.newPdf = await pdfjsLib.getDocument({ data: newData }).promise;

        // Show mapping screen
        uploadSection.hidden = true;
        showMappingScreen();
    } catch (err) {
        alert("デモの読み込みに失敗しました: " + err.message);
    } finally {
        loading.hidden = true;
    }
});

// --- File Upload ---
function setupUploadBox(box, fileInput, contentEl, doneEl, nameEl, removeBtn, side) {
    const handleFile = (file) => {
        if (!file || file.type !== "application/pdf") return;
        if (side === "old") state.oldFile = file;
        else state.newFile = file;

        nameEl.textContent = file.name;
        contentEl.hidden = true;
        doneEl.hidden = false;
        box.classList.add("loaded");
        updateCompareButton();
    };

    box.addEventListener("click", (e) => {
        if (box.classList.contains("loaded")) return;
        fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
        handleFile(e.target.files[0]);
    });

    box.addEventListener("dragover", (e) => {
        e.preventDefault();
        box.classList.add("dragover");
    });

    box.addEventListener("dragleave", () => {
        box.classList.remove("dragover");
    });

    box.addEventListener("drop", (e) => {
        e.preventDefault();
        box.classList.remove("dragover");
        handleFile(e.dataTransfer.files[0]);
    });

    removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (side === "old") state.oldFile = null;
        else state.newFile = null;
        fileInput.value = "";
        contentEl.hidden = false;
        doneEl.hidden = true;
        box.classList.remove("loaded");
        updateCompareButton();
    });
}

function updateCompareButton() {
    btnCompare.disabled = !(state.oldFile && state.newFile);
}

setupUploadBox(uploadOld, fileOld, uploadContentOld, uploadDoneOld, fileNameOld, btnRemoveOld, "old");
setupUploadBox(uploadNew, fileNew, uploadContentNew, uploadDoneNew, fileNameNew, btnRemoveNew, "new");

// --- Compare ---
btnCompare.addEventListener("click", async () => {
    loading.hidden = false;
    loadingText.textContent = "PDFを読み込み中...";

    try {
        const oldData = await readFile(state.oldFile);
        const newData = await readFile(state.newFile);

        state.oldPdf = await pdfjsLib.getDocument({ data: oldData }).promise;
        state.newPdf = await pdfjsLib.getDocument({ data: newData }).promise;

        // Show mapping screen
        uploadSection.hidden = true;
        showMappingScreen();
    } catch (err) {
        alert("PDFの読み込みに失敗しました: " + err.message);
    } finally {
        loading.hidden = true;
    }
});

function readFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

// --- Page Mapping ---
async function showMappingScreen() {
    mappingSection.hidden = false;
    resultSection.hidden = true;
    applyThumbSize();

    const oldPages = state.oldPdf.numPages;
    const newPages = state.newPdf.numPages;

    // Generate thumbnails for mapping
    mappingLoading.hidden = false;
    state.mappingThumbsOld = [];
    state.mappingThumbsNew = [];

    const thumbScale = 0.25;
    for (let p = 1; p <= oldPages; p++) {
        const c = await renderPageToCanvas(state.oldPdf, p, thumbScale);
        state.mappingThumbsOld.push(c);
    }
    for (let p = 1; p <= newPages; p++) {
        const c = await renderPageToCanvas(state.newPdf, p, thumbScale);
        state.mappingThumbsNew.push(c);
    }
    mappingLoading.hidden = true;

    // Default mapping: 1:1
    initDefaultMapping();
    renderMappingList();
}

function initDefaultMapping() {
    const oldPages = state.oldPdf.numPages;
    const newPages = state.newPdf.numPages;
    state.pageMapping = [];

    const maxPages = Math.max(oldPages, newPages);
    for (let i = 0; i < maxPages; i++) {
        state.pageMapping.push({
            oldPage: i < oldPages ? i + 1 : null,
            newPage: i < newPages ? i + 1 : null,
        });
    }
}

function renderMappingList() {
    mappingList.innerHTML = "";
    const oldPages = state.oldPdf.numPages;
    const newPages = state.newPdf.numPages;

    state.pageMapping.forEach((pair, idx) => {
        const row = document.createElement("div");
        row.className = "mapping-row";
        row.dataset.idx = idx;

        // Row number
        const numEl = document.createElement("span");
        numEl.className = "mapping-row-num";
        numEl.textContent = `#${idx + 1}`;
        row.appendChild(numEl);

        // Old side
        const oldSide = document.createElement("div");
        oldSide.className = "mapping-side";

        const oldLabel = document.createElement("span");
        oldLabel.className = "mapping-side-label old";
        oldLabel.textContent = "旧";
        oldSide.appendChild(oldLabel);

        const oldThumb = document.createElement("div");
        oldThumb.className = "mapping-thumb";
        if (pair.oldPage && state.mappingThumbsOld[pair.oldPage - 1]) {
            const c = state.mappingThumbsOld[pair.oldPage - 1];
            const clone = document.createElement("canvas");
            clone.width = c.width;
            clone.height = c.height;
            clone.getContext("2d").drawImage(c, 0, 0);
            oldThumb.appendChild(clone);
        } else {
            const span = document.createElement("span");
            span.className = "mapping-thumb-none";
            span.textContent = "なし";
            oldThumb.appendChild(span);
        }
        oldSide.appendChild(oldThumb);

        const oldSelect = document.createElement("select");
        oldSelect.className = "mapping-select";
        const oldNoneOpt = document.createElement("option");
        oldNoneOpt.value = "";
        oldNoneOpt.textContent = "なし (新規ページ)";
        oldSelect.appendChild(oldNoneOpt);
        for (let p = 1; p <= oldPages; p++) {
            const opt = document.createElement("option");
            opt.value = p;
            opt.textContent = `旧 P${p}`;
            if (pair.oldPage === p) opt.selected = true;
            oldSelect.appendChild(opt);
        }
        oldSelect.addEventListener("change", () => {
            const val = oldSelect.value ? parseInt(oldSelect.value) : null;
            state.pageMapping[idx].oldPage = val;
            renderMappingList();
        });
        oldSide.appendChild(oldSelect);
        row.appendChild(oldSide);

        // Arrow
        const arrow = document.createElement("span");
        arrow.className = "mapping-arrow";
        arrow.textContent = "⇔";
        row.appendChild(arrow);

        // New side
        const newSide = document.createElement("div");
        newSide.className = "mapping-side";

        const newLabel = document.createElement("span");
        newLabel.className = "mapping-side-label new";
        newLabel.textContent = "新";
        newSide.appendChild(newLabel);

        const newThumb = document.createElement("div");
        newThumb.className = "mapping-thumb";
        if (pair.newPage && state.mappingThumbsNew[pair.newPage - 1]) {
            const c = state.mappingThumbsNew[pair.newPage - 1];
            const clone = document.createElement("canvas");
            clone.width = c.width;
            clone.height = c.height;
            clone.getContext("2d").drawImage(c, 0, 0);
            newThumb.appendChild(clone);
        } else {
            const span = document.createElement("span");
            span.className = "mapping-thumb-none";
            span.textContent = "なし";
            newThumb.appendChild(span);
        }
        newSide.appendChild(newThumb);

        const newSelect = document.createElement("select");
        newSelect.className = "mapping-select";
        const newNoneOpt = document.createElement("option");
        newNoneOpt.value = "";
        newNoneOpt.textContent = "なし (削除ページ)";
        newSelect.appendChild(newNoneOpt);
        for (let p = 1; p <= newPages; p++) {
            const opt = document.createElement("option");
            opt.value = p;
            opt.textContent = `新 P${p}`;
            if (pair.newPage === p) opt.selected = true;
            newSelect.appendChild(opt);
        }
        newSelect.addEventListener("change", () => {
            const val = newSelect.value ? parseInt(newSelect.value) : null;
            state.pageMapping[idx].newPage = val;
            renderMappingList();
        });
        newSide.appendChild(newSelect);
        row.appendChild(newSide);

        // Remove button
        const removeBtn = document.createElement("button");
        removeBtn.className = "btn-mapping-remove";
        removeBtn.title = "このペアを削除";
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", () => {
            state.pageMapping.splice(idx, 1);
            renderMappingList();
        });
        row.appendChild(removeBtn);

        mappingList.appendChild(row);
    });
}

// Auto-match pages by visual similarity
async function autoMatchPages() {
    mappingLoading.hidden = false;
    mappingLoading.querySelector("span").textContent = "類似度を計算中...";

    await new Promise(r => setTimeout(r, 30));

    const oldPages = state.oldPdf.numPages;
    const newPages = state.newPdf.numPages;

    // Compute similarity matrix
    function getFingerprint(canvas) {
        if (!canvas) return null;
        const size = 32;
        const c = document.createElement("canvas");
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d");
        ctx.drawImage(canvas, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const fp = new Float32Array(size * size);
        for (let i = 0; i < size * size; i++) {
            fp[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
        }
        return fp;
    }

    function similarity(fp1, fp2) {
        if (!fp1 || !fp2) return 0;
        let dot = 0, mag1 = 0, mag2 = 0;
        for (let i = 0; i < fp1.length; i++) {
            dot += fp1[i] * fp2[i];
            mag1 += fp1[i] * fp1[i];
            mag2 += fp2[i] * fp2[i];
        }
        if (mag1 === 0 || mag2 === 0) return 0;
        return dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
    }

    const oldFPs = state.mappingThumbsOld.map(getFingerprint);
    const newFPs = state.mappingThumbsNew.map(getFingerprint);

    // Build similarity matrix
    const simMatrix = [];
    for (let o = 0; o < oldPages; o++) {
        simMatrix[o] = [];
        for (let n = 0; n < newPages; n++) {
            simMatrix[o][n] = similarity(oldFPs[o], newFPs[n]);
        }
    }

    // Greedy matching: pick highest similarity pairs first
    const usedOld = new Set();
    const usedNew = new Set();
    const pairs = [];

    // Collect all possible pairs with similarity
    const allPairs = [];
    for (let o = 0; o < oldPages; o++) {
        for (let n = 0; n < newPages; n++) {
            allPairs.push({ oldPage: o + 1, newPage: n + 1, sim: simMatrix[o][n] });
        }
    }
    allPairs.sort((a, b) => b.sim - a.sim);

    // Greedy match with threshold
    const THRESHOLD = 0.85;
    for (const p of allPairs) {
        if (usedOld.has(p.oldPage) || usedNew.has(p.newPage)) continue;
        if (p.sim < THRESHOLD) continue;
        pairs.push({ oldPage: p.oldPage, newPage: p.newPage });
        usedOld.add(p.oldPage);
        usedNew.add(p.newPage);
    }

    // Add unmatched old pages (deleted)
    for (let o = 1; o <= oldPages; o++) {
        if (!usedOld.has(o)) {
            pairs.push({ oldPage: o, newPage: null });
        }
    }

    // Add unmatched new pages (added)
    for (let n = 1; n <= newPages; n++) {
        if (!usedNew.has(n)) {
            pairs.push({ oldPage: null, newPage: n });
        }
    }

    // Sort by page order: matched pairs first (by old page), then unmatched
    pairs.sort((a, b) => {
        const aKey = a.oldPage || (a.newPage + 1000);
        const bKey = b.oldPage || (b.newPage + 1000);
        return aKey - bKey;
    });

    state.pageMapping = pairs;
    mappingLoading.hidden = true;
    renderMappingList();
}

// Mapping UI event handlers
btnAutoMatch.addEventListener("click", autoMatchPages);

btnAddPair.addEventListener("click", () => {
    state.pageMapping.push({ oldPage: null, newPage: null });
    renderMappingList();
    // Scroll to bottom
    mappingList.scrollTop = mappingList.scrollHeight;
});

btnResetMapping.addEventListener("click", () => {
    initDefaultMapping();
    renderMappingList();
});

btnMappingBack.addEventListener("click", () => {
    mappingSection.hidden = true;
    uploadSection.hidden = false;
    state.oldPdf = null;
    state.newPdf = null;
});

btnMappingConfirm.addEventListener("click", async () => {
    // Filter out empty pairs
    const validMapping = state.pageMapping.filter(p => p.oldPage || p.newPage);
    if (validMapping.length === 0) {
        alert("少なくとも1つのページペアを設定してください。");
        return;
    }
    state.pageMapping = validMapping;

    loading.hidden = false;
    loadingText.textContent = "比較中...";

    try {
        state.totalPages = state.pageMapping.length;
        state.currentPage = 1;
        state.pageChangeData = [];
        state.pageOffsets = {};
        state.pageScales = {};

        // Show result section
        mappingSection.hidden = true;
        resultSection.hidden = false;
        document.body.classList.add("comparing");

        // File info
        infoOldName.textContent = state.oldFile ? state.oldFile.name : "旧PDF";
        infoNewName.textContent = state.newFile ? state.newFile.name : "新PDF";

        await renderCurrentPage();
        generateThumbnails();
    } catch (err) {
        alert("比較に失敗しました: " + err.message);
    } finally {
        loading.hidden = true;
    }
});

// --- Render PDF page to offscreen canvas ---
async function renderPageToCanvas(pdf, pageNum, scale) {
    if (pageNum > pdf.numPages) return null;
    scale = scale || state.scale;

    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
}

// --- Box blur for pre-processing (supports fractional radius) ---
function boxBlurImageData(imageData, radius) {
    if (radius <= 0) return imageData;

    const intR = Math.floor(radius);
    const frac = radius - intR; // fractional part for blending

    // If radius < 1, blend original with radius=1 blur
    const blurR = Math.max(intR, frac > 0 && intR === 0 ? 1 : intR);
    if (blurR === 0) return imageData;

    const w = imageData.width, h = imageData.height;
    const src = imageData.data;
    const dst = new Uint8ClampedArray(src.length);

    // Horizontal pass
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0, cnt = 0;
            for (let dx = -blurR; dx <= blurR; dx++) {
                const nx = x + dx;
                if (nx >= 0 && nx < w) {
                    const i = (y * w + nx) * 4;
                    r += src[i]; g += src[i+1]; b += src[i+2];
                    cnt++;
                }
            }
            const i = (y * w + x) * 4;
            dst[i] = r / cnt; dst[i+1] = g / cnt; dst[i+2] = b / cnt; dst[i+3] = 255;
        }
    }

    // Vertical pass
    const dst2 = new Uint8ClampedArray(src.length);
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            let r = 0, g = 0, b = 0, cnt = 0;
            for (let dy = -blurR; dy <= blurR; dy++) {
                const ny = y + dy;
                if (ny >= 0 && ny < h) {
                    const i = (ny * w + x) * 4;
                    r += dst[i]; g += dst[i+1]; b += dst[i+2];
                    cnt++;
                }
            }
            const i = (y * w + x) * 4;
            dst2[i] = r / cnt; dst2[i+1] = g / cnt; dst2[i+2] = b / cnt; dst2[i+3] = 255;
        }
    }

    // Blend: if fractional, mix original with blurred by the fractional amount
    const blendFactor = intR === 0 ? frac : (intR + frac) / (intR + 1);
    if (blendFactor < 1.0) {
        const inv = 1.0 - blendFactor;
        for (let i = 0; i < src.length; i += 4) {
            dst2[i]   = Math.round(src[i]   * inv + dst2[i]   * blendFactor);
            dst2[i+1] = Math.round(src[i+1] * inv + dst2[i+1] * blendFactor);
            dst2[i+2] = Math.round(src[i+2] * inv + dst2[i+2] * blendFactor);
        }
    }

    return new ImageData(dst2, w, h);
}

// --- Noise removal: remove small isolated diff regions ---
function removeNoiseFromChangeMap(changeMap, typeMap, width, height, minSize) {
    if (minSize <= 0) return;
    const visited = new Uint8Array(width * height);
    const total = width * height;

    for (let i = 0; i < total; i++) {
        if (!changeMap[i] || visited[i]) continue;

        // BFS to find connected component
        const queue = [i];
        visited[i] = 1;
        const component = [i];
        let head = 0;

        while (head < queue.length) {
            const cur = queue[head++];
            const cx = cur % width, cy = (cur / width) | 0;

            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                const nx = cx + dx, ny = cy + dy;
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    const ni = ny * width + nx;
                    if (changeMap[ni] && !visited[ni]) {
                        visited[ni] = 1;
                        queue.push(ni);
                        component.push(ni);
                    }
                }
            }
        }

        // If component is too small, clear it
        if (component.length <= minSize) {
            for (const idx of component) {
                changeMap[idx] = 0;
                if (typeMap) typeMap[idx] = 0;
            }
        }
    }
}

// --- Pixel Comparison (with offset, dilation, fade support) ---
function comparePages(oldCanvas, newCanvas, offsetX = 0, offsetY = 0, opts = {}) {
    const fade = opts.fade !== undefined ? opts.fade : state.fadeAmount;
    const dilate = opts.dilate !== undefined ? opts.dilate : state.dilateChanges;
    const scaleFactor = opts.scaleFactor !== undefined ? opts.scaleFactor : 1.0;
    const blurRadius = opts.blurRadius !== undefined ? opts.blurRadius : state.blurRadius;
    const noiseSize = opts.noiseSize !== undefined ? opts.noiseSize : state.noiseSize;

    const width = Math.max(oldCanvas?.width || 0, newCanvas?.width || 0);
    const height = Math.max(oldCanvas?.height || 0, newCanvas?.height || 0);

    // Old canvas data
    const oldCtx = document.createElement("canvas").getContext("2d");
    oldCtx.canvas.width = width;
    oldCtx.canvas.height = height;
    oldCtx.fillStyle = "white";
    oldCtx.fillRect(0, 0, width, height);
    if (oldCanvas) oldCtx.drawImage(oldCanvas, 0, 0);
    let oldData = oldCtx.getImageData(0, 0, width, height);

    // New canvas data (scale + offset applied)
    const newCtx = document.createElement("canvas").getContext("2d");
    newCtx.canvas.width = width;
    newCtx.canvas.height = height;
    newCtx.fillStyle = "white";
    newCtx.fillRect(0, 0, width, height);
    if (newCanvas) {
        if (scaleFactor !== 1.0) {
            const cw = oldCanvas ? oldCanvas.width : width;
            const ch = oldCanvas ? oldCanvas.height : height;
            const cx = cw / 2;
            const cy = ch / 2;
            newCtx.translate(cx + offsetX, cy + offsetY);
            newCtx.scale(scaleFactor, scaleFactor);
            newCtx.translate(-cx, -cy);
            newCtx.drawImage(newCanvas, 0, 0);
            newCtx.setTransform(1, 0, 0, 1, 0, 0);
        } else {
            newCtx.drawImage(newCanvas, offsetX, offsetY);
        }
    }
    let newData = newCtx.getImageData(0, 0, width, height);

    // Apply blur pre-processing to reduce anti-aliasing noise
    if (blurRadius > 0) {
        oldData = boxBlurImageData(oldData, blurRadius);
        newData = boxBlurImageData(newData, blurRadius);
    }

    // Result image data
    const tmpCtx = document.createElement("canvas").getContext("2d");
    tmpCtx.canvas.width = width;
    tmpCtx.canvas.height = height;
    const resultData = tmpCtx.createImageData(width, height);
    const diffOnlyData = tmpCtx.createImageData(width, height);
    const oldColoredData = tmpCtx.createImageData(width, height);
    const newColoredData = tmpCtx.createImageData(width, height);

    // Change map for noise removal & dilation (1 = changed)
    const needMap = dilate || noiseSize > 0;
    const changeMap = needMap ? new Uint8Array(width * height) : null;
    // Type map for dilation coloring (1=deleted, 2=added, 3=modified)
    const typeMap = needMap ? new Uint8Array(width * height) : null;

    let diffPixels = 0;
    const totalPixels = width * height;
    const threshold = opts.sensitivity !== undefined ? opts.sensitivity : state.sensitivity;

    for (let i = 0; i < oldData.data.length; i += 4) {
        const px = (i / 4) | 0;
        const rOld = oldData.data[i];
        const gOld = oldData.data[i + 1];
        const bOld = oldData.data[i + 2];
        const rNew = newData.data[i];
        const gNew = newData.data[i + 1];
        const bNew = newData.data[i + 2];

        const diff = Math.abs(rOld - rNew) + Math.abs(gOld - gNew) + Math.abs(bOld - bNew);

        if (diff > threshold) {
            diffPixels++;
            if (changeMap) changeMap[px] = 1;

            const oldIsContent = (rOld + gOld + bOld) < 700;
            const newIsContent = (rNew + gNew + bNew) < 700;

            if (oldIsContent && !newIsContent) {
                // 削除: 赤
                if (typeMap) typeMap[px] = 1;
                resultData.data[i] = 239; resultData.data[i+1] = 68; resultData.data[i+2] = 68; resultData.data[i+3] = 200;
                diffOnlyData.data[i] = 239; diffOnlyData.data[i+1] = 68; diffOnlyData.data[i+2] = 68; diffOnlyData.data[i+3] = 255;
                oldColoredData.data[i] = 239; oldColoredData.data[i+1] = Math.round(gOld * 0.3 + 68 * 0.7); oldColoredData.data[i+2] = Math.round(bOld * 0.3 + 68 * 0.7); oldColoredData.data[i+3] = 255;
                newColoredData.data[i] = 255; newColoredData.data[i+1] = 220; newColoredData.data[i+2] = 220; newColoredData.data[i+3] = 255;
            } else if (!oldIsContent && newIsContent) {
                // 追加: 青
                if (typeMap) typeMap[px] = 2;
                resultData.data[i] = 59; resultData.data[i+1] = 130; resultData.data[i+2] = 246; resultData.data[i+3] = 200;
                diffOnlyData.data[i] = 59; diffOnlyData.data[i+1] = 130; diffOnlyData.data[i+2] = 246; diffOnlyData.data[i+3] = 255;
                oldColoredData.data[i] = 220; oldColoredData.data[i+1] = 230; oldColoredData.data[i+2] = 255; oldColoredData.data[i+3] = 255;
                newColoredData.data[i] = Math.round(rNew * 0.3); newColoredData.data[i+1] = Math.round(gNew * 0.3); newColoredData.data[i+2] = 246; newColoredData.data[i+3] = 255;
            } else {
                // 変更: 紫
                if (typeMap) typeMap[px] = 3;
                resultData.data[i] = 180; resultData.data[i+1] = 80; resultData.data[i+2] = 200; resultData.data[i+3] = 200;
                diffOnlyData.data[i] = 180; diffOnlyData.data[i+1] = 80; diffOnlyData.data[i+2] = 200; diffOnlyData.data[i+3] = 255;
                oldColoredData.data[i] = 239; oldColoredData.data[i+1] = Math.round(gOld * 0.4 + 68 * 0.6); oldColoredData.data[i+2] = Math.round(bOld * 0.4 + 68 * 0.6); oldColoredData.data[i+3] = 255;
                newColoredData.data[i] = Math.round(rNew * 0.4); newColoredData.data[i+1] = Math.round(gNew * 0.4); newColoredData.data[i+2] = 246; newColoredData.data[i+3] = 255;
            }
        } else {
            // 変更なし - fade適用
            const gray = Math.round((rNew + gNew + bNew) / 3);
            const blended = Math.round(gray * (1 - fade) + 255 * fade);
            resultData.data[i] = blended; resultData.data[i+1] = blended; resultData.data[i+2] = blended; resultData.data[i+3] = 255;
            diffOnlyData.data[i] = 255; diffOnlyData.data[i+1] = 255; diffOnlyData.data[i+2] = 255; diffOnlyData.data[i+3] = 255;
            oldColoredData.data[i] = rOld; oldColoredData.data[i+1] = gOld; oldColoredData.data[i+2] = bOld; oldColoredData.data[i+3] = 255;
            newColoredData.data[i] = rNew; newColoredData.data[i+1] = gNew; newColoredData.data[i+2] = bNew; newColoredData.data[i+3] = 255;
        }
    }

    // Noise removal: remove small isolated diff regions
    if (noiseSize > 0 && changeMap) {
        removeNoiseFromChangeMap(changeMap, typeMap, width, height, noiseSize);
        // Re-paint removed pixels as unchanged
        diffPixels = 0;
        for (let px = 0; px < width * height; px++) {
            if (changeMap[px]) {
                diffPixels++;
            } else if (typeMap[px] === 0) {
                // Already unchanged — skip
            } else {
                // Was marked as changed but noise-removed — revert to unchanged appearance
                const i = px * 4;
                // Use original new image for unchanged rendering
                const rNew = newData.data[i], gNew = newData.data[i+1], bNew = newData.data[i+2];
                const rOld = oldData.data[i], gOld = oldData.data[i+1], bOld = oldData.data[i+2];
                const gray = Math.round((rNew + gNew + bNew) / 3);
                const blended = Math.round(gray * (1 - fade) + 255 * fade);
                resultData.data[i] = blended; resultData.data[i+1] = blended; resultData.data[i+2] = blended; resultData.data[i+3] = 255;
                diffOnlyData.data[i] = 255; diffOnlyData.data[i+1] = 255; diffOnlyData.data[i+2] = 255; diffOnlyData.data[i+3] = 255;
                oldColoredData.data[i] = rOld; oldColoredData.data[i+1] = gOld; oldColoredData.data[i+2] = bOld; oldColoredData.data[i+3] = 255;
                newColoredData.data[i] = rNew; newColoredData.data[i+1] = gNew; newColoredData.data[i+2] = bNew; newColoredData.data[i+3] = 255;
                typeMap[px] = 0;
            }
        }
    }

    // Dilation: expand changed pixels by 1px for visibility
    if (dilate && changeMap) {
        const dilateTargets = [resultData, diffOnlyData];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (changeMap[idx]) continue; // already changed
                // Check 4-neighbors
                let neighborType = 0;
                for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nx = x + dx, ny = y + dy;
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        const nIdx = ny * width + nx;
                        if (changeMap[nIdx]) {
                            neighborType = typeMap[nIdx];
                            break;
                        }
                    }
                }
                if (neighborType) {
                    const i = idx * 4;
                    let r, g, b;
                    if (neighborType === 1) { r = 239; g = 68; b = 68; }
                    else if (neighborType === 2) { r = 59; g = 130; b = 246; }
                    else { r = 180; g = 80; b = 200; }
                    // Apply at reduced opacity for border effect
                    for (const target of dilateTargets) {
                        target.data[i] = Math.round(target.data[i] * 0.5 + r * 0.5);
                        target.data[i+1] = Math.round(target.data[i+1] * 0.5 + g * 0.5);
                        target.data[i+2] = Math.round(target.data[i+2] * 0.5 + b * 0.5);
                        target.data[i+3] = 255;
                    }
                }
            }
        }
    }

    const percent = ((diffPixels / totalPixels) * 100).toFixed(2);

    return { resultData, diffOnlyData, oldColoredData, newColoredData, width, height, percent };
}

// --- Change Region Detection ---
function detectChangeRegions(diffOnlyData, width, height) {
    const cellSize = 8;
    const cols = Math.ceil(width / cellSize);
    const rows = Math.ceil(height / cellSize);
    const grid = new Uint8Array(cols * rows);

    // Mark cells containing changed pixels
    const data = diffOnlyData.data;
    for (let y = 0; y < height; y++) {
        const row = (y / cellSize) | 0;
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i] !== 255 || data[i+1] !== 255 || data[i+2] !== 255) {
                grid[row * cols + ((x / cellSize) | 0)] = 1;
            }
        }
    }

    // Connected component labeling (BFS)
    const visited = new Uint8Array(cols * rows);
    const regions = [];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const gIdx = r * cols + c;
            if (!grid[gIdx] || visited[gIdx]) continue;

            const queue = [[r, c]];
            visited[gIdx] = 1;
            let minR = r, maxR = r, minC = c, maxC = c;
            let head = 0;

            while (head < queue.length) {
                const [cr, cc] = queue[head++];
                if (cr < minR) minR = cr;
                if (cr > maxR) maxR = cr;
                if (cc < minC) minC = cc;
                if (cc > maxC) maxC = cc;

                for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nr = cr + dr, nc = cc + dc;
                    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                        const nIdx = nr * cols + nc;
                        if (grid[nIdx] && !visited[nIdx]) {
                            visited[nIdx] = 1;
                            queue.push([nr, nc]);
                        }
                    }
                }
            }

            regions.push({
                x: minC * cellSize,
                y: minR * cellSize,
                w: (maxC - minC + 1) * cellSize,
                h: (maxR - minR + 1) * cellSize,
            });
        }
    }

    // Merge nearby regions
    const gap = 24;
    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i < regions.length; i++) {
            for (let j = i + 1; j < regions.length; j++) {
                const a = regions[i], b = regions[j];
                if (a.x - gap <= b.x + b.w && b.x - gap <= a.x + a.w &&
                    a.y - gap <= b.y + b.h && b.y - gap <= a.y + a.h) {
                    const nx = Math.min(a.x, b.x);
                    const ny = Math.min(a.y, b.y);
                    regions[i] = {
                        x: nx, y: ny,
                        w: Math.max(a.x + a.w, b.x + b.w) - nx,
                        h: Math.max(a.y + a.h, b.y + b.h) - ny,
                    };
                    regions.splice(j, 1);
                    merged = true;
                    break;
                }
            }
            if (merged) break;
        }
    }

    // Sort top-to-bottom, left-to-right
    regions.sort((a, b) => a.y - b.y || a.x - b.x);
    return regions;
}

// --- Draw change region overlays ---
function drawChangeRegionOverlays() {
    if (!state.changeRegions.length) return;
    const ctx = canvasResult.getContext("2d");
    ctx.save();
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);

    state.changeRegions.forEach((r, i) => {
        if (i === state.currentChangeIndex) {
            ctx.strokeStyle = "#ef4444";
            ctx.lineWidth = 4;
            ctx.setLineDash([]);
        } else {
            ctx.strokeStyle = "#f59e0b";
            ctx.lineWidth = 3;
            ctx.setLineDash([6, 4]);
        }
        const pad = 6;
        ctx.strokeRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
    });
    ctx.restore();
}

// --- Navigate to change region ---
function navigateToChangeRegion(index) {
    if (!state.changeRegions.length) return;
    if (index < 0) index = state.changeRegions.length - 1;
    if (index >= state.changeRegions.length) index = 0;

    state.currentChangeIndex = index;
    updateChangeNav();

    const r = state.changeRegions[index];
    const viewW = canvasViewport.clientWidth;
    const viewH = canvasViewport.clientHeight;
    const padPx = 80; // viewport padding in pixels

    // Calculate zoom to fit the change region comfortably in viewport
    const regionCssW = r.w / state.scale; // region width in CSS pixels at zoom=1
    const regionCssH = r.h / state.scale;

    const zoomW = (viewW - padPx * 2) / regionCssW;
    const zoomH = (viewH - padPx * 2) / regionCssH;
    let targetZoom = Math.min(zoomW, zoomH);

    // Clamp: reasonable range for viewing changes
    targetZoom = Math.min(targetZoom, 4);  // don't zoom in too much
    targetZoom = Math.max(targetZoom, 0.5); // don't zoom out too much
    targetZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, targetZoom));

    setZoom(targetZoom);

    // Redraw to show green highlight frame
    applyMode();

    // Scroll viewport to center the region
    const zoomRatio = state.zoom / state.scale;
    const cx = (r.x + r.w / 2) * zoomRatio + 8;
    const cy = (r.y + r.h / 2) * zoomRatio + 8;

    canvasViewport.scrollTo({
        left: cx - viewW / 2,
        top: cy - viewH / 2,
        behavior: "smooth",
    });
}

function updateChangeNav() {
    const n = state.changeRegions.length;
    const cur = state.currentChangeIndex;
    changeInfoEl.textContent = n > 0 ? `変更 ${cur + 1}/${n}` : "変更 0/0";
    btnPrevChange.disabled = n === 0;
    btnNextChange.disabled = n === 0;
}

// --- Render Current Page ---
// Get mapped page numbers for a given comparison index (1-based)
function getMappedPages(compIndex) {
    if (state.pageMapping.length > 0 && compIndex >= 1 && compIndex <= state.pageMapping.length) {
        const pair = state.pageMapping[compIndex - 1];
        return { oldPage: pair.oldPage, newPage: pair.newPage };
    }
    return { oldPage: compIndex, newPage: compIndex };
}

async function renderCurrentPage() {
    loading.hidden = false;
    loadingText.textContent = `ページ ${state.currentPage} を比較中...`;

    try {
        const { oldPage, newPage } = getMappedPages(state.currentPage);
        const oldCanvas = oldPage ? await renderPageToCanvas(state.oldPdf, oldPage) : null;
        const newCanvas = newPage ? await renderPageToCanvas(state.newPdf, newPage) : null;

        state.renderedOldCanvas = oldCanvas;
        state.renderedNewCanvas = newCanvas;

        runComparison();

        // UI
        const { oldPage: dispOld, newPage: dispNew } = getMappedPages(state.currentPage);
        const pageLabel = dispOld && dispNew
            ? `旧P${dispOld} ⇔ 新P${dispNew}`
            : dispOld ? `旧P${dispOld} (削除)`
            : dispNew ? `新P${dispNew} (新規)` : "";
        pageInfo.textContent = `${state.currentPage}/${state.totalPages} [${pageLabel}]`;
        btnPrev.disabled = state.currentPage <= 1;
        btnNext.disabled = state.currentPage >= state.totalPages;
        updateAdjustDisplay();
        updateScaleSlider();
        updateActiveThumbnail();
    } catch (err) {
        alert("ページの比較中にエラーが発生しました: " + err.message);
    } finally {
        loading.hidden = true;
    }
}

// --- Run comparison with current offset ---
function runComparison() {
    const oldCanvas = state.renderedOldCanvas;
    const newCanvas = state.renderedNewCanvas;
    const offset = getPageOffset(state.currentPage);
    const canvasOffsetX = offset.x;
    const canvasOffsetY = offset.y;
    const scaleFactor = getPageScale(state.currentPage);

    const { resultData, diffOnlyData, oldColoredData, newColoredData, width, height, percent } =
        comparePages(oldCanvas, newCanvas, canvasOffsetX, canvasOffsetY, { scaleFactor });

    canvasResult.width = width;
    canvasResult.height = height;

    state.overlayData = resultData;
    state.diffOnlyData = diffOnlyData;
    state.oldColoredData = oldColoredData;
    state.newColoredData = newColoredData;
    state.canvasWidth = width;
    state.canvasHeight = height;

    // Side-by-side canvases
    const drawPlaceholder = (c, w, h) => {
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#f1f5f9";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "24px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("ページなし", w / 2, h / 2);
    };

    if (oldCanvas) {
        canvasOld.width = oldCanvas.width;
        canvasOld.height = oldCanvas.height;
        canvasOld.getContext("2d").drawImage(oldCanvas, 0, 0);
    } else {
        drawPlaceholder(canvasOld, width, height);
    }

    if (newCanvas) {
        canvasNew.width = newCanvas.width;
        canvasNew.height = newCanvas.height;
        canvasNew.getContext("2d").drawImage(newCanvas, 0, 0);
    } else {
        drawPlaceholder(canvasNew, width, height);
    }

    // Detect change regions
    state.changeRegions = detectChangeRegions(diffOnlyData, width, height);
    state.currentChangeIndex = state.changeRegions.length > 0 ? 0 : -1;
    updateChangeNav();

    applyMode();
    diffBadge.textContent = `差分: ${percent}%`;
}

// --- Apply View Mode ---
function applyMode() {
    const ctx = canvasResult.getContext("2d");
    canvasResult.width = state.canvasWidth;
    canvasResult.height = state.canvasHeight;

    if (state.mode === "overlay") {
        viewOverlay.hidden = false;
        viewSideBySide.hidden = true;
        ctx.putImageData(state.overlayData, 0, 0);
    } else if (state.mode === "diff") {
        viewOverlay.hidden = false;
        viewSideBySide.hidden = true;
        ctx.putImageData(state.diffOnlyData, 0, 0);
    } else if (state.mode === "old_colored") {
        viewOverlay.hidden = false;
        viewSideBySide.hidden = true;
        ctx.putImageData(state.oldColoredData, 0, 0);
    } else if (state.mode === "new_colored") {
        viewOverlay.hidden = false;
        viewSideBySide.hidden = true;
        ctx.putImageData(state.newColoredData, 0, 0);
    } else {
        // sidebyside
        viewOverlay.hidden = true;
        viewSideBySide.hidden = false;
    }

    // Draw green highlight frame around current change region
    if (state.mode !== "sidebyside" &&
        state.currentChangeIndex >= 0 &&
        state.currentChangeIndex < state.changeRegions.length) {
        drawChangeHighlight(ctx);
    }

    applyZoomToCanvases();
}

// --- Draw green highlight frame around selected change region ---
function drawChangeHighlight(ctx) {
    const r = state.changeRegions[state.currentChangeIndex];
    const pad = 12;
    ctx.save();

    // Outer glow effect
    ctx.strokeStyle = "rgba(34, 197, 94, 0.3)";
    ctx.lineWidth = 10;
    ctx.strokeRect(r.x - pad - 3, r.y - pad - 3, r.w + (pad + 3) * 2, r.h + (pad + 3) * 2);

    // Main green frame
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 4;
    ctx.strokeRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);

    // Corner marks for extra visibility
    const cornerLen = Math.min(20, r.w / 4, r.h / 4);
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 5;
    const x1 = r.x - pad, y1 = r.y - pad;
    const x2 = r.x + r.w + pad, y2 = r.y + r.h + pad;

    // Top-left
    ctx.beginPath(); ctx.moveTo(x1, y1 + cornerLen); ctx.lineTo(x1, y1); ctx.lineTo(x1 + cornerLen, y1); ctx.stroke();
    // Top-right
    ctx.beginPath(); ctx.moveTo(x2 - cornerLen, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + cornerLen); ctx.stroke();
    // Bottom-left
    ctx.beginPath(); ctx.moveTo(x1, y2 - cornerLen); ctx.lineTo(x1, y2); ctx.lineTo(x1 + cornerLen, y2); ctx.stroke();
    // Bottom-right
    ctx.beginPath(); ctx.moveTo(x2 - cornerLen, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - cornerLen); ctx.stroke();

    ctx.restore();
}

// --- Navigation ---
btnPrev.addEventListener("click", () => {
    if (state.currentPage > 1) {
        state.currentPage--;
        renderCurrentPage();
    }
});

btnNext.addEventListener("click", () => {
    if (state.currentPage < state.totalPages) {
        state.currentPage++;
        renderCurrentPage();
    }
});

btnBack.addEventListener("click", () => {
    resultSection.hidden = true;
    mappingSection.hidden = true;
    uploadSection.hidden = false;
    document.body.classList.remove("comparing");
    state.oldPdf = null;
    state.newPdf = null;
    state.pageMapping = [];
    state.pageChangeData = [];
    thumbnailList.innerHTML = "";
    changeSummary.textContent = "";
    exitAdjustMode();
});

// Change navigation
btnPrevChange.addEventListener("click", () => {
    navigateToChangeRegion(state.currentChangeIndex - 1);
});

btnNextChange.addEventListener("click", () => {
    navigateToChangeRegion(state.currentChangeIndex + 1);
});

// --- Mode Switching ---
modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        modeButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.mode = btn.dataset.mode;
        applyMode();
    });
});

// --- Zoom ---
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.25;

function setZoom(newZoom) {
    state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    applyZoomToCanvases();
    zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function applyZoomToCanvases() {
    const allCanvases = [canvasResult, canvasOld, canvasNew];
    allCanvases.forEach((c) => {
        if (c.width > 0) {
            c.style.width = (c.width * state.zoom) / state.scale + "px";
            c.style.height = (c.height * state.zoom) / state.scale + "px";
        }
    });
}

btnZoomIn.addEventListener("click", () => setZoom(state.zoom + ZOOM_STEP));
btnZoomOut.addEventListener("click", () => setZoom(state.zoom - ZOOM_STEP));
btnZoomFit.addEventListener("click", () => {
    setZoom(1);
    canvasViewport.scrollTo(0, 0);
});

canvasViewport.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom(state.zoom + delta);
}, { passive: false });

// --- Pan / Adjust Drag ---
canvasViewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;

    if (state.adjustMode) {
        state.isAdjusting = true;
        state.adjustStartX = e.clientX;
        state.adjustStartY = e.clientY;
        const offset = getPageOffset(state.currentPage);
        state.adjustStartOffsetX = offset.x;
        state.adjustStartOffsetY = offset.y;
        canvasViewport.classList.add("grabbing");
        e.preventDefault();
    } else {
        state.isPanning = true;
        state.panStartX = e.clientX;
        state.panStartY = e.clientY;
        state.scrollStartX = canvasViewport.scrollLeft;
        state.scrollStartY = canvasViewport.scrollTop;
        canvasViewport.classList.add("grabbing");
    }
});

document.addEventListener("mousemove", (e) => {
    if (state.isAdjusting) {
        const dx = (e.clientX - state.adjustStartX) * state.scale / state.zoom;
        const dy = (e.clientY - state.adjustStartY) * state.scale / state.zoom;
        const newOffset = {
            x: state.adjustStartOffsetX + dx,
            y: state.adjustStartOffsetY + dy,
        };
        state.pageOffsets[state.currentPage] = newOffset;
        updateAdjustDisplay();
        renderAdjustPreview();
    } else if (state.isPanning) {
        const dx = e.clientX - state.panStartX;
        const dy = e.clientY - state.panStartY;
        canvasViewport.scrollLeft = state.scrollStartX - dx;
        canvasViewport.scrollTop = state.scrollStartY - dy;
    }
});

document.addEventListener("mouseup", () => {
    if (state.isAdjusting) {
        state.isAdjusting = false;
        canvasViewport.classList.remove("grabbing");
        runComparison();
    }
    if (state.isPanning) {
        state.isPanning = false;
        canvasViewport.classList.remove("grabbing");
    }
});

// --- Adjustment Mode ---
function enterAdjustMode() {
    state.adjustMode = true;
    btnAdjust.classList.add("active");
    adjustPanel.hidden = false;
    canvasViewport.classList.add("adjust-mode");
    updateAdjustDisplay();
}

function exitAdjustMode() {
    state.adjustMode = false;
    btnAdjust.classList.remove("active");
    adjustPanel.hidden = true;
    canvasViewport.classList.remove("adjust-mode");
}

btnAdjust.addEventListener("click", () => {
    state.adjustMode ? exitAdjustMode() : enterAdjustMode();
});

btnAdjustReset.addEventListener("click", () => {
    state.pageOffsets[state.currentPage] = { x: 0, y: 0 };
    state.pageScales[state.currentPage] = 1.0;
    updateScaleSlider();
    updateAdjustDisplay();
    runComparison();
});

function updateAdjustDisplay() {
    const offset = getPageOffset(state.currentPage);
    const scale = getPageScale(state.currentPage);
    const scaleText = scale !== 1.0 ? `　縮尺: ${(scale * 100).toFixed(1)}%` : "";
    const dispX = Math.round(offset.x / state.scale);
    const dispY = Math.round(offset.y / state.scale);
    adjustOffset.textContent = `X: ${dispX}　Y: ${dispY}${scaleText}`;
}

// Lightweight preview during drag
function renderAdjustPreview() {
    if (!state.renderedOldCanvas && !state.renderedNewCanvas) return;

    const oldC = state.renderedOldCanvas;
    const newC = state.renderedNewCanvas;
    const offset = getPageOffset(state.currentPage);
    const ox = offset.x;
    const oy = offset.y;
    const sf = getPageScale(state.currentPage);

    const width = Math.max(oldC?.width || 0, newC?.width || 0);
    const height = Math.max(oldC?.height || 0, newC?.height || 0);

    canvasResult.width = width;
    canvasResult.height = height;
    state.canvasWidth = width;
    state.canvasHeight = height;
    const ctx = canvasResult.getContext("2d");

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);

    ctx.globalAlpha = 0.5;
    if (oldC) ctx.drawImage(oldC, 0, 0);
    ctx.globalAlpha = 0.5;
    if (newC) {
        if (sf !== 1.0) {
            const cw = oldC ? oldC.width : width;
            const ch = oldC ? oldC.height : height;
            const cx = cw / 2, cy = ch / 2;
            ctx.translate(cx + ox, cy + oy);
            ctx.scale(sf, sf);
            ctx.translate(-cx, -cy);
            ctx.drawImage(newC, 0, 0);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        } else {
            ctx.drawImage(newC, ox, oy);
        }
    }
    ctx.globalAlpha = 1.0;

    viewOverlay.hidden = false;
    viewSideBySide.hidden = true;
    applyZoomToCanvases();
}

// --- Auto Fit (position + scale) ---
const btnAutoFit = $("btn-auto-fit");
const btnAutoFitAll = $("btn-auto-fit-all");
const scaleSlider = $("scale-slider");
const scaleValue = $("scale-value");

function updateScaleSlider() {
    const sf = getPageScale(state.currentPage);
    scaleSlider.value = Math.round(sf * 1000);
    scaleValue.textContent = `${(sf * 100).toFixed(1)}%`;
}

// 統合自動合わせアルゴリズム: 位置＋縮尺を同時に最適化
// 戻り値の offsetX/offsetY は canvas pixel 単位 (state.scale 掛け済み)
function autoFitPages(oldCanvas, newCanvas) {
    const targetWidth = 600;
    const scaleDown = targetWidth / Math.max(oldCanvas.width, 1);
    const tw = Math.round(oldCanvas.width * scaleDown);
    const th = Math.round(oldCanvas.height * scaleDown);

    function getImageBinary(canvas, tw, th) {
        const c = document.createElement("canvas");
        c.width = tw; c.height = th;
        const ctx = c.getContext("2d");
        ctx.drawImage(canvas, 0, 0, tw, th);
        const data = ctx.getImageData(0, 0, tw, th).data;
        const binary = new Uint8Array(tw * th);
        for (let i = 0; i < tw * th; i++) {
            const gray = data[i*4] * 0.299 + data[i*4+1] * 0.587 + data[i*4+2] * 0.114;
            binary[i] = gray < 200 ? 1 : 0;
        }
        return binary;
    }

    function getScaledBinary(canvas, scaleFactor) {
        const c = document.createElement("canvas");
        c.width = tw; c.height = th;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, tw, th);
        const cx = tw / 2, cy = th / 2;
        ctx.translate(cx, cy);
        ctx.scale(scaleFactor, scaleFactor);
        ctx.translate(-cx, -cy);
        ctx.drawImage(canvas, 0, 0, tw, th);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const data = ctx.getImageData(0, 0, tw, th).data;
        const binary = new Uint8Array(tw * th);
        for (let i = 0; i < tw * th; i++) {
            const gray = data[i*4] * 0.299 + data[i*4+1] * 0.587 + data[i*4+2] * 0.114;
            binary[i] = gray < 200 ? 1 : 0;
        }
        return binary;
    }

    const bOld = getImageBinary(oldCanvas, tw, th);

    // コンテンツが少なすぎる場合はスキップ
    let contentCount = 0;
    for (let i = 0; i < bOld.length; i++) contentCount += bOld[i];
    if (contentCount < 50) return { scale: 1.0, offsetX: 0, offsetY: 0 };

    function calcMatchScore(bNew, ox, oy) {
        let matches = 0, total = 0;
        const yStart = Math.max(0, -oy), yEnd = Math.min(th, th - oy);
        const xStart = Math.max(0, -ox), xEnd = Math.min(tw, tw - ox);
        for (let y = yStart; y < yEnd; y++) {
            for (let x = xStart; x < xEnd; x++) {
                const oi = y * tw + x;
                const ni = (y + oy) * tw + (x + ox);
                if (bOld[oi] || bNew[ni]) {
                    total++;
                    if (bOld[oi] === bNew[ni]) matches++;
                }
            }
        }
        return total > 0 ? matches / total : 0;
    }

    let bestScore = -1, bestScale = 1.0, bestOx = 0, bestOy = 0;
    const posRange = 40;

    // Phase 1: 粗い探索 — 縮尺1%刻み × 位置5px刻み
    for (let s = 930; s <= 1070; s += 10) {
        const sf = s / 1000;
        const bNew = getScaledBinary(newCanvas, sf);
        for (let oy = -posRange; oy <= posRange; oy += 5) {
            for (let ox = -posRange; ox <= posRange; ox += 5) {
                const score = calcMatchScore(bNew, ox, oy);
                if (score > bestScore) {
                    bestScore = score; bestScale = sf; bestOx = ox; bestOy = oy;
                }
            }
        }
    }

    // Phase 2: 中間探索 — 縮尺0.3%刻み × 位置2px刻み
    const midScale = Math.round(bestScale * 1000);
    const midOx = bestOx, midOy = bestOy;
    for (let s = midScale - 15; s <= midScale + 15; s += 3) {
        const sf = s / 1000;
        const bNew = getScaledBinary(newCanvas, sf);
        for (let oy = midOy - 10; oy <= midOy + 10; oy += 2) {
            for (let ox = midOx - 10; ox <= midOx + 10; ox += 2) {
                const score = calcMatchScore(bNew, ox, oy);
                if (score > bestScore) {
                    bestScore = score; bestScale = sf; bestOx = ox; bestOy = oy;
                }
            }
        }
    }

    // Phase 3: 精密探索 — 縮尺0.1%刻み × 位置1px刻み
    const fineScale = Math.round(bestScale * 1000);
    const fineOx = bestOx, fineOy = bestOy;
    for (let s = fineScale - 5; s <= fineScale + 5; s += 1) {
        const sf = s / 1000;
        const bNew = getScaledBinary(newCanvas, sf);
        for (let oy = fineOy - 4; oy <= fineOy + 4; oy++) {
            for (let ox = fineOx - 4; ox <= fineOx + 4; ox++) {
                const score = calcMatchScore(bNew, ox, oy);
                if (score > bestScore) {
                    bestScore = score; bestScale = sf; bestOx = ox; bestOy = oy;
                }
            }
        }
    }

    // ダウンサンプル座標 → canvas pixel座標に変換 (丸め誤差を最小化)
    return {
        scale: bestScale,
        offsetX: bestOx / scaleDown,
        offsetY: bestOy / scaleDown,
    };
}

// 現ページのみ自動合わせ
btnAutoFit.addEventListener("click", () => {
    if (!state.renderedOldCanvas || !state.renderedNewCanvas) return;
    loading.hidden = false;
    loadingText.textContent = "自動合わせ中...";
    setTimeout(() => {
        try {
            const result = autoFitPages(state.renderedOldCanvas, state.renderedNewCanvas);
            state.pageScales[state.currentPage] = result.scale;
            state.pageOffsets[state.currentPage] = { x: result.offsetX, y: result.offsetY };
            updateScaleSlider();
            updateAdjustDisplay();
            runComparison();
        } catch (err) {
            alert("自動合わせに失敗しました: " + err.message);
        } finally {
            loading.hidden = true;
        }
    }, 50);
});

// 全ページ自動合わせ
btnAutoFitAll.addEventListener("click", () => {
    if (!state.oldPdf || !state.newPdf) return;
    loading.hidden = false;

    async function processAllPages() {
        try {
            for (let p = 1; p <= state.totalPages; p++) {
                loadingText.textContent = `自動合わせ中... (${p}/${state.totalPages})`;
                // yield to UI
                await new Promise(r => setTimeout(r, 20));

                const { oldPage: afOld, newPage: afNew } = getMappedPages(p);
                const oldC = afOld ? await renderPageToCanvas(state.oldPdf, afOld) : null;
                const newC = afNew ? await renderPageToCanvas(state.newPdf, afNew) : null;
                if (!oldC || !newC) {
                    state.pageScales[p] = 1.0;
                    state.pageOffsets[p] = { x: 0, y: 0 };
                    continue;
                }
                const result = autoFitPages(oldC, newC);
                state.pageScales[p] = result.scale;
                state.pageOffsets[p] = { x: result.offsetX, y: result.offsetY };
            }
            // 現ページを再描画
            updateScaleSlider();
            updateAdjustDisplay();
            runComparison();
            // サムネイル再生成
            generateThumbnails();
        } catch (err) {
            alert("自動合わせに失敗しました: " + err.message);
        } finally {
            loading.hidden = true;
        }
    }
    processAllPages();
});

// Manual scale slider
scaleSlider.addEventListener("input", () => {
    const sf = scaleSlider.value / 1000;
    state.pageScales[state.currentPage] = sf;
    scaleValue.textContent = `${(sf * 100).toFixed(1)}%`;
    updateAdjustDisplay();
    runComparison();
});

// --- Sensitivity Control ---
const sensitivitySlider = $("sensitivity-slider");
const sensitivityNumber = $("sensitivity-number");

sensitivitySlider.addEventListener("input", () => {
    state.sensitivity = parseInt(sensitivitySlider.value);
    sensitivityNumber.value = state.sensitivity;
    runComparison();
});

sensitivityNumber.addEventListener("change", () => {
    let val = parseInt(sensitivityNumber.value);
    if (isNaN(val)) { sensitivityNumber.value = state.sensitivity; return; }
    val = Math.max(10, Math.min(765, val));
    sensitivityNumber.value = val;
    state.sensitivity = val;
    sensitivitySlider.value = val;
    runComparison();
});

// --- Display Options ---
fadeSlider.addEventListener("input", () => {
    state.fadeAmount = fadeSlider.value / 100;
    runComparison();
});

chkDilate.addEventListener("change", () => {
    state.dilateChanges = chkDilate.checked;
    runComparison();
});

// Blur slider
const blurSlider = $("blur-slider");
const blurValue = $("blur-value");

blurSlider.addEventListener("input", () => {
    state.blurRadius = parseInt(blurSlider.value) / 10;
    blurValue.textContent = state.blurRadius.toFixed(1);
    runComparison();
});

// Noise slider
const noiseSlider = $("noise-slider");
const noiseValue = $("noise-value");

noiseSlider.addEventListener("input", () => {
    state.noiseSize = parseInt(noiseSlider.value);
    noiseValue.textContent = state.noiseSize;
    runComparison();
});

// --- Thumbnail Generation ---
function generateThumbnails() {
    thumbnailList.innerHTML = "";
    state.pageChangeData = [];

    // Create placeholder items
    for (let p = 1; p <= state.totalPages; p++) {
        const item = document.createElement("div");
        item.className = "thumb-item" + (p === state.currentPage ? " active" : "");
        item.dataset.page = p;

        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        item.appendChild(canvas);

        const label = document.createElement("div");
        label.className = "thumb-label";
        const { oldPage: tOld, newPage: tNew } = getMappedPages(p);
        const thumbLabel = tOld && tNew ? `旧${tOld}⇔新${tNew}` : tOld ? `旧${tOld}(削除)` : `新${tNew}(新規)`;
        label.innerHTML = `<span class="thumb-page-num">${thumbLabel}</span><span class="thumb-change-dot pending"></span>`;
        item.appendChild(label);

        item.addEventListener("click", () => {
            state.currentPage = parseInt(item.dataset.page);
            renderCurrentPage();
        });

        thumbnailList.appendChild(item);
        state.pageChangeData.push({ hasChanges: null, percent: 0 });
    }

    // Generate in background batches
    generateThumbnailBatch(1);
}

async function generateThumbnailBatch(startPage) {
    const batchSize = 3;
    const endPage = Math.min(startPage + batchSize - 1, state.totalPages);

    for (let p = startPage; p <= endPage; p++) {
        try {
            const thumbScale = 0.3;
            const { oldPage, newPage } = getMappedPages(p);
            const oldC = oldPage ? await renderPageToCanvas(state.oldPdf, oldPage, thumbScale) : null;
            const newC = newPage ? await renderPageToCanvas(state.newPdf, newPage, thumbScale) : null;

            const offset = getPageOffset(p);
            const ox = Math.round(offset.x * thumbScale / state.scale);
            const oy = Math.round(offset.y * thumbScale / state.scale);
            const sf = getPageScale(p);

            const result = comparePages(oldC, newC, ox, oy, { fade: 0.7, dilate: false, scaleFactor: sf });
            const hasChanges = parseFloat(result.percent) > 0;

            state.pageChangeData[p - 1] = { hasChanges, percent: result.percent };

            // Draw thumbnail
            const item = thumbnailList.children[p - 1];
            if (!item) continue;

            const canvas = item.querySelector("canvas");
            canvas.width = result.width;
            canvas.height = result.height;
            canvas.getContext("2d").putImageData(result.resultData, 0, 0);

            // Update indicator
            const dot = item.querySelector(".thumb-change-dot");
            dot.className = "thumb-change-dot " + (hasChanges ? "changed" : "unchanged");
            item.classList.toggle("has-changes", hasChanges);
            item.classList.toggle("no-changes", !hasChanges);

            // Update summary
            updateChangeSummary();
        } catch (e) {
            // Skip failed thumbnail
        }
    }

    // Schedule next batch
    if (endPage < state.totalPages) {
        setTimeout(() => generateThumbnailBatch(endPage + 1), 0);
    }
}

function updateChangeSummary() {
    const scanned = state.pageChangeData.filter(d => d.hasChanges !== null).length;
    const changed = state.pageChangeData.filter(d => d.hasChanges === true).length;

    if (scanned === 0) {
        changeSummary.textContent = "";
        return;
    }

    const changedPages = [];
    state.pageChangeData.forEach((d, i) => {
        if (d.hasChanges) changedPages.push(i + 1);
    });

    if (scanned < state.totalPages) {
        changeSummary.textContent = `解析中... ${scanned}/${state.totalPages}ページ完了 (${changed}ページに変更)`;
    } else {
        changeSummary.textContent = changed > 0
            ? `${state.totalPages}ページ中 ${changed}ページに変更あり: P${changedPages.join(", P")}`
            : `${state.totalPages}ページ中 変更なし`;
    }
}

function updateActiveThumbnail() {
    const items = thumbnailList.querySelectorAll(".thumb-item");
    items.forEach((item, i) => {
        item.classList.toggle("active", i + 1 === state.currentPage);
    });

    // Scroll active thumbnail into view
    const activeItem = thumbnailList.querySelector(".thumb-item.active");
    if (activeItem) {
        activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
}

// --- Sidebar ---
btnToggleSidebar.addEventListener("click", () => toggleSidebar(false));
btnOpenSidebar.addEventListener("click", () => toggleSidebar(true));

function toggleSidebar(show) {
    if (show === undefined) show = !state.sidebarVisible;
    state.sidebarVisible = show;
    thumbnailSidebar.classList.toggle("collapsed", !show);
    btnOpenSidebar.hidden = show;
}

// --- Help Modal ---
btnHelp.addEventListener("click", () => { helpModal.hidden = false; });
btnHelpClose.addEventListener("click", () => { helpModal.hidden = true; });
helpModal.addEventListener("click", (e) => {
    if (e.target === helpModal) helpModal.hidden = true;
});

// --- PDF Export ---
btnExportPdf.addEventListener("click", async () => {
    loading.hidden = false;
    loadingText.textContent = "PDF出力中...";

    try {
        const { jsPDF } = window.jspdf;

        const firstOldPage = await state.oldPdf.getPage(1);
        const firstViewport = firstOldPage.getViewport({ scale: 1 });
        const pageWidth = firstViewport.width;
        const pageHeight = firstViewport.height;

        const pdf = new jsPDF({
            orientation: pageWidth > pageHeight ? "landscape" : "portrait",
            unit: "pt",
            format: [pageWidth, pageHeight],
        });

        for (let p = 1; p <= state.totalPages; p++) {
            loadingText.textContent = `PDF出力中... (${p}/${state.totalPages})`;
            if (p > 1) {
                pdf.addPage([pageWidth, pageHeight], pageWidth > pageHeight ? "landscape" : "portrait");
            }

            const { oldPage: expOld, newPage: expNew } = getMappedPages(p);
            const oldCanvas = expOld ? await renderPageToCanvas(state.oldPdf, expOld) : null;
            const newCanvas = expNew ? await renderPageToCanvas(state.newPdf, expNew) : null;
            const offset = getPageOffset(p);
            const canvasOffsetX = offset.x;
            const canvasOffsetY = offset.y;

            let exportCanvas;
            if (state.mode === "sidebyside") {
                const w = (oldCanvas?.width || 0) + (newCanvas?.width || 0) + 20;
                const h = Math.max(oldCanvas?.height || 0, newCanvas?.height || 0);
                exportCanvas = document.createElement("canvas");
                exportCanvas.width = w;
                exportCanvas.height = h;
                const ctx = exportCanvas.getContext("2d");
                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, w, h);
                if (oldCanvas) ctx.drawImage(oldCanvas, 0, 0);
                if (newCanvas) ctx.drawImage(newCanvas, (oldCanvas?.width || 0) + 20, 0);
            } else {
                const exportScaleFactor = getPageScale(p);
                const result = comparePages(oldCanvas, newCanvas, canvasOffsetX, canvasOffsetY, { scaleFactor: exportScaleFactor });
                exportCanvas = document.createElement("canvas");
                exportCanvas.width = result.width;
                exportCanvas.height = result.height;
                const ctx = exportCanvas.getContext("2d");

                let data;
                if (state.mode === "diff") data = result.diffOnlyData;
                else if (state.mode === "old_colored") data = result.oldColoredData;
                else if (state.mode === "new_colored") data = result.newColoredData;
                else data = result.resultData;

                ctx.putImageData(data, 0, 0);
            }

            const imgData = exportCanvas.toDataURL("image/jpeg", 0.92);
            pdf.addImage(imgData, "JPEG", 0, 0, pageWidth, pageHeight);
        }

        pdf.save("pdf-comparison.pdf");
    } catch (err) {
        alert("PDF出力に失敗しました: " + err.message);
    } finally {
        loading.hidden = true;
    }
});

// --- Keyboard ---
document.addEventListener("keydown", (e) => {
    // Don't handle keys when modal is open
    if (!helpModal.hidden) return;
    if (resultSection.hidden) return;

    // Adjust mode arrow keys
    if (state.adjustMode) {
        const step = (e.shiftKey ? 10 : 1) * state.scale;
        const offset = getPageOffset(state.currentPage);
        let changed = false;
        let newOffset = { ...offset };

        if (e.key === "ArrowLeft") { e.preventDefault(); newOffset.x -= step; changed = true; }
        else if (e.key === "ArrowRight") { e.preventDefault(); newOffset.x += step; changed = true; }
        else if (e.key === "ArrowUp") { e.preventDefault(); newOffset.y -= step; changed = true; }
        else if (e.key === "ArrowDown") { e.preventDefault(); newOffset.y += step; changed = true; }

        if (changed) {
            state.pageOffsets[state.currentPage] = newOffset;
            updateAdjustDisplay();
            runComparison();
            return;
        }
    }

    // Normal shortcuts
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        btnPrev.click();
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        btnNext.click();
    } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoom(state.zoom + ZOOM_STEP);
    } else if (e.key === "-") {
        e.preventDefault();
        setZoom(state.zoom - ZOOM_STEP);
    } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
        canvasViewport.scrollTo(0, 0);
    } else if (e.key === "[") {
        e.preventDefault();
        navigateToChangeRegion(state.currentChangeIndex - 1);
    } else if (e.key === "]") {
        e.preventDefault();
        navigateToChangeRegion(state.currentChangeIndex + 1);
    } else if (e.key === "s" || e.key === "S") {
        if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            toggleSidebar();
        }
    }
});
