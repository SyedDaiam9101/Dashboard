/* ====== INDEXEDDB CONFIGURATION (LOCAL VAULT) ====== */
const DB_NAME = 'PyramidDashboardDB';
const DB_VERSION = 1;
const STORAGE_LIMIT_MB = 1000; // ~1GB Limit

let db = null;
// Queue for matching incoming snapshot headers to binary frames
let pendingSnapshots = [];

/* ====== DYNAMIC IP CONFIGURATION ====== */
function normalizeIP(url) {
    if (!url) return "";
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

let MAIN_IP_RAW = localStorage.getItem('pyramid_main_ip') || "192.168.4.1";
let MAIN_IP = `http://${normalizeIP(MAIN_IP_RAW)}`;

let CAM_IPS_RAW = JSON.parse(localStorage.getItem('pyramid_cam_ips')) || {
    1: "192.168.4.2:80",
    2: "192.168.4.3:80",
    3: "192.168.4.4:80",
    4: "192.168.4.5:80"
};

let ws = null;

let CAM_IPS = {};
Object.keys(CAM_IPS_RAW).forEach(id => {
    CAM_IPS[id] = `http://${normalizeIP(CAM_IPS_RAW[id])}`;
});

function updateIPs(mainIP, camIPs) {
    MAIN_IP_RAW = normalizeIP(mainIP);
    MAIN_IP = `http://${MAIN_IP_RAW}`;
    CAM_IPS_RAW = {};
    CAM_IPS = {};
    Object.keys(camIPs).forEach(id => {
        const raw = normalizeIP(camIPs[id]);
        CAM_IPS_RAW[id] = raw;
        CAM_IPS[id] = `http://${raw}`;
    });
    localStorage.setItem('pyramid_main_ip', MAIN_IP_RAW);
    localStorage.setItem('pyramid_cam_ips', JSON.stringify(CAM_IPS_RAW));
}
/* ==================================== */

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('snapshots')) {
                const store = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('camId', 'camId', { unique: false });
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('IndexedDB: Persistent Storage System Active (1GB Cap)');
            resolve(db);
        };

        request.onerror = (event) => {
            console.error('IndexedDB Error:', event.target.error);
            reject(event.target.error);
        };
    });
}

async function checkStorageLimit() {
    if (!db) return;
    const quota = await navigator.storage.estimate();
    const usageMB = (quota.usage / (1024 * 1024)).toFixed(2);

    if (usageMB > STORAGE_LIMIT_MB) {
        console.warn(`Storage limit reached (${usageMB}MB / ${STORAGE_LIMIT_MB}MB). Pruning old records...`);
        await pruneSnapshots();
    }
}

async function pruneSnapshots() {
    return new Promise((resolve) => {
        const transaction = db.transaction(['snapshots'], 'readwrite');
        const store = transaction.objectStore('snapshots');
        const index = store.index('timestamp');

        // Delete the oldest 10 snapshots
        const request = index.openCursor();
        let deletedCount = 0;
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor && deletedCount < 10) {
                store.delete(cursor.primaryKey);
                deletedCount++;
                cursor.continue();
            } else {
                resolve();
            }
        };
    });
}

async function saveSnapshotToLocal(camId, blob) {
    await checkStorageLimit();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['snapshots'], 'readwrite');
        const store = transaction.objectStore('snapshots');

        const entry = {
            camId: camId,
            timestamp: Date.now(),
            image: blob
        };

        const request = store.add(entry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function getLocalSnapshots() {
    return new Promise((resolve) => {
        if (!db) return resolve([]);
        const transaction = db.transaction(['snapshots'], 'readonly');
        const store = transaction.objectStore('snapshots');
        const index = store.index('timestamp');
        const request = index.getAll(); // Simplified, in production use cursors for performance

        request.onsuccess = () => {
            // Sort by latest first
            const results = request.result.sort((a, b) => b.timestamp - a.timestamp);
            resolve(results);
        };
    });
}
/* ==================================== */

/* ====== SETUP FUNCTIONS ====== */
let currentMode = null;
let selectedWifi = null;

// Check if setup is needed
async function checkSetup() {
    const setupModal = document.getElementById('setupModal');
    const notConnectedWarning = document.getElementById('notConnectedWarning');
    const setupContent = document.querySelector('.mode-selector');
    const apConnectionInfo = document.getElementById('apConnectionInfo');
    const setupSubtitle = document.getElementById('setupSubtitle');

    // Always show mode selector
    if (setupContent) setupContent.style.display = 'grid';
    if (notConnectedWarning) notConnectedWarning.style.display = 'none';

    try {
        const res = await safeFetch(MAIN_IP + "/wifi/status", {}, 3000);
        if (!res || !res.ok) {
            // Can't connect - show setup with mode selector
            showSetup();
            if (apConnectionInfo) apConnectionInfo.style.display = 'block';
            if (setupSubtitle) setupSubtitle.textContent = 'Connect to ESP32 WiFi network (PyramidNet) first, then configure';
            return;
        }
        const data = await res.json().catch(() => null);
        if (data && data.mode) {
            if (data.mode === 'ap') {
                // In AP mode - show setup with connection info
                showSetup();
                if (apConnectionInfo) apConnectionInfo.style.display = 'block';
                if (setupSubtitle) setupSubtitle.textContent = 'ESP32 is in Access Point mode - Configure below';
            } else {
                // In Station mode and connected - hide setup
                hideSetup();
            }
        } else {
            // No mode set - show setup
            showSetup();
            if (apConnectionInfo) apConnectionInfo.style.display = 'block';
            if (setupSubtitle) setupSubtitle.textContent = 'Configure your ESP32 WiFi settings';
        }
    } catch (e) {
        // Can't connect - show setup with mode selector
        showSetup();
        if (apConnectionInfo) apConnectionInfo.style.display = 'block';
        if (setupSubtitle) setupSubtitle.textContent = 'Connect to ESP32 WiFi network (PyramidNet) first, then configure';
    }
}

function showSetup() {
    const modal = document.getElementById('setupModal');
    if (modal) {
        modal.classList.remove('hidden');
        setTimeout(() => {
            modal.classList.add('active');
        }, 10);
    }
}

function hideSetup() {
    const modal = document.getElementById('setupModal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            modal.classList.add('hidden');
        }, 400);
    }
}

