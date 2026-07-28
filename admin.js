import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, onValue, set, push, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

const firebaseConfig = {
    apiKey: "AIzaSyDAq_LdMur6TizliELlrrT0NFCTC1F7K8g",
    authDomain: "causelist-98e7b.firebaseapp.com",
    databaseURL: "https://causelist-98e7b-default-rtdb.firebaseio.com/",
    projectId: "causelist-98e7b",
    storageBucket: "causelist-98e7b.firebasestorage.app",
    messagingSenderId: "610909892107",
    appId: "1:610909892107:web:119b5ccba217f1c070610e",
    measurementId: "G-540D56WGM2"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const ADMIN_PASSCODE_SHA256 = "78d9cf3fcd250f32f46f6f76bb504e1b573e8ee047eba76d3a4f8c46a377ff5d";

const uploadInput = document.getElementById("pdfUpload");
const uploadStatus = document.getElementById("uploadStatus");
const newUploadBtn = document.getElementById("newUploadBtn");
const addMoreBtn = document.getElementById("addMoreBtn");
const clearDataBtn = document.getElementById("clearDataBtn");
const announcementInput = document.getElementById("announcementInput");
const postAnnouncementBtn = document.getElementById("postAnnouncementBtn");
const newsList = document.getElementById("newsList");
const previewToggleBtn = document.getElementById("previewToggleBtn");
const previewPanel = document.getElementById("previewPanel");
const previewBody = document.getElementById("previewBody");

let currentAnnouncements = {};
let currentMatters = [];
let uploadMode = "replace"; // "replace" or "append"

// Sync current matters for appending, auto-clean expired matters, and refresh preview.
onValue(ref(db, 'publishedData/matters'), (snap) => {
    currentMatters = snap.val() || [];
    const { expired } = partitionMattersByExpiry(currentMatters);
    if (expired.length > 0) {
        console.log(`Auto-removing ${expired.length} expired matter(s) from published data.`);
        const currentOnly = currentMatters.filter((m) => !isDatePast(m.date));
        set(ref(db, 'publishedData/matters'), currentOnly);
    }
    if (previewVisible) renderPreview();
});

async function sha256(value) {
    const data = new TextEncoder().encode(value);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function enforceAdminPasscode() {
    const pass = prompt("Admin passcode required:");
    if (!pass) {
        document.body.innerHTML = "<h1 style='color:white; text-align:center; margin-top:100px;'>Unauthorized Access</h1>";
        return;
    }
    const enteredHash = await sha256(pass);
    if (enteredHash !== ADMIN_PASSCODE_SHA256) {
        alert("Unauthorized.");
        document.body.innerHTML = "<h1 style='color:white; text-align:center; margin-top:100px;'>Unauthorized Access</h1>";
    }
}

enforceAdminPasscode();

// --- DATE HELPERS ---

// Parse a date string like "TUESDAY, 28 JULY 2026" into a Date object.
function parseDateString(dateStr) {
    if (!dateStr) return null;
    const months = {
        JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5,
        JULY: 6, AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11,
    };
    const match = dateStr.match(/([A-Z]+),\s*(\d{1,2})\s+([A-Z]+)\s+(\d{4})/i);
    if (!match) return null;
    const day = parseInt(match[2], 10);
    const month = months[match[3].toUpperCase()];
    const year = parseInt(match[4], 10);
    if (month === undefined || isNaN(day) || isNaN(year)) return null;
    return new Date(year, month, day);
}

// Check whether a date string represents a date that has already passed.
function isDatePast(dateStr) {
    const date = parseDateString(dateStr);
    if (!date) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date < today;
}

// Separate matters into expired (past date) and current (today or future).
function partitionMattersByExpiry(matters) {
    const current = [];
    const expired = [];
    matters.forEach((m) => {
        if (isDatePast(m.date)) {
            expired.push(m);
        } else {
            current.push(m);
        }
    });
    return { current, expired };
}
uploadInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    uploadStatus.innerText = `Reading ${files.length} file(s)...`;
    const mergedData = [];
    const failedFiles = [];

    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        uploadStatus.innerText = `Parsing file ${index + 1}/${files.length}: ${file.name}`;
        try {
            const text = await extractTextFromFile(file);
            mergedData.push(
                ...parseCauseListText(text).map((item) => ({
                    ...item,
                    sourceFile: file.name
                }))
            );
        } catch (error) {
            console.error(`Parse failed (${file.name}):`, error);
            failedFiles.push(file.name);
        }
    }

    if (mergedData.length === 0) {
        uploadStatus.innerText = `Parsed 0/${files.length}. Failed: ${failedFiles.length}`;
        return;
    }

    // --- PAST-DATE REJECTION ---
    const pastDateFiles = mergedData.filter((m) => isDatePast(m.date));
    if (pastDateFiles.length === mergedData.length) {
        uploadStatus.innerText = `Rejected: All ${mergedData.length} matter(s) have past dates. Upload current/non-expired matters only.`;
        uploadStatus.style.color = "#ff4444";
        return;
    }

    // --- EXPIRED MATTER FILTERING ---
    const { current: validMatters, expired: removedMatters } = partitionMattersByExpiry(mergedData);
    if (removedMatters.length > 0) {
        uploadStatus.innerText = `Warning: ${removedMatters.length} expired matter(s) removed. Publishing ${validMatters.length} current matter(s).`;
        uploadStatus.style.color = "#ffaa00";
    } else {
        uploadStatus.innerText = `${uploadMode === "append" ? "Added" : "Published"} ${validMatters.length} matter(s) from ${parsedFiles}/${files.length} files.`;
        uploadStatus.style.color = "#39FF14";
    }

    if (validMatters.length === 0) {
        uploadStatus.innerText = `No current matters to publish after removing ${removedMatters.length} expired matter(s).`;
        uploadStatus.style.color = "#ff4444";
        return;
    }

    let finalData = validMatters;
    if (uploadMode === "append") {
        const { current: existingCurrent, expired: existingExpired } = partitionMattersByExpiry(currentMatters);
        if (existingExpired.length > 0) {
            console.log(`Auto-removed ${existingExpired.length} expired existing matter(s).`);
        }
        finalData = [...existingCurrent, ...validMatters];
    }

    publishMatters(finalData);

    // Reset input so the same file can be selected again if needed
    uploadInput.value = "";
});

