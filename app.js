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
    mode: "overlay", // overlay | sidebyside | diff | old_colored | new_colored
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
const diffPercent = $("diff-percent");
const loading = $("loading");
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

    try {
        const oldData = await readFile(state.oldFile);
        const newData = await readFile(state.newFile);

        state.oldPdf = await pdfjsLib.getDocument({ data: oldData }).promise;
        state.newPdf = await pdfjsLib.getDocument({ data: newData }).promise;

        state.totalPages = Math.max(state.oldPdf.numPages, state.newPdf.numPages);
        state.currentPage = 1;

        uploadSection.hidden = true;
        resultSection.hidden = false;

        await renderCurrentPage();
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
async function renderPageToCanvas(pdf, pageNum) {
    if (pageNum > pdf.numPages) return null;

    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: state.scale });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
}

// --- Pixel Comparison (with offset support) ---
function comparePages(oldCanvas, newCanvas, offsetX = 0, offsetY = 0) {
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

    // New canvas data (offset applied via drawImage position)
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

    let diffPixels = 0;
    const totalPixels = width * height;
    const threshold = 30;

    for (let i = 0; i < oldData.data.length; i += 4) {
        const rOld = oldData.data[i];
        const gOld = oldData.data[i + 1];
        const bOld = oldData.data[i + 2];

        const rNew = newData.data[i];
        const gNew = newData.data[i + 1];
        const bNew = newData.data[i + 2];

        const diff = Math.abs(rOld - rNew) + Math.abs(gOld - gNew) + Math.abs(bOld - bNew);

        if (diff > threshold) {
            diffPixels++;

            const oldIsContent = (rOld + gOld + bOld) < 700;
            const newIsContent = (rNew + gNew + bNew) < 700;

            if (oldIsContent && !newIsContent) {
                // 削除: 赤
                resultData.data[i] = 239;
                resultData.data[i + 1] = 68;
                resultData.data[i + 2] = 68;
                resultData.data[i + 3] = 200;

                diffOnlyData.data[i] = 239;
                diffOnlyData.data[i + 1] = 68;
                diffOnlyData.data[i + 2] = 68;
                diffOnlyData.data[i + 3] = 255;

                // 旧図面: 削除部分を赤く強調
                oldColoredData.data[i] = 239;
                oldColoredData.data[i + 1] = Math.round(gOld * 0.3);
                oldColoredData.data[i + 2] = Math.round(bOld * 0.3);
                oldColoredData.data[i + 3] = 255;

                // 新図面: 削除された部分を薄赤マーカー
                newColoredData.data[i] = 255;
                newColoredData.data[i + 1] = 220;
                newColoredData.data[i + 2] = 220;
                newColoredData.data[i + 3] = 255;
            } else if (!oldIsContent && newIsContent) {
                // 追加: 青
                resultData.data[i] = 59;
                resultData.data[i + 1] = 130;
                resultData.data[i + 2] = 246;
                resultData.data[i + 3] = 200;

                diffOnlyData.data[i] = 59;
                diffOnlyData.data[i + 1] = 130;
                diffOnlyData.data[i + 2] = 246;
                diffOnlyData.data[i + 3] = 255;

                // 旧図面: 追加された部分を薄青マーカー
                oldColoredData.data[i] = 220;
                oldColoredData.data[i + 1] = 230;
                oldColoredData.data[i + 2] = 255;
                oldColoredData.data[i + 3] = 255;

                // 新図面: 追加部分を青く強調
                newColoredData.data[i] = Math.round(rNew * 0.3);
                newColoredData.data[i + 1] = Math.round(gNew * 0.3);
                newColoredData.data[i + 2] = 246;
                newColoredData.data[i + 3] = 255;
            } else {
                // 変更: 紫
                resultData.data[i] = 180;
                resultData.data[i + 1] = 80;
                resultData.data[i + 2] = 200;
                resultData.data[i + 3] = 200;

                diffOnlyData.data[i] = 180;
                diffOnlyData.data[i + 1] = 80;
                diffOnlyData.data[i + 2] = 200;
                diffOnlyData.data[i + 3] = 255;

                // 旧図面: 赤系で強調
                oldColoredData.data[i] = 239;
                oldColoredData.data[i + 1] = Math.round(gOld * 0.4);
                oldColoredData.data[i + 2] = Math.round(bOld * 0.4);
                oldColoredData.data[i + 3] = 255;

                // 新図面: 青系で強調
                newColoredData.data[i] = Math.round(rNew * 0.4);
                newColoredData.data[i + 1] = Math.round(gNew * 0.4);
                newColoredData.data[i + 2] = 246;
                newColoredData.data[i + 3] = 255;
            }
        } else {
            // 変更なし
            const gray = Math.round((rNew + gNew + bNew) / 3);
            const blended = Math.round(gray * 0.3 + 255 * 0.7);
            resultData.data[i] = blended;
            resultData.data[i + 1] = blended;
            resultData.data[i + 2] = blended;
            resultData.data[i + 3] = 255;

            diffOnlyData.data[i] = 255;
            diffOnlyData.data[i + 1] = 255;
            diffOnlyData.data[i + 2] = 255;
            diffOnlyData.data[i + 3] = 255;

            // 旧図面: そのまま表示
            oldColoredData.data[i] = rOld;
            oldColoredData.data[i + 1] = gOld;
            oldColoredData.data[i + 2] = bOld;
            oldColoredData.data[i + 3] = 255;

            // 新図面: そのまま表示
            newColoredData.data[i] = rNew;
            newColoredData.data[i + 1] = gNew;
            newColoredData.data[i + 2] = bNew;
            newColoredData.data[i + 3] = 255;
        }
    }

    const percent = ((diffPixels / totalPixels) * 100).toFixed(2);

    return { resultData, diffOnlyData, oldColoredData, newColoredData, width, height, percent };
}