function skipSetup() {
    hideSetup();
    localStorage.setItem('pyramid_setup_skipped', 'true');
}

// Mode selection
document.addEventListener('DOMContentLoaded', () => {
    const modeCards = document.querySelectorAll('.mode-card');
    modeCards.forEach(card => {
        card.addEventListener('click', () => {
            modeCards.forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            currentMode = card.dataset.mode;

            // Show appropriate form
            document.getElementById('apForm').classList.toggle('active', currentMode === 'ap');
            document.getElementById('stationForm').classList.toggle('active', currentMode === 'station');
        });
    });
});

function togglePassword(inputId) {
    const input = document.getElementById(inputId);
    const btn = input.nextElementSibling;
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
    } else {
        input.type = 'password';
        btn.textContent = '👁️';
    }
}

// Scan for WiFi networks
async function scanNetworks() {
    const statusEl = document.getElementById('setupStatus');
    const wifiList = document.getElementById('wifiList');

    statusEl.className = 'setup-status loading';
    statusEl.textContent = 'Scanning for WiFi networks...';
    statusEl.style.display = 'block';
    wifiList.style.display = 'none';
    wifiList.innerHTML = '';

    try {
        const res = await safeFetch(MAIN_IP + "/wifi/scan", { method: 'POST' }, 10000);
        if (!res || !res.ok) {
            throw new Error('Scan failed');
        }

        const networks = await res.json().catch(() => []);

        if (networks.length === 0) {
            statusEl.className = 'setup-status error';
            statusEl.textContent = 'No networks found. Make sure your phone hotspot is on.';
            return;
        }

        statusEl.style.display = 'none';
        wifiList.style.display = 'block';

        networks.forEach(network => {
            const item = document.createElement('div');
            item.className = 'wifi-item';
            item.innerHTML = `
        <div>
          <div class="wifi-name">${sanitizeInput(network.ssid)}</div>
          <div class="wifi-signal">Signal: ${network.rssi} dBm ${network.encrypted ? '🔒' : '🔓'}</div>
        </div>
      `;
            item.addEventListener('click', () => {
                document.querySelectorAll('.wifi-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                selectedWifi = network.ssid;
                document.getElementById('stationSSID').value = network.ssid;
            });
            wifiList.appendChild(item);
        });
    } catch (e) {
        statusEl.className = 'setup-status error';
        statusEl.textContent = 'Failed to scan networks. Make sure ESP32 is in AP mode or connected.';
    }
}

// Save setup
async function saveSetup() {
    const statusEl = document.getElementById('setupStatus');
    statusEl.className = 'setup-status loading';
    statusEl.textContent = 'Configuring ESP32...';
    statusEl.style.display = 'block';

    try {
        let config = {};

        if (currentMode === 'ap') {
            const ssid = document.getElementById('apSSID').value.trim();
            const password = document.getElementById('apPassword').value;
            const ip = document.getElementById('apIP').value.trim();

            if (!ssid || !password || password.length < 8) {
                throw new Error('AP SSID and password (min 8 chars) required');
            }

            config = {
                mode: 'ap',
                ssid: ssid,
                password: password,
                ip: ip
            };
        } else if (currentMode === 'station') {
            const ssid = document.getElementById('stationSSID').value.trim();
            const password = document.getElementById('stationPassword').value;

            if (!ssid) {
                throw new Error('WiFi SSID required');
            }

            config = {
                mode: 'station',
                ssid: ssid,
                password: password
            };
        } else {
            throw new Error('Please select a mode');
        }

        // Send configuration to ESP32
        const res = await safeFetch(MAIN_IP + "/wifi/config", {
            method: 'POST',
            body: JSON.stringify(config),
            headers: { 'Content-Type': 'application/json' }
        }, 15000);

        if (!res || !res.ok) {
            throw new Error('Configuration failed');
        }

        const result = await res.json().catch(() => ({}));

        statusEl.className = 'setup-status success';
        statusEl.textContent = 'Configuration saved! ESP32 is restarting...';

        // Update IPs if provided
        if (result.ip) {
            const parts = result.ip.split('.');
            const base = parts.slice(0, 3).join('.');
            const last = parseInt(parts[3]);
            updateIPs(`http://${result.ip}`, {
                1: `${base}.${last + 1}:80`,
                2: `${base}.${last + 2}:80`,
                3: `${base}.${last + 3}:80`,
                4: `${base}.${last + 4}:80`
            });
        }

        // Wait and reload
        setTimeout(() => {
            location.reload();
        }, 3000);

    } catch (e) {
        statusEl.className = 'setup-status error';
        statusEl.textContent = 'Error: ' + e.message;
    }
}

// Check setup on load
setTimeout(checkSetup, 1000);
/* ==================================== */

/* ====== SECURITY CONFIGURATION ====== */
// Authentication token (set this in localStorage or get from login)
let AUTH_TOKEN = localStorage.getItem('pyramid_auth_token') || null;
const MAX_RETRIES = 3;
const RATE_LIMIT_DELAY = 1000; // 1 second between requests
let lastRequestTime = 0;
let requestCount = 0;
const MAX_REQUESTS_PER_MINUTE = 60;

// Input validation
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/[<>\"']/g, '').trim().substring(0, 100);
}

function validateIP(ip) {
    // Matches IP with optional port
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/;
    return ipPattern.test(normalizeIP(ip));
}

function validateCameraID(cam) {
    return Number.isInteger(cam) && cam >= 1 && cam <= 4;
}
/* ==================================== */

let lastAlerts = [];

// Rate limiting
async function checkRateLimit() {
    const now = Date.now();
    if (now - lastRequestTime > 60000) {
        requestCount = 0;
        lastRequestTime = now;
    }
    if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
        throw new Error('Rate limit exceeded. Please wait.');
    }
    requestCount++;

    // Enforce minimum delay between requests
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
    }
    lastRequestTime = Date.now();
}