newUploadBtn.addEventListener("click", () => {
    uploadMode = "replace";
    uploadInput.click();
});

addMoreBtn.addEventListener("click", () => {
    uploadMode = "append";
    uploadInput.click();
});

async function extractPdfText(file) {
    const buffer = await file.arrayBuffer();
    const typedData = new Uint8Array(buffer);
    let pdf = await pdfjsLib.getDocument({ data: typedData }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const lines = rebuildLinesFromTextItems(content.items);
        pages.push(lines.join("\n"));
    }
    return pages.join("\n");
}

// Lazily load Mammoth.js only when a Word file is actually uploaded, so a CDN
// issue can never break the core admin panel (PDF upload, buttons, passcode).
let mammothPromise = null;
function loadMammoth() {
    if (!mammothPromise) {
        mammothPromise = import("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/+esm")
            .then((mod) => mod.default || mod)
            .catch(() =>
                import("https://esm.sh/mammoth@1.8.0").then((mod) => mod.default || mod)
            );
    }
    return mammothPromise;
}

// Extract plain text from a Word (.docx) file entirely in the browser using
// Mammoth.js. Word paragraphs map directly to lines, which is exactly what
// parseCauseListText expects — so no Word->PDF conversion is needed.
async function extractDocxText(file) {
    const mammoth = await loadMammoth();
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    // Normalize: split into lines, collapse internal whitespace, drop blanks.
    return result.value
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
}

// Detect the file type and route to the correct text extractor so the same
// parser can handle both PDF and Word uploads.
function isDocxFile(file) {
    const name = (file.name || "").toLowerCase();
    return (
        name.endsWith(".docx") ||
        file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
}

function isDocFile(file) {
    return (file.name || "").toLowerCase().endsWith(".doc") && !isDocxFile(file);
}

async function extractTextFromFile(file) {
    if (isDocxFile(file)) return extractDocxText(file);
    if (isDocFile(file)) {
        // Legacy binary .doc cannot be parsed reliably in the browser.
        throw new Error("Legacy .doc format is not supported. Please save as .docx or PDF.");
    }
    return extractPdfText(file);
}

function rebuildLinesFromTextItems(items) {
    const byY = new Map();
    items.forEach((item) => {
        const y = Math.round(item.transform[5] * 10) / 10;
        const x = item.transform[4];
        if (!byY.has(y)) byY.set(y, []);
        byY.get(y).push({ x, str: item.str });
    });
    return [...byY.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, row]) => row.sort((a, b) => a.x - b.x).map((r) => r.str).join(" ").replace(/\s+/g, " ").trim())
        .filter(Boolean);
}

// Map descriptive tribunal phrases to canonical abbreviations.
const TRIBUNAL_NAME_MAP = {
    "RENT RESTRICTION": "RRT",
    "BUSINESS PREMISES": "BPRT",
    "TAX APPEAL": "TAT",
    "ENERGY AND PETROLEUM": "EPT",
};

