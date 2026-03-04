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
    applyOffsetToAll: false,
    // Change regions
    changeRegions: [],
    currentChangeIndex: -1,
    // Display options
    fadeAmount: 0.7,
    dilateChanges: true,
    // Thumbnails
    pageChangeData: [],
    sidebarVisible: true,
};

function getPageOffset(page) {
    return state.pageOffsets[page] || { x: 0, y: 0 };
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
const btnAutoAlign = $("btn-auto-align");
const chkApplyAll = $("chk-apply-all");
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

        state.totalPages = Math.max(state.oldPdf.numPages, state.newPdf.numPages);
        state.currentPage = 1;
        state.pageChangeData = [];
        state.pageOffsets = {};

        // Show result section
        uploadSection.hidden = true;
        resultSection.hidden = false;
        document.body.classList.add("comparing");

        // File info
        infoOldName.textContent = state.oldFile.name;
        infoNewName.textContent = state.newFile.name;

        loadingText.textContent = "比較中...";
        await renderCurrentPage();

        // Generate thumbnails in background
        generateThumbnails();
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

// --- Pixel Comparison (with offset, dilation, fade support) ---
function comparePages(oldCanvas, newCanvas, offsetX = 0, offsetY = 0, opts = {}) {
    const fade = opts.fade !== undefined ? opts.fade : state.fadeAmount;
    const dilate = opts.dilate !== undefined ? opts.dilate : state.dilateChanges;

    const width = Math.max(oldCanvas?.width || 0, newCanvas?.width || 0);
    const height = Math.max(oldCanvas?.height || 0, newCanvas?.height || 0);

    // Old canvas data
    const oldCtx = document.createElement("canvas").getContext("2d");
    oldCtx.canvas.width = width;
    oldCtx.canvas.height = height;
    oldCtx.fillStyle = "white";
    oldCtx.fillRect(0, 0, width, height);
    if (oldCanvas) oldCtx.drawImage(oldCanvas, 0, 0);
    const oldData = oldCtx.getImageData(0, 0, width, height);

    // New canvas data (offset applied)
    const newCtx = document.createElement("canvas").getContext("2d");
    newCtx.canvas.width = width;
    newCtx.canvas.height = height;
    newCtx.fillStyle = "white";
    newCtx.fillRect(0, 0, width, height);
    if (newCanvas) newCtx.drawImage(newCanvas, offsetX, offsetY);
    const newData = newCtx.getImageData(0, 0, width, height);

    // Result image data
    const tmpCtx = document.createElement("canvas").getContext("2d");
    tmpCtx.canvas.width = width;
    tmpCtx.canvas.height = height;
    const resultData = tmpCtx.createImageData(width, height);
    const diffOnlyData = tmpCtx.createImageData(width, height);
    const oldColoredData = tmpCtx.createImageData(width, height);
    const newColoredData = tmpCtx.createImageData(width, height);

    // Change map for dilation (1 = changed)
    const changeMap = dilate ? new Uint8Array(width * height) : null;
    // Type map for dilation coloring (1=deleted, 2=added, 3=modified)
    const typeMap = dilate ? new Uint8Array(width * height) : null;

    let diffPixels = 0;
    const totalPixels = width * height;
    const threshold = 30;

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
                // 削除: 緑
                if (typeMap) typeMap[px] = 1;
                resultData.data[i] = 22; resultData.data[i+1] = 163; resultData.data[i+2] = 74; resultData.data[i+3] = 200;
                diffOnlyData.data[i] = 22; diffOnlyData.data[i+1] = 163; diffOnlyData.data[i+2] = 74; diffOnlyData.data[i+3] = 255;
                oldColoredData.data[i] = 22; oldColoredData.data[i+1] = Math.round(gOld * 0.3 + 163 * 0.7); oldColoredData.data[i+2] = Math.round(bOld * 0.3); oldColoredData.data[i+3] = 255;
                newColoredData.data[i] = 220; newColoredData.data[i+1] = 255; newColoredData.data[i+2] = 220; newColoredData.data[i+3] = 255;
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
                oldColoredData.data[i] = 22; oldColoredData.data[i+1] = Math.round(gOld * 0.4 + 163 * 0.6); oldColoredData.data[i+2] = Math.round(bOld * 0.4); oldColoredData.data[i+3] = 255;
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
                    if (neighborType === 1) { r = 22; g = 163; b = 74; }
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

    // Redraw to update highlight
    applyMode();

    // Scroll viewport to center the region
    const r = state.changeRegions[index];
    const zoomRatio = state.zoom / state.scale;
    const viewW = canvasViewport.clientWidth;
    const viewH = canvasViewport.clientHeight;
    const cx = (r.x + r.w / 2) * zoomRatio + 8; // 8 = padding
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
async function renderCurrentPage() {
    loading.hidden = false;
    loadingText.textContent = `ページ ${state.currentPage} を比較中...`;

    try {
        const oldCanvas = await renderPageToCanvas(state.oldPdf, state.currentPage);
        const newCanvas = await renderPageToCanvas(state.newPdf, state.currentPage);

        state.renderedOldCanvas = oldCanvas;
        state.renderedNewCanvas = newCanvas;

        runComparison();

        // UI
        pageInfo.textContent = `${state.currentPage} / ${state.totalPages}`;
        btnPrev.disabled = state.currentPage <= 1;
        btnNext.disabled = state.currentPage >= state.totalPages;
        updateAdjustDisplay();
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
    const canvasOffsetX = Math.round(offset.x * state.scale);
    const canvasOffsetY = Math.round(offset.y * state.scale);

    const { resultData, diffOnlyData, oldColoredData, newColoredData, width, height, percent } =
        comparePages(oldCanvas, newCanvas, canvasOffsetX, canvasOffsetY);

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
        // change region overlays removed
    } else if (state.mode === "diff") {
        viewOverlay.hidden = false;
        viewSideBySide.hidden = true;
        ctx.putImageData(state.diffOnlyData, 0, 0);
        // change region overlays removed
    } else if (state.mode === "old_colored") {
        viewOverlay.hidden = false;
        viewSideBySide.hidden = true;
        ctx.putImageData(state.oldColoredData, 0, 0);
        // change region overlays removed
    } else if (state.mode === "new_colored") {
        viewOverlay.hidden = false;
        viewSideBySide.hidden = true;
        ctx.putImageData(state.newColoredData, 0, 0);
        // change region overlays removed
    } else {
        // sidebyside
        viewOverlay.hidden = true;
        viewSideBySide.hidden = false;
    }
    applyZoomToCanvases();
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
    uploadSection.hidden = false;
    document.body.classList.remove("comparing");
    state.oldPdf = null;
    state.newPdf = null;
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
        const dx = (e.clientX - state.adjustStartX) / state.zoom;
        const dy = (e.clientY - state.adjustStartY) / state.zoom;
        const newOffset = {
            x: state.adjustStartOffsetX + dx,
            y: state.adjustStartOffsetY + dy,
        };
        state.pageOffsets[state.currentPage] = newOffset;
        if (state.applyOffsetToAll) {
            for (let p = 1; p <= state.totalPages; p++) {
                state.pageOffsets[p] = { ...newOffset };
            }
        }
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
    if (state.applyOffsetToAll) {
        for (let p = 1; p <= state.totalPages; p++) {
            state.pageOffsets[p] = { x: 0, y: 0 };
        }
    }
    updateAdjustDisplay();
    runComparison();
});

chkApplyAll.addEventListener("change", () => {
    state.applyOffsetToAll = chkApplyAll.checked;
    if (state.applyOffsetToAll) {
        const offset = getPageOffset(state.currentPage);
        for (let p = 1; p <= state.totalPages; p++) {
            state.pageOffsets[p] = { ...offset };
        }
    }
});

function updateAdjustDisplay() {
    const offset = getPageOffset(state.currentPage);
    adjustOffset.textContent = `X: ${Math.round(offset.x)}　Y: ${Math.round(offset.y)}`;
}

// Lightweight preview during drag
function renderAdjustPreview() {
    if (!state.renderedOldCanvas && !state.renderedNewCanvas) return;

    const oldC = state.renderedOldCanvas;
    const newC = state.renderedNewCanvas;
    const offset = getPageOffset(state.currentPage);
    const ox = Math.round(offset.x * state.scale);
    const oy = Math.round(offset.y * state.scale);

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
    if (newC) ctx.drawImage(newC, ox, oy);
    ctx.globalAlpha = 1.0;

    viewOverlay.hidden = false;
    viewSideBySide.hidden = true;
    applyZoomToCanvases();
}

// --- Auto-Alignment ---
btnAutoAlign.addEventListener("click", () => {
    if (!state.renderedOldCanvas || !state.renderedNewCanvas) return;

    loading.hidden = false;
    loadingText.textContent = "自動位置合わせ中...";

    // Use setTimeout to allow the loading overlay to render
    setTimeout(() => {
        try {
            const offset = autoAlignPages(state.renderedOldCanvas, state.renderedNewCanvas);
            state.pageOffsets[state.currentPage] = offset;
            if (state.applyOffsetToAll) {
                for (let p = 1; p <= state.totalPages; p++) {
                    state.pageOffsets[p] = { ...offset };
                }
            }
            updateAdjustDisplay();
            runComparison();
        } catch (err) {
            alert("自動位置合わせに失敗しました: " + err.message);
        } finally {
            loading.hidden = true;
        }
    }, 50);
});

function autoAlignPages(oldCanvas, newCanvas) {
    // 二値化コンテンツマッチング: 構造図面向けに最適化
    // 白背景に黒い線の図面では、線の一致度で位置を合わせる
    const targetWidth = 500;
    const scaleDown = targetWidth / Math.max(oldCanvas.width, 1);
    const tw = Math.round(oldCanvas.width * scaleDown);
    const th = Math.round(oldCanvas.height * scaleDown);

    function downsampleBinary(canvas) {
        const c = document.createElement("canvas");
        c.width = tw; c.height = th;
        const ctx = c.getContext("2d");
        ctx.drawImage(canvas, 0, 0, tw, th);
        const data = ctx.getImageData(0, 0, tw, th).data;
        const binary = new Uint8Array(tw * th);
        for (let i = 0; i < tw * th; i++) {
            const gray = data[i*4] * 0.299 + data[i*4+1] * 0.587 + data[i*4+2] * 0.114;
            binary[i] = gray < 200 ? 1 : 0; // コンテンツ(線)=1, 背景=0
        }
        return binary;
    }

    const bOld = downsampleBinary(oldCanvas);
    const bNew = downsampleBinary(newCanvas);

    // コンテンツが少なすぎる場合は位置合わせ不要
    let contentCount = 0;
    for (let i = 0; i < bOld.length; i++) contentCount += bOld[i];
    if (contentCount < 50) return { x: 0, y: 0 };

    const searchRange = 30;
    let bestScore = -1, bestOx = 0, bestOy = 0;

    // コンテンツピクセルの一致率を最大化
    function calcMatchScore(ox, oy) {
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

    // 粗い探索 (2px刻み)
    for (let oy = -searchRange; oy <= searchRange; oy += 2) {
        for (let ox = -searchRange; ox <= searchRange; ox += 2) {
            const score = calcMatchScore(ox, oy);
            if (score > bestScore) { bestScore = score; bestOx = ox; bestOy = oy; }
        }
    }

    // 精密探索 (1px刻み)
    const coarseOx = bestOx, coarseOy = bestOy;
    for (let oy = coarseOy - 3; oy <= coarseOy + 3; oy++) {
        for (let ox = coarseOx - 3; ox <= coarseOx + 3; ox++) {
            const score = calcMatchScore(ox, oy);
            if (score > bestScore) { bestScore = score; bestOx = ox; bestOy = oy; }
        }
    }

    // ダウンサンプル座標 → CSS pixel座標に変換
    return {
        x: Math.round(bestOx / scaleDown / state.scale),
        y: Math.round(bestOy / scaleDown / state.scale),
    };
}

// --- Display Options ---
fadeSlider.addEventListener("input", () => {
    state.fadeAmount = fadeSlider.value / 100;
    runComparison();
});

chkDilate.addEventListener("change", () => {
    state.dilateChanges = chkDilate.checked;
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
        label.innerHTML = `<span class="thumb-page-num">P${p}</span><span class="thumb-change-dot pending"></span>`;
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
            const oldC = await renderPageToCanvas(state.oldPdf, p, thumbScale);
            const newC = await renderPageToCanvas(state.newPdf, p, thumbScale);

            const offset = getPageOffset(p);
            const ox = Math.round(offset.x * thumbScale);
            const oy = Math.round(offset.y * thumbScale);

            const result = comparePages(oldC, newC, ox, oy, { fade: 0.7, dilate: false });
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

            const oldCanvas = await renderPageToCanvas(state.oldPdf, p);
            const newCanvas = await renderPageToCanvas(state.newPdf, p);
            const offset = getPageOffset(p);
            const canvasOffsetX = Math.round(offset.x * state.scale);
            const canvasOffsetY = Math.round(offset.y * state.scale);

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
                const result = comparePages(oldCanvas, newCanvas, canvasOffsetX, canvasOffsetY);
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
        const step = e.shiftKey ? 10 : 1;
        const offset = getPageOffset(state.currentPage);
        let changed = false;
        let newOffset = { ...offset };

        if (e.key === "ArrowLeft") { e.preventDefault(); newOffset.x -= step; changed = true; }
        else if (e.key === "ArrowRight") { e.preventDefault(); newOffset.x += step; changed = true; }
        else if (e.key === "ArrowUp") { e.preventDefault(); newOffset.y -= step; changed = true; }
        else if (e.key === "ArrowDown") { e.preventDefault(); newOffset.y += step; changed = true; }

        if (changed) {
            state.pageOffsets[state.currentPage] = newOffset;
            if (state.applyOffsetToAll) {
                for (let p = 1; p <= state.totalPages; p++) {
                    state.pageOffsets[p] = { ...newOffset };
                }
            }
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