// Secure fetch with authentication, rate limiting, and timeout
async function safeFetch(url, opts = {}, timeout = 3000) {
    try {
        // Validate URL
        if (!validateIP(url.replace(/https?:\/\//, '').split('/')[0])) {
            console.error('Invalid URL format');
            return null;
        }

        // Rate limiting
        await checkRateLimit();

        // Add authentication header if token exists
        const headers = {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            ...opts.headers
        };

        if (AUTH_TOKEN) {
            headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
        }

        // Add CSRF token
        const csrfToken = localStorage.getItem('pyramid_csrf_token') || '';
        if (csrfToken) {
            headers['X-CSRF-Token'] = csrfToken;
        }

        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);

        const res = await fetch(url, {
            ...opts,
            headers,
            signal: controller.signal,
            credentials: 'omit' // Security: don't send credentials by default to IoT devices
        });

        clearTimeout(id);

        // Check for authentication errors
        if (res.status === 401) {
            console.error('Authentication required');
            AUTH_TOKEN = null;
            localStorage.removeItem('pyramid_auth_token');
            // Optionally redirect to login
            return null;
        }

        // Check for rate limit errors
        if (res.status === 429) {
            console.error('Rate limit exceeded');
            return null;
        }

        return res;
    } catch (e) {
        if (e.name === 'AbortError') {
            console.error('Request timeout');
        } else {
            console.error('Fetch error:', e.message);
        }
        return null;
    }
}

// Camera Power States
const cameraPowerStates = { 1: true, 2: true, 3: true, 4: true };

// Toggle Camera Power
async function toggleCameraPower(cam) {
    if (!validateCameraID(cam)) return;

    const btn = document.getElementById(`powerBtn${cam}`);
    const currentState = cameraPowerStates[cam];
    const newState = !currentState;

    // Optimistic UI update
    updatePowerUI(cam, newState);

    try {
        const ip = CAM_IPS[cam];
        if (!ip) throw new Error("Camera not configured");

        const res = await safeFetch(`${ip}/camera/power?state=${newState ? 1 : 0}`, { method: 'POST' }, 5000);

        if (!res || !res.ok) {
            // Fallback for cameras that might not support the power endpoint yet
            // but we still want the dashboard to treat them as 'off'
            console.warn(`Camera ${cam} power endpoint failed or not supported. Dashboard state updated regardless.`);
        }

        cameraPowerStates[cam] = newState;

        // If turned off, stop stream
        if (!newState) {
            const iframe = document.getElementById(`stream${cam}`);
            if (iframe) iframe.src = "";
            const status = document.getElementById(`camFrame${cam}`).querySelector('.cam-status');
            if (status) status.style.display = 'none';
            const placeholder = document.getElementById(`camFrame${cam}`).querySelector('.placeholder');
            if (placeholder) {
                placeholder.innerHTML = '<div style="font-size: 48px; opacity: 0.5;">🔌</div><div>SENSOR POWERED OFF</div>';
                placeholder.style.display = 'flex';
            }
        } else {
            // If turned on, maybe auto-load or just show placeholder
            const placeholder = document.getElementById(`camFrame${cam}`).querySelector('.placeholder');
            if (placeholder) {
                placeholder.innerHTML = '<div>📷</div><div>Click "Load Stream" to connect</div>';
                placeholder.style.display = 'flex';
            }
        }
    } catch (e) {
        console.error(`Error toggling camera ${cam} power:`, e);
        // Revert UI on error
        updatePowerUI(cam, currentState);
    }
}

function updatePowerUI(cam, isOn) {
    const btn = document.getElementById(`powerBtn${cam}`);
    if (!btn) return;

    if (isOn) {
        btn.classList.add('on');
        btn.classList.remove('off');
        btn.innerHTML = '⚡ ON';
    } else {
        btn.classList.add('off');
        btn.classList.remove('on');
        btn.innerHTML = '🌑 OFF';
    }
}

// Load camera stream on demand
function loadStream(cam) {
    // Check power state first
    if (!cameraPowerStates[cam]) {
        alert("❌ Camera is powered OFF. Turn it on first.");
        return;
    }
    // Input validation
    if (!validateCameraID(cam)) {
        console.error('Invalid camera ID');
        return;
    }

    const iframe = document.getElementById(`stream${cam}`);
    const frame = document.getElementById(`camFrame${cam}`);

    if (!iframe || !frame) {
        console.error('Camera elements not found');
        return;
    }

    const status = frame.querySelector('.cam-status');
    const placeholder = frame.querySelector('.placeholder');

    // If already loaded, just show it
    if (iframe.src && iframe.src !== '') {
        iframe.style.display = 'block';
        placeholder.style.display = 'none';
        if (status) {
            status.style.display = 'flex';
            // Update status to show LIVE if not already set
            if (!status.querySelector('.loading.live')) {
                status.innerHTML = '<div class="loading live"></div> LIVE';
            }
        }
        return;
    }

    const url = iframe.getAttribute('data-src');

    // Validate URL
    if (!url || !validateIP(url.replace(/https?:\/\//, '').split('/')[0])) {
        console.error('Invalid stream URL');
        return;
    }

    // Reset state
    iframe.style.display = 'block';
    placeholder.style.display = 'none';
    if (status) {
        status.style.display = 'flex';
        status.innerHTML = '<div class="loading"></div> Connecting...';
    }

    // Track if stream loaded successfully
    let streamLoaded = false;

    // Set timeout for 30 seconds
    const timeoutId = setTimeout(() => {
        if (!streamLoaded) {
            // Connection failed - show error
            iframe.style.display = 'none';
            placeholder.innerHTML = '<div>❌</div><div>Connection timeout (30s)<br>Camera may be offline</div>';
            placeholder.style.display = 'flex';
            if (status) {
                status.style.display = 'none';
            }
            iframe.src = ''; // Reset src
        }
    }, 30000); // 30 seconds

    // For MJPEG streams, onload might not fire as expected. 
    // We'll consider it "live" after a brief delay if no error occurs.
    iframe.src = url;

    setTimeout(() => {
        if (iframe.style.display !== 'none') {
            streamLoaded = true;
            if (status) status.innerHTML = '<div class="loading live"></div> LIVE';
        }
    }, 2000);
}

// Update system status
async function updateStatus() {
    try {
        // If WebSocket is connected, we rely on it for real-time updates
        // but we still poll /status initially or as a fallback
        if (ws && ws.readyState === WebSocket.OPEN) return;

        const res = await safeFetch(MAIN_IP + "/status");
        if (!res || !res.ok) {
            document.getElementById("tileSystem").innerText = "OFFLINE";
            document.getElementById("sysStatus").innerText = "OFFLINE";
            return;
        }
        const data = await res.json().catch(() => null);
        if (!data) {
            document.getElementById("tileSystem").innerText = "ERROR";
            document.getElementById("sysStatus").innerText = "ERROR";
            return;
        }
        document.getElementById("tileSystem").innerText = data.armed ? "ARMED" : "DISARMED";
        document.getElementById("tileAlert").innerText = data.log || "NONE";
        document.getElementById("tileActivity").innerText = data.prox > 0 ? `OBJ @ ${data.prox}cm` : "CLEAR";
        document.getElementById("sysStatus").innerText = data.armed ? "🔒 ARMED" : "🔓 DISARMED";

        if (data.log && data.log !== "NONE" && data.log !== "KERNEL_BOOT") {
            triggerBrowserAlert(data);
        }
    } catch (e) {
        console.error('Status update error:', e);
        document.getElementById("tileSystem").innerText = "ERROR";
        document.getElementById("sysStatus").innerText = "ERROR";
    }
}

// Load event logs
async function loadLogs() {
    try {
        const res = await safeFetch(MAIN_IP + "/api/logs", {}, 2000);
        if (!res) {
            document.getElementById("logs").innerHTML = '<div class="log-entry">⚠️ No connection to main controller</div>';
            return;
        }
        const txt = await res.text();
        const entries = txt.split('\n').filter(l => l.trim());
        const html = entries.map(line => `<div class="log-entry">${line}</div>`).join('');
        document.getElementById("logs").innerHTML = html || '<div class="log-entry">No logs available</div>';

        const logsEl = document.getElementById("logs");
        logsEl.scrollTop = logsEl.scrollHeight;
    } catch (e) {
        console.error('Logs error:', e);
    }
}

// Load gallery
async function loadGallery() {
    try {
        const container = document.getElementById("galleryContainer");
        if (!container) return;

        container.innerHTML = '<div class="muted">Loading Vault...</div>';

        // 1. Load from IndexedDB (Local)
        const localSnaps = await getLocalSnapshots();

        let html = '';

        if (localSnaps.length > 0) {
            html += `<div style="width: 100%; font-size: 10px; color: var(--success); margin-bottom: 10px;">💾 LOCAL VAULT (${localSnaps.length} ITEMS)</div>`;
            localSnaps.forEach(snap => {
                const url = URL.createObjectURL(snap.image);
                const date = new Date(snap.timestamp).toLocaleString();
                html += `<img src="${url}" alt="CAM ${snap.camId}" onclick="openImage('${url}')" title="Captured: ${date}">`;
            });
        }

        // 2. Try to Load from ESP32 (Remote)
        const res = await safeFetch(MAIN_IP + "/gallery.json", {}, 2000);
        if (res && res.ok) {
            const files = await res.json().catch(() => null);
            if (files && Array.isArray(files) && files.length > 0) {
                html += `<div style="width: 100%; font-size: 10px; color: var(--accent); margin: 10px 0;">📡 BRAIN CORE STORAGE (${files.length} ITEMS)</div>`;
                files.forEach(f => {
                    const encoded = encodeURIComponent(f);
                    html += `<img src="${MAIN_IP}/captured/${encoded}" alt="${f}" onclick="openImage('${MAIN_IP}/captured/${encoded}')" title="${f}" onerror="this.style.display='none'">`;
                });
            }
        }

        if (!html) {
            container.innerHTML = '<div class="muted">Vault Empty</div>';
        } else {
            container.innerHTML = html;
        }
    } catch (e) {
        console.error('Gallery error:', e);
        document.getElementById("galleryContainer").innerHTML = '<div class="muted">Vault offline</div>';
    }
}

// Open fullscreen
function openFull(url) {
    // Input validation - sanitize URL
    if (!url || typeof url !== 'string') {
        console.error('Invalid URL');
        return;
    }

    // Validate IP in URL
    const urlMatch = url.match(/https?:\/\/([\d.]+)/);
    if (!urlMatch || !validateIP(urlMatch[1])) {
        console.error('Invalid URL format');
        return;
    }

    const modalFrame = document.getElementById("modalFrame");
    const modal = document.getElementById("modal");
    if (modalFrame && modal) {
        // Sanitize URL before setting
        const sanitizedUrl = sanitizeInput(url);
        modalFrame.src = sanitizedUrl;
        modal.classList.add('active');
    }
}

function closeFull() {
    const modal = document.getElementById("modal");
    const modalFrame = document.getElementById("modalFrame");
    if (modal) {
        modal.classList.remove('active');
    }
    if (modalFrame) {
        modalFrame.src = "";
    }
}

function openImage(url) {
    openFull(url);
}

// Snapshot
async function snapshot(cam) {
    if (!validateCameraID(cam)) {
        alert("❌ Invalid camera ID");
        return;
    }

    const ip = CAM_IPS[cam];
    if (!ip) {
        alert("❌ Camera not configured");
        return;
    }

    try {
        // Trigger capture on hardware
        const res = await safeFetch(ip + "/capture", { method: 'POST' }, 8000);

        // For standard ESP32-CAM, /capture usually returns the JPG directly or a JSON status
        // If it returns the JPG, we can save it to IndexedDB.
        // Let's also try to get the current stream frame as a backup / improved experience

        const streamImg = document.getElementById(`stream${cam}`);
        if (streamImg && streamImg.src) {
            // Fetch the current image from the stream URL
            const blobRes = await fetch(ip + "/capture"); // Or /stream if simple
            const blob = await blobRes.blob();

            // Save to Local Database!
            await saveSnapshotToLocal(cam, blob);

            playSound();
            console.log(`✅ Snapshot from Cam ${cam} saved to LOCAL VAULT`);
        }

        setTimeout(loadGallery, 500);
    } catch (e) {
        console.error("Snapshot error:", e);
        alert("❌ Snapshot failed to reach database");
    }
}

// ARM/DISARM
async function armSystem() {
    await safeFetch(MAIN_IP + "/arm?state=1");
    playSound();
    setTimeout(updateStatus, 500);
}

async function disarmSystem() {
    await safeFetch(MAIN_IP + "/arm?state=0");
    playSound();
    setTimeout(updateStatus, 500);
}

// Alert sound
function playSound() {
    document.getElementById("alertSound").play().catch(() => { });
}

// Browser alert
function triggerBrowserAlert(data) {
    const alertKey = data.camera + ":" + data.alert;
    if (lastAlerts.indexOf(alertKey) === -1) {
        lastAlerts.push(alertKey);
        playSound();

        const prev = document.title;
        document.title = "⚠️ ALERT - Pyramid!";
        setTimeout(() => document.title = prev, 4000);

        if ("Notification" in window && Notification.permission === "granted") {
            new Notification("🏔️ Pyramid Alert!", {
                body: `${data.alert} detected on Camera ${data.camera}`,
                icon: "🚨"
            });
        }
    }
}

// Sidebar toggle functionality
function initSidebarToggle() {
    const sidebar = document.getElementById("sidebar");
    const toggleBtn = document.getElementById("sidebarToggle");
    const toggleIcon = document.getElementById("toggleIcon");

    if (!sidebar || !toggleBtn) return;

    // Check localStorage for saved state
    const isMinimized = localStorage.getItem('sidebarMinimized') === 'true';
    if (isMinimized) {
        sidebar.classList.add('minimized');
        toggleIcon.textContent = '▶';
    }

    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('minimized');
        const isNowMinimized = sidebar.classList.contains('minimized');

        // Update icon
        toggleIcon.textContent = isNowMinimized ? '▶' : '◀';

        // Save state
        localStorage.setItem('sidebarMinimized', isNowMinimized.toString());
    });
}

// Request notification permission on load
if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
}