// Known tribunal abbreviations that may legitimately appear on a header line.
const KNOWN_TRIBUNAL_TOKENS = new Set(["TAT", "RRT", "BPRT", "EPT"]);

// Map a case-number prefix to a tribunal name. This is the most reliable
// per-matter signal, so it is preferred when available.
// e.g. NAIROBI_RRC/783/2019 -> RRT, EPA/E051/2025 -> EPT
const CASE_PREFIX_MAP = {
    RRC: "RRT",
    RRT: "RRT",
    BPR: "BPRT",
    BPRT: "BPRT",
    BPRC: "BPRT",
    TAT: "TAT",
    TATC: "TAT",
    EPA: "EPT",
    EPT: "EPT",
};

function tribunalFromCaseNo(caseNo) {
    if (!caseNo) return "";
    const cleaned = caseNo.toUpperCase();
    // Extract everything before the first slash that is followed by a digit
    // (this is the start of the case number portion).
    // e.g. "NAIROBI_RRC/783/2019" → prefix "NAIROBI_RRC"
    //      "EPA/E051/2025"       → prefix "EPA"
    const slashMatch = cleaned.match(/^(.+?)(?=\/\d)/);
    const prefix = slashMatch ? slashMatch[1] : "";
    // Try the full prefix directly.
    if (CASE_PREFIX_MAP[prefix]) return CASE_PREFIX_MAP[prefix];
    // Try splitting by underscores and slashes to find a known code segment.
    const segments = prefix.split(/[_/]/);
    for (const seg of segments) {
        if (CASE_PREFIX_MAP[seg]) return CASE_PREFIX_MAP[seg];
    }
    return "";
}

// Normalize a header token into a short tribunal name.
// Accepts any line ending with "TRIBUNAL" that has meaningful content before it.
// Rejects dates, officer lines, "CAUSE LIST", bare "TRIBUNAL", and "HIGH COURT" headers.
function normalizeTribunalName(raw) {
    if (!raw) return "";
    const upper = raw.toUpperCase().trim();

    // Reject obvious non-names first.
    if (upper === "TRIBUNAL" || upper === "CAUSE LIST") return "";
    if (upper.includes("HIGH COURT")) return "";
    if (upper.includes("HON.") || /^(MR|MRS|MS|DR)\.\s/.test(upper)) return "";
    if (/\d{4}/.test(upper)) return "";
    if (/^[A-Z]+,\s+\d/.test(upper)) return "";

    // Check if the line ends with "TRIBUNAL" — if so, it IS a tribunal header.
    const hasTribunalSuffix = /\s+TRIBUNAL\s*$/i.test(raw);
    const withoutTribunal = raw.replace(/\s+TRIBUNAL\s*$/i, "").trim();

    if (hasTribunalSuffix && withoutTribunal) {
        // Map known descriptive phrases to canonical abbreviations.
        for (const [phrase, abbr] of Object.entries(TRIBUNAL_NAME_MAP)) {
            if (withoutTribunal.toUpperCase().includes(phrase)) return abbr;
        }
        // Known short token (e.g. "TAT", "RRT").
        const upperTrimmed = withoutTribunal.toUpperCase();
        if (KNOWN_TRIBUNAL_TOKENS.has(upperTrimmed)) return upperTrimmed;
        // Accept the text as-is (it's a real tribunal name).
        return withoutTribunal;
    }

    return "";
}

// Clean an assembled officer string: strip a trailing court-room marker
// (e.g. "... HON. JIMMY MALLA COURTROOM 1" -> "... HON. JIMMY MALLA")
// and tidy stray separators/whitespace.
function cleanOfficer(raw) {
    return raw
        .replace(/\s+COURT\s*ROOM\s*\d+.*$/i, "")
        .replace(/\s+COURTROOM\s*\d+.*$/i, "")
        .replace(/\s+/g, " ")
        .replace(/[,;]\s*$/, "")
        .trim();
}