// --- Render Current Page ---
async function renderCurrentPage() {
    loading.hidden = false;

    try {
        const oldCanvas = await renderPageToCanvas(state.oldPdf, state.currentPage);
        const newCanvas = await renderPageToCanvas(state.newPdf, state.currentPage);

        // Store for re-comparison (position adjustment)
        state.renderedOldCanvas = oldCanvas;
        state.renderedNewCanvas = newCanvas;

        runComparison();

        // UI更新
        pageInfo.textContent = `${state.currentPage} / ${state.totalPages}`;
        btnPrev.disabled = state.currentPage <= 1;
        btnNext.disabled = state.currentPage >= state.totalPages;
        updateAdjustDisplay();
    } catch (err) {
        alert("ページの比較中にエラーが発生しました: " + err.message);
    } finally {
        loading.hidden = true;
    }
}

// --- Run comparison with current offset (no PDF re-render needed) ---
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

    // サイドバイサイド用
    const drawPlaceholder = (c, w, h) => {
        c.width = w;
        c.height = h;
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

    applyMode();
    diffPercent.textContent = `差分: ${percent}% のピクセルが変更されています`;
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
    state.oldPdf = null;
    state.newPdf = null;
    exitAdjustMode();
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

// マウスホイールでズーム（Ctrl+ホイール）
canvasViewport.addEventListener(
    "wheel",
    (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        setZoom(state.zoom + delta);
    },
    { passive: false }
);

// --- Pan / Adjust Drag ---
canvasViewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;

    if (state.adjustMode) {
        // 位置調整モード: ドラッグで新図面の位置を調整
        state.isAdjusting = true;
        state.adjustStartX = e.clientX;
        state.adjustStartY = e.clientY;
        const offset = getPageOffset(state.currentPage);
        state.adjustStartOffsetX = offset.x;
        state.adjustStartOffsetY = offset.y;
        canvasViewport.classList.add("grabbing");
        e.preventDefault();
    } else {
        // パンモード
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
        state.pageOffsets[state.currentPage] = {
            x: state.adjustStartOffsetX + dx,
            y: state.adjustStartOffsetY + dy,
        };
        updateAdjustDisplay();
        // ドラッグ中は軽量プレビュー
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
        // ドラッグ終了: フル比較実行
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
    if (state.adjustMode) {
        exitAdjustMode();
    } else {
        enterAdjustMode();
    }
});

btnAdjustReset.addEventListener("click", () => {
    state.pageOffsets[state.currentPage] = { x: 0, y: 0 };
    updateAdjustDisplay();
    runComparison();
});

function updateAdjustDisplay() {
    const offset = getPageOffset(state.currentPage);
    adjustOffset.textContent = `X: ${Math.round(offset.x)}　Y: ${Math.round(offset.y)}`;
}

// ドラッグ中の軽量プレビュー（半透明重ね合わせ）
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

    // 白背景
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);

    // 旧図面を半透明で描画
    ctx.globalAlpha = 0.5;
    if (oldC) ctx.drawImage(oldC, 0, 0);

    // 新図面をオフセット付きで半透明描画
    ctx.globalAlpha = 0.5;
    if (newC) ctx.drawImage(newC, ox, oy);

    ctx.globalAlpha = 1.0;

    // overlay表示に切替
    viewOverlay.hidden = false;
    viewSideBySide.hidden = true;
    applyZoomToCanvases();
}

// --- PDF Export ---
btnExportPdf.addEventListener("click", async () => {
    loading.hidden = false;

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
            if (p > 1) {
                pdf.addPage(
                    [pageWidth, pageHeight],
                    pageWidth > pageHeight ? "landscape" : "portrait"
                );
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
                if (newCanvas)
                    ctx.drawImage(newCanvas, (oldCanvas?.width || 0) + 20, 0);
            } else {
                const result = comparePages(
                    oldCanvas,
                    newCanvas,
                    canvasOffsetX,
                    canvasOffsetY
                );
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
    if (resultSection.hidden) return;

    // 位置調整モードの矢印キー操作
    if (state.adjustMode) {
        const step = e.shiftKey ? 10 : 1;
        const offset = getPageOffset(state.currentPage);
        let changed = false;

        if (e.key === "ArrowLeft") {
            e.preventDefault();
            state.pageOffsets[state.currentPage] = {
                x: offset.x - step,
                y: offset.y,
            };
            changed = true;
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            state.pageOffsets[state.currentPage] = {
                x: offset.x + step,
                y: offset.y,
            };
            changed = true;
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            state.pageOffsets[state.currentPage] = {
                x: offset.x,
                y: offset.y - step,
            };
            changed = true;
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            state.pageOffsets[state.currentPage] = {
                x: offset.x,
                y: offset.y + step,
            };
            changed = true;
        }

        if (changed) {
            updateAdjustDisplay();
            runComparison();
            return;
        }
    }

    // 通常のキーボード操作
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
    }
});