// Event listeners with null checks
const armBtn = document.getElementById("armBtn");
const disarmBtn = document.getElementById("disarmBtn");
const refreshAll = document.getElementById("refreshAll");
const btnDownloadLog = document.getElementById("btnDownloadLog");
const btnDownloadLog2 = document.getElementById("btnDownloadLog2");
const modal = document.getElementById("modal");

if (armBtn) armBtn.addEventListener("click", armSystem);
if (disarmBtn) disarmBtn.addEventListener("click", disarmSystem);
if (refreshAll) {
    refreshAll.addEventListener("click", () => {
        location.reload();
    });
}

if (btnDownloadLog) {
    btnDownloadLog.addEventListener("click", () => {
        const logsEl = document.getElementById("logs");
        if (logsEl) {
            const logs = logsEl.innerText;
            const blob = new Blob([logs], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `pyramid-logs-${new Date().toISOString().split('T')[0]}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        }
    });
}

if (btnDownloadLog2) {
    btnDownloadLog2.addEventListener("click", () => {
        const logsEl = document.getElementById("logs");
        if (logsEl) {
            const logs = logsEl.innerText;
            const blob = new Blob([logs], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `pyramid-logs-${new Date().toISOString().split('T')[0]}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        }
    });
}

// Close modal on outside click
if (modal) {
    modal.addEventListener("click", (e) => {
        if (e.target.id === "modal") {
            closeFull();
        }
    });
}

// WebSocket support for real-time alerts
function initWebSocket() {
    if (ws) ws.close();

    const wsUrl = `ws://${normalizeIP(MAIN_IP_RAW)}:81`;
    console.log(`Connecting to WebSocket: ${wsUrl}`);

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'blob';

    ws.onmessage = async (event) => {
        try {
            if (typeof event.data === 'string') {
                const data = JSON.parse(event.data);

                // Snapshot header message (metadata for the next binary frame)
                if (data.event === 'snapshot_header') {
                    pendingSnapshots.push({ snapshot_id: data.snapshot_id, camId: data.cam_id, ts: data.ts });
                    console.log('Snapshot header queued:', data.cam_id, data.snapshot_id);
                    return;
                }

                if (data.event === "state_update") {
                    document.getElementById("tileSystem").innerText = data.armed ? "ARMED" : "DISARMED";
                    document.getElementById("tileAlert").innerText = data.log || "NONE";
                    document.getElementById("tileActivity").innerText = data.prox > 0 ? `OBJ @ ${data.prox}cm` : "CLEAR";
                    document.getElementById("sysStatus").innerText = data.armed ? "🔒 ARMED" : "🔓 DISARMED";

                    // If there's a fresh log entry in the websocket
                    if (data.log && data.log !== "KERNEL_BOOT") {
                        loadLogs();
                    }
                }

                // Keep existing alert handling for JSON alerts (AI detection)
                if (data.event === 'alert' && data.type === 'HUMAN_TARGET') {
                    // Let AIDetection handle the alert (it listens to websocket messages separately)
                    // but ensure UI updates happen now
                    AIDetection.handleDetection && AIDetection.handleDetection(data);
                }
            } else {
                // Binary frame (expected to be the JPEG blob for the most recent header)
                const blob = event.data;
                let header = pendingSnapshots.shift();
                let camId = header ? header.camId : 1;
                try {
                    await saveSnapshotToLocal(camId, blob);
                    console.log(`Saved auto-snapshot from Cam ${camId} to IndexedDB`);
                    playSound();
                    // Refresh gallery to show the new image
                    setTimeout(loadGallery, 200);
                } catch (e) {
                    console.error('Failed to save incoming snapshot:', e);
                }
            }
        } catch (e) {
            console.error("WS Parse Error", e);
        }
    };

    ws.onopen = () => {
        console.log("WebSocket connected");
        document.getElementById("sysStatus").innerText = "CONNECTED";

        // Update AI status to Active when connected
        const aiStatus = document.getElementById('aiStatus');
        if (aiStatus) {
            aiStatus.textContent = 'Active';
            aiStatus.style.color = 'var(--success)';
        }
    };

    ws.onclose = () => {
        console.log("WebSocket closed. Retrying...");

        // Update AI status to Offline when disconnected
        const aiStatus = document.getElementById('aiStatus');
        if (aiStatus) {
            aiStatus.textContent = 'Offline';
            aiStatus.style.color = 'var(--text-muted)';
        }

        setTimeout(initWebSocket, 5000);
    };
}

// Initialize
initSidebarToggle();
initDB().then(() => {
    initWebSocket();
    updateStatus();
    loadLogs();
    loadGallery();
});

// Auto-refresh every 5 seconds
setInterval(() => {
    updateStatus();
    loadLogs();
}, 5000);

// Refresh gallery every 30 seconds
setInterval(loadGallery, 30000);

/* ====== AI OBJECT RECOGNITION MODULE ====== */

// AI Detection State
const AIDetection = {
    detectionsToday: 0,
    totalConfidence: 0,
    detectionCount: 0,
    lastDetectionTime: null,
    activeDetections: { 1: false, 2: false, 3: false, 4: false },

    // Initialize AI detection system
    init() {
        console.log('AI Detection System: Initialized');
        this.loadTodayStats();
        this.setupWebSocketListener();
        // Set initial status to Offline until WebSocket connects
        const aiStatus = document.getElementById('aiStatus');
        if (aiStatus) {
            aiStatus.textContent = 'Offline';
            aiStatus.style.color = 'var(--text-muted)';
        }
    },

    // Load today's detection stats from localStorage
    loadTodayStats() {
        const today = new Date().toDateString();
        const savedDate = localStorage.getItem('ai_stats_date');

        if (savedDate === today) {
            this.detectionsToday = parseInt(localStorage.getItem('ai_detections_today') || '0');
            this.totalConfidence = parseFloat(localStorage.getItem('ai_total_confidence') || '0');
            this.detectionCount = parseInt(localStorage.getItem('ai_detection_count') || '0');
        } else {
            // New day, reset stats
            this.detectionsToday = 0;
            this.totalConfidence = 0;
            this.detectionCount = 0;
            localStorage.setItem('ai_stats_date', today);
        }

        this.updateStatsDisplay();
    },

    // Save stats to localStorage
    saveStats() {
        const today = new Date().toDateString();
        localStorage.setItem('ai_stats_date', today);
        localStorage.setItem('ai_detections_today', this.detectionsToday.toString());
        localStorage.setItem('ai_total_confidence', this.totalConfidence.toString());
        localStorage.setItem('ai_detection_count', this.detectionCount.toString());
    },

    // Setup WebSocket listener for AI alerts
    setupWebSocketListener() {
        if (!ws) return;
        ws.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return; // ignore binary here
            try {
                const data = JSON.parse(event.data);
                if (data.event === 'alert' && data.type === 'HUMAN_TARGET') {
                    this.handleDetection(data);
                }
            } catch (e) {
                // Ignore parse errors
            }
        });
    },

    // Handle new AI detection
    handleDetection(data) {
        const camId = data.cam_id;
        if (!camId || camId < 1 || camId > 4) return;

        // Update stats
        this.detectionsToday++;
        this.detectionCount++;
        this.lastDetectionTime = new Date();

        // Assume 85% confidence for ESP32 face detection
        const confidence = 0.85;
        this.totalConfidence += confidence;

        // Save stats
        this.saveStats();

        // Show detection badge
        this.showDetectionBadge(camId);

        // Draw AI overlay on camera feed
        this.drawOverlay(camId, confidence);

        // Add AI active class to camera frame
        const camFrame = document.getElementById(`camFrame${camId}`);
        if (camFrame) {
            camFrame.classList.add('ai-active');
        }

        // Update display
        this.updateStatsDisplay();

        // New: Automatic Snapshot Trigger
        if (data.auto_snap) {
            console.log(`📸 AI AUTO-SNAPSHOT: Triggering capture for Cam ${camId}`);
            snapshot(camId);
        }

        // Auto-hide after 5 seconds
        setTimeout(() => {
            this.hideDetectionBadge(camId);
            this.clearOverlay(camId);
            if (camFrame) {
                camFrame.classList.remove('ai-active');
            }
        }, 5000);

        console.log(`AI Detection: Camera ${camId} - Confidence: ${(confidence * 100).toFixed(1)}%`);
    },

    // Show detection badge on camera
    showDetectionBadge(camId) {
        const badge = document.getElementById(`aiDetection${camId}`);
        if (badge) {
            badge.style.display = 'flex';
            this.activeDetections[camId] = true;
        }
    },

    // Hide detection badge
    hideDetectionBadge(camId) {
        const badge = document.getElementById(`aiDetection${camId}`);
        if (badge) {
            badge.style.display = 'none';
            this.activeDetections[camId] = false;
        }
    },

    // Update stats display
    updateStatsDisplay() {
        // AI Status
        const aiStatus = document.getElementById('aiStatus');
        if (aiStatus) {
            const activeCount = Object.values(this.activeDetections).filter(v => v).length;
            aiStatus.textContent = activeCount > 0 ? `Detecting (${activeCount})` : 'Active';
            aiStatus.style.color = activeCount > 0 ? 'var(--danger)' : 'var(--success)';
        }

        // Detections Today
        const detectionsToday = document.getElementById('detectionsToday');
        if (detectionsToday) {
            detectionsToday.textContent = this.detectionsToday;
        }

        // Average Confidence
        const confidenceAvg = document.getElementById('confidenceAvg');
        if (confidenceAvg) {
            if (this.detectionCount > 0) {
                const avg = (this.totalConfidence / this.detectionCount) * 100;
                confidenceAvg.textContent = `${avg.toFixed(0)}%`;
            } else {
                confidenceAvg.textContent = '--';
            }
        }

        // Last Detection
        const lastDetection = document.getElementById('lastDetection');
        if (lastDetection) {
            if (this.lastDetectionTime) {
                const now = new Date();
                const diff = Math.floor((now - this.lastDetectionTime) / 1000);

                if (diff < 60) {
                    lastDetection.textContent = `${diff}s ago`;
                } else if (diff < 3600) {
                    lastDetection.textContent = `${Math.floor(diff / 60)}m ago`;
                } else {
                    lastDetection.textContent = `${Math.floor(diff / 3600)}h ago`;
                }
            } else {
                lastDetection.textContent = 'None';
            }
        }
    },

    // Draw AI overlay on camera feed
    drawOverlay(camId, confidence) {
        const canvas = document.getElementById(`aiOverlay${camId}`);
        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        // Set canvas size to match the iframe/video container
        const camFrame = document.getElementById(`camFrame${camId}`);
        if (camFrame) {
            canvas.width = camFrame.offsetWidth;
            canvas.height = camFrame.offsetHeight;
        }

        // Clear previous drawings
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw bounding box (centered, about 60% of frame)
        const boxWidth = canvas.width * 0.6;
        const boxHeight = canvas.height * 0.6;
        const boxX = (canvas.width - boxWidth) / 2;
        const boxY = (canvas.height - boxHeight) / 2;

        // Animated pulsing effect
        let alpha = 1;
        const animate = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw bounding box
            ctx.strokeStyle = `rgba(88, 166, 255, ${alpha})`;
            ctx.lineWidth = 3;
            ctx.setLineDash([10, 5]);
            ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);

            // Draw corner brackets
            const cornerLength = 30;
            ctx.setLineDash([]);
            ctx.lineWidth = 4;

            // Top-left
            ctx.beginPath();
            ctx.moveTo(boxX, boxY + cornerLength);
            ctx.lineTo(boxX, boxY);
            ctx.lineTo(boxX + cornerLength, boxY);
            ctx.stroke();

            // Top-right
            ctx.beginPath();
            ctx.moveTo(boxX + boxWidth - cornerLength, boxY);
            ctx.lineTo(boxX + boxWidth, boxY);
            ctx.lineTo(boxX + boxWidth, boxY + cornerLength);
            ctx.stroke();

            // Bottom-left
            ctx.beginPath();
            ctx.moveTo(boxX, boxY + boxHeight - cornerLength);
            ctx.lineTo(boxX, boxY + boxHeight);
            ctx.lineTo(boxX + cornerLength, boxY + boxHeight);
            ctx.stroke();

            // Bottom-right
            ctx.beginPath();
            ctx.moveTo(boxX + boxWidth - cornerLength, boxY + boxHeight);
            ctx.lineTo(boxX + boxWidth, boxY + boxHeight);
            ctx.lineTo(boxX + boxWidth, boxY + boxHeight - cornerLength);
            ctx.stroke();

            // Draw label
            const label = `HUMAN DETECTED - ${(confidence * 100).toFixed(0)}%`;
            ctx.font = 'bold 14px Inter, sans-serif';
            ctx.fillStyle = `rgba(88, 166, 255, ${alpha})`;
            ctx.fillRect(boxX, boxY - 30, ctx.measureText(label).width + 20, 25);
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.fillText(label, boxX + 10, boxY - 10);

            // Pulse effect
            alpha = 0.5 + Math.sin(Date.now() / 300) * 0.5;
        };

        // Store animation interval
        if (!canvas.animationInterval) {
            canvas.animationInterval = setInterval(animate, 50);
        }
    },

    // Clear AI overlay
    clearOverlay(camId) {
        const canvas = document.getElementById(`aiOverlay${camId}`);
        if (!canvas) return;

        // Stop animation
        if (canvas.animationInterval) {
            clearInterval(canvas.animationInterval);
            canvas.animationInterval = null;
        }

        // Clear canvas
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    },

    // Manual trigger for testing
    testDetection(camId) {
        this.handleDetection({
            cam_id: camId,
            type: 'HUMAN_TARGET',
            sector: ['NORTH', 'EAST', 'SOUTH', 'WEST'][camId - 1],
            temp: 45.2
        });
    }
};

// Initialize AI Detection when page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AIDetection.init());
} else {
    AIDetection.init();
}

// Update last detection time display every 10 seconds
setInterval(() => {
    if (AIDetection.lastDetectionTime) {
        AIDetection.updateStatsDisplay();
    }
}, 10000);

// Expose to global scope for debugging
window.AIDetection = AIDetection;

console.log('AI Object Recognition Module: Loaded');