function parseCauseListText(fullText) {
    const lines = fullText.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    let currentDate = "", currentTribunal = "", currentOfficer = "", currentTime = "", currentMatterType = "";
    const allData = [];
    const strictCasePattern = /\b([A-Z0-9_/-]+\/[A-Z]?\d+\/\d{4})\b/i;
    const fallbackCasePattern = /^([A-Z0-9_/-]{4,})\s+/i;
    const numberedLinePattern = /^\d+\./;

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const upperLine = line.toUpperCase();
        // --- Tribunal detection (option A: from header text) ---
        // Explicit "Tribunal: X" label.
        if (line.match(/^Tribunal:\s*(.+)$/i)) {
            const name = normalizeTribunalName(line.match(/^Tribunal:\s*(.+)$/i)[1]);
            if (name) currentTribunal = name;
            i++; continue;
        }
        // "MILIMANI HIGH COURT" is ignored; the tribunal name is the next real line
        // (e.g. "TAT"), skipping the generic word "TRIBUNAL" and "CAUSE LIST".
        if (upperLine.includes("HIGH COURT")) {
            // Try same-line suffix first (e.g. "MILIMANI HIGH COURT - RENT RESTRICTION TRIBUNAL").
            const inline = line.match(/HIGH COURT\s*[-–]\s*(.+)/i);
            let name = inline ? normalizeTribunalName(inline[1]) : "";
            // Otherwise look at the following lines for the first real name.
            let k = i + 1;
            while (!name && k < lines.length && k <= i + 3) {
                const candidate = normalizeTribunalName(lines[k]);
                if (candidate) { name = candidate; break; }
                // Stop scanning once we hit content that clearly isn't a header token.
                if (/^\d+\./.test(lines[k]) || /^[A-Z]+,\s+\d/.test(lines[k])) break;
                k++;
            }
            if (name) currentTribunal = name;
            i++; continue;
        }

        // Match date patterns anywhere in the line (handles trailing page numbers,
        // watermarks, etc.). Supports ordinal suffixes and case-insensitive day names.
        const dateMatch = line.match(/([A-Z]+),\s*(\d{1,2}(?:st|nd|rd|th)?)\s+([A-Z]+)\s+(\d{4})/i);
        if (dateMatch) { currentDate = dateMatch[1].toUpperCase() + ", " + dateMatch[2].replace(/(st|nd|rd|th)$/i, "") + " " + dateMatch[3].toUpperCase() + " " + dateMatch[4]; i++; continue; }
        if (line.match(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)) { currentTime = line.toUpperCase(); i++; continue; }
        if (line.match(/^(HEARING|MENTION|RULING|JUDGMENT|JUDGEMENT)$/i)) { currentMatterType = line.toUpperCase(); i++; continue; }
        if (line.includes("HON.") || line.match(/^(MR|MRS|MS|DR)\.\s/i)) {
            // Officer lists may wrap across several lines, e.g.:
            //   "HON. A, HON. B, HON. GLORIA"
            //   "AWUOR OGAGA, HON. JIMMY MALLA COURTROOM 1"
            // Collect the current line plus continuation lines until we hit a
            // date/time/matter-type/case-number/tribunal boundary.
            const officerParts = [line];
            let k = i + 1;
            while (k < lines.length) {
                const next = lines[k];
                if (
                    numberedLinePattern.test(next) ||
                    /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(next) ||
                    /^(HEARING|MENTION|RULING|JUDGMENT|JUDGEMENT)$/i.test(next) ||
                    /^[A-Z]+,\s+\d{1,2}\s+[A-Z]+\s+\d{4}$/.test(next) ||
                    /^Tribunal:/i.test(next) ||
                    next.toUpperCase().includes("HIGH COURT")
                ) break;
                officerParts.push(next);
                // Stop after absorbing a line that ends with the court-room marker.
                if (/COURT\s*ROOM\s*\d+/i.test(next) || /COURTROOM\s*\d+/i.test(next)) { k++; break; }
                k++;
            }
            const cleaned = cleanOfficer(officerParts.join(" "));
            if (cleaned) currentOfficer = cleaned;
            i = k; continue;
        }
        if (!numberedLinePattern.test(line)) { i++; continue; }

        const matterLines = [line];
        let j = i + 1;
        const stopContinuation = (l) =>
            /^(HEARING|MENTION|RULING|JUDGMENT|JUDGEMENT|Tribunal:)/i.test(l) ||
            l.includes("HON.") ||
            /^(MR|MRS|MS|DR)\.\s/i.test(l) ||
            /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(l) ||
            l.toUpperCase().includes("HIGH COURT");
        while (j < lines.length && !numberedLinePattern.test(lines[j]) && !stopContinuation(lines[j])) {
            matterLines.push(lines[j]); j++;
        }
        const fullMatterLine = matterLines.join(" ").replace(/^\d+\.\s+/, "").trim();
        const caseNoMatch = fullMatterLine.match(strictCasePattern) || fullMatterLine.match(fallbackCasePattern);
        const caseNo = caseNoMatch ? caseNoMatch[1] : "N/A";
        // Tribunal resolution priority:
        //  1) case-number prefix (most reliable per-matter signal; e.g. TATC -> TAT)
        //  2) tribunal name detected from a valid header line
        //  3) hard default
        // Preferring the case number prevents a repeated/incomplete header from
        // mislabelling matters that clearly belong to a specific tribunal.
        const tribunal = tribunalFromCaseNo(caseNo) || currentTribunal || "BPRT";
        allData.push({
            date: currentDate, tribunal, officer: currentOfficer || "HON. -",
            matterType: currentMatterType || "UNSPECIFIED", caseNo, caseLine: fullMatterLine,
            proceedings: fullMatterLine.replace(caseNo, "").trim() || "-", time: currentTime || "-"
        });
        i = j;
    }
    return allData;
}

function publishMatters(matters) {
    set(ref(db, 'publishedData'), { publishedAt: serverTimestamp(), matters }).catch(err => {
        alert("Publish failed. Check permissions.");
    });
}

clearDataBtn.addEventListener("click", () => {
    if (confirm("Clear all published matters?")) {
        set(ref(db, 'publishedData'), null).then(() => alert("Cleared."));
    }
});

// --- NEWS MANAGEMENT ---
function renderAdminNewsList() {
    const keys = Object.keys(currentAnnouncements);
    newsList.innerHTML = keys.length ? "" : "<p class='news-list-empty'>No active news.</p>";
    keys.forEach(key => {
        const li = document.createElement("li");
        li.className = "news-item-row";
        li.innerHTML = `<span class="news-item-text">${currentAnnouncements[key]}</span>
                        <button class="delete-news-btn" data-key="${key}">Delete</button>`;
        li.querySelector(".delete-news-btn").onclick = () => set(ref(db, `announcements/${key}`), null);
        newsList.appendChild(li);
    });
}

onValue(ref(db, 'announcements'), (snap) => {
    currentAnnouncements = snap.val() || {};
    renderAdminNewsList();
});

postAnnouncementBtn.addEventListener("click", () => {
    const text = announcementInput.value.trim();
    if (text) push(ref(db, 'announcements'), text).then(() => announcementInput.value = "");
});

// --- DASHBOARD PREVIEW ---
let previewVisible = false;

function renderPreview() {
    if (!previewBody) return;
    if (currentMatters.length === 0) {
        previewBody.innerHTML = "<p style='color:#9fb8a5;'>No matters published yet.</p>";
        return;
    }
    const { current, expired } = partitionMattersByExpiry(currentMatters);
    let html = `<p style="color:#9fb8a5; font-size:0.8rem; margin-bottom:8px;">Showing ${current.length} current matter(s)${expired.length > 0 ? ` (${expired.length} expired hidden)` : ""}.</p>`;
    html += `<table style="width:100%; border-collapse:collapse; font-size:0.8rem;">`;
    html += `<thead><tr style="border-bottom:2px solid #cfa92d;">
        <th style="padding:4px 6px; text-align:left; color:#cfa92d;">Date</th>
        <th style="padding:4px 6px; text-align:left; color:#cfa92d;">Tribunal</th>
        <th style="padding:4px 6px; text-align:left; color:#cfa92d;">Officer</th>
        <th style="padding:4px 6px; text-align:left; color:#cfa92d;">Type</th>
        <th style="padding:4px 6px; text-align:left; color:#cfa92d;">Case No.</th>
        <th style="padding:4px 6px; text-align:left; color:#cfa92d;">Time</th>
    </tr></thead><tbody>`;
    current.slice(0, 50).forEach((m) => {
        html += `<tr style="border-bottom:1px solid rgba(207,169,45,0.15);">
            <td style="padding:3px 6px; color:#fff;">${m.date || "-"}</td>
            <td style="padding:3px 6px; color:#cfa92d;">${m.tribunal || "-"}</td>
            <td style="padding:3px 6px; color:#fff;">${m.officer || "-"}</td>
            <td style="padding:3px 6px; color:#fff;">${m.matterType || "-"}</td>
            <td style="padding:3px 6px; color:#fff;">${m.caseNo || "-"}</td>
            <td style="padding:3px 6px; color:#fff;">${m.time || "-"}</td>
        </tr>`;
    });
    if (current.length > 50) {
        html += `<tr><td colspan="6" style="padding:4px 6px; color:#9fb8a5; text-align:center;">... and ${current.length - 50} more</td></tr>`;
    }
    html += `</tbody></table>`;
    previewBody.innerHTML = html;
}

if (previewToggleBtn) {
    previewToggleBtn.addEventListener("click", () => {
        previewVisible = !previewVisible;
        if (previewPanel) {
            previewPanel.style.display = previewVisible ? "block" : "none";
        }
        if (previewVisible) {
            renderPreview();
        }
    });
}


