import { db } from "./firebase-config.js";
import { ref, set, onValue, remove, get, update } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

let timerInterval = null;
let watchId = null;
let currentDriverKey = null;
let wakeLock = null;
let lastNotifiedStatus = null;
let isSystemHalted = false; 
let gpsHeartbeatInterval = null; 

const ADM_KARAWANG = [-6.415890, 107.336336];
const NVDC_KARAWANG = [-6.357970071909847, 107.25383521916625];
const RADIUS_LOADING_ADM = 30;

let map = null;
let driverMarker = null;
let mapInitialized = false;

let routingControl = null;
let isFullScreen = false;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) { console.error("Wake Lock Gagal:", err); }
}

document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

function triggerAlertNotification() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.6);
    } catch (e) { console.error(e); }
    if ("vibrate" in navigator) navigator.vibrate([500, 200, 500]);
}

function getDistanceInMeters(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1) return 0;
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters) {
    return meters < 1000 ? Math.round(meters) + " m" : (meters / 1000).toFixed(1) + " km";
}

const inputGroup = document.getElementById("inputGroup");
const mapContainer = document.getElementById("mapContainer");
const btnStart = document.getElementById("btnStart");
const btnEnd = document.getElementById("btnEnd");
const inputNopol = document.getElementById("inputNopol");
const inputNama = document.getElementById("inputNama");
const statusBadge = document.getElementById("statusBadge");
const lblUpdate = document.getElementById("lblUpdate");
const lblSisaWaktu = document.getElementById("lblSisaWaktu");
const driverQueueBody = document.getElementById("driverQueueBody");
const durationBadge = document.getElementById("durationBadge");
const loadingModal = document.getElementById("loadingModal");
const btnAcceptLoading = document.getElementById("btnAcceptLoading");
const btnToggleFullMap = document.getElementById("btnToggleFullMap");

window.addEventListener('DOMContentLoaded', async () => {
    // ==========================================================
    // PAKSA MUNCUL POP-UP IZIN NOTIFIKASI NATIVE DI AWAL
    // ==========================================================
    try {
        // Pancingan API Web Standar
        if ('Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
            Notification.requestPermission();
        }
        // Pancingan API Native Capacitor
        if (window.Capacitor && window.Capacitor.Plugins.LocalNotifications) {
            await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
        }
    } catch (e) { console.log("Gagal minta izin notif di awal", e); }

    if (sessionStorage.getItem('DRIVER_KICKED')) {
        sessionStorage.removeItem('DRIVER_KICKED');
        localStorage.removeItem('CC_ACTIVE_TRIP'); 
        alert("⚠️ SESI DIHENTIKAN!\n\nAnda telah dikeluarkan paksa dari antrian oleh Admin.");
    }

    const savedTrip = localStorage.getItem('CC_ACTIVE_TRIP');
    if (savedTrip) {
        try {
            const tripData = JSON.parse(savedTrip);
            if (tripData && tripData.nopol) {
                if (tripData.expireTime && Date.now() >= tripData.expireTime) {
                    localStorage.removeItem('CC_ACTIVE_TRIP'); return;
                }
                inputNopol.value = tripData.nopol;
                if (inputNama && tripData.nama) inputNama.value = tripData.nama;
                startTrackingProcess(tripData.nopol, tripData.nama, (tripData.expireTime - Date.now()) / (1000 * 60 * 60));
            }
        } catch (e) { console.error(e); }
    }
});

const allDriversRef = ref(db, 'drivers');
onValue(allDriversRef, (snapshot) => {
    const data = snapshot.val();
    if (!driverQueueBody) return;
    driverQueueBody.innerHTML = "";
    if (!data) {
        driverQueueBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#888;">Belum ada antrian.</td></tr>`;
        return;
    }

    const list = [];
    Object.keys(data).forEach(key => {
        const d = data[key];
        if (d.status === "KICKED" || d.isKicked) return;
        if (d.isOnline && d.lat && d.lng) {
            const dist = getDistanceInMeters(d.lat, d.lng, ADM_KARAWANG[0], ADM_KARAWANG[1]);
            list.push({
                nopol: d.nopol || key, nama: d.nama || "", status: (d.status || "ONLINE").toUpperCase(),
                distMeters: dist, distFormatted: formatDistance(dist), entryTime: d.entryTime || Date.now()
            });
        }
    });

    if (list.length === 0) {
        driverQueueBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#888;">Belum ada driver online.</td></tr>`;
        return;
    }

    list.sort((a, b) => {
        if (a.status === "LOADING" && b.status !== "LOADING") return -1;
        if (a.status !== "LOADING" && b.status === "LOADING") return 1;
        if (a.status === "PERSIAPAN LOADING" && b.status !== "PERSIAPAN LOADING") return -1;
        if (a.status !== "PERSIAPAN LOADING" && b.status === "PERSIAPAN LOADING") return 1;
        if (a.status === "READY SJKB" && b.status !== "READY SJKB") return -1;
        if (a.status !== "READY SJKB" && b.status === "READY SJKB") return 1;
        if (a.status === "READY SJKB" && b.status === "READY SJKB") return a.entryTime - b.entryTime;
        if (a.status === "ONLINE" && b.status !== "ONLINE") return -1;
        if (a.status !== "ONLINE" && b.status === "ONLINE") return 1;
        if (a.status === "DELIVERY" && b.status !== "DELIVERY") return 1;
        if (a.status !== "DELIVERY" && b.status === "DELIVERY") return -1;
        return a.distMeters - b.distMeters;
    });

    let idx = 1;
    list.forEach(d => {
        driverQueueBody.innerHTML += `<tr><td>${idx++}</td><td><b>${d.nopol}</b>${d.nama ? `<br><small style="color:#666;">${d.nama}</small>` : ''}</td><td>${d.distFormatted}</td><td><span class="badge-small status-${d.status.toLowerCase().replace(/\s+/g, '-')}">${d.status}</span></td></tr>`;
    });
});

function createDriverMarkerIcon(nopol, nama, status) {
    const statusClass = status.toLowerCase().replace(/\s+/g, '-');
    return L.divIcon({
        className: 'driver-balloon-wrapper',
        html: `<div class="driver-speech-bubble bubble-${statusClass}"><div style="font-size: 12px; font-weight: 900; line-height: 1.2;">${nopol}</div><div style="font-size: 10px; font-weight: 700; opacity: 0.95;">${nama}</div></div>`,
        iconSize: [0, 0], iconAnchor: [0, 36] 
    });
}

function initMap(lat, lng, nopol, nama, status) {
    if (mapInitialized) return;
    map = L.map('map').setView([lat, lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    
    L.circle(ADM_KARAWANG, { color: '#1d4ed8', fillOpacity: 0.2, radius: 40 }).addTo(map);
    L.marker(ADM_KARAWANG, { icon: L.divIcon({ className: 'radar-marker-eky', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(map);
    L.marker(ADM_KARAWANG, { icon: L.divIcon({ className: 'label-location-eky', html: `EKY`, iconAnchor: [12, -5] }) }).addTo(map);
    
    L.circle(NVDC_KARAWANG, { color: '#854d0e', fillOpacity: 0.2, radius: 100 }).addTo(map);
    
    const customIcon = createDriverMarkerIcon(nopol, nama, status);
    driverMarker = L.marker([lat, lng], { icon: customIcon }).addTo(map);
    
    mapInitialized = true;
    setTimeout(() => { map.invalidateSize(); }, 500); 
}

if (btnToggleFullMap) {
    btnToggleFullMap.addEventListener("click", () => {
        isFullScreen = !isFullScreen;
        if (isFullScreen) {
            mapContainer.classList.add("map-fullscreen");
            btnToggleFullMap.textContent = "❌ TUTUP FULL MAP";
            btnToggleFullMap.style.background = "#dc2626";
            btnToggleFullMap.style.color = "white";
            btnToggleFullMap.style.border = "none";
        } else {
            mapContainer.classList.remove("map-fullscreen");
            btnToggleFullMap.textContent = "🔍 FULL MAP";
            btnToggleFullMap.style.background = "#ffffff";
            btnToggleFullMap.style.color = "#1e3a8a";
            btnToggleFullMap.style.border = "2px solid #1e3a8a";
        }
        setTimeout(() => { if (map) map.invalidateSize(); }, 300);
    });
}

async function startTrackingProcess(nopol, namaDriver, durasiJam = 8) {
    await requestWakeLock();
    currentDriverKey = nopol.replace(/\s+/g, '_');
    const driverRef = ref(db, `drivers/${currentDriverKey}`);

    onValue(driverRef, (snap) => {
        const val = snap.val();
        if (val && (val.isKicked === true || val.status === "KICKED")) {
            isSystemHalted = true; 
            sessionStorage.setItem('DRIVER_KICKED', 'true');
            matikanSistemGPS(); 
        }
    });

    const savedTrip = JSON.parse(localStorage.getItem('CC_ACTIVE_TRIP') || '{}');
    const expireTime = savedTrip.expireTime || (Date.now() + (durasiJam * 60 * 60 * 1000));
    localStorage.setItem('CC_ACTIVE_TRIP', JSON.stringify({ nopol, nama: namaDriver, expireTime }));

    if (inputGroup) inputGroup.style.display = "none";
    if (mapContainer) mapContainer.style.display = "block";
    if (btnStart) btnStart.style.display = "none";
    if (btnEnd) btnEnd.style.display = "block";
    if (durationBadge) durationBadge.style.display = "block";

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        const sisaMs = expireTime - Date.now();
        if (sisaMs <= 0) {
            clearInterval(timerInterval);
            alert("⏰ Waktu Berbagi Lokasi Trip Telah Berakhir!");
            matikanSistemGPS();
            return;
        }
        const jam = Math.floor(sisaMs / (1000 * 60 * 60));
        const menit = Math.floor((sisaMs % (1000 * 60 * 60)) / (1000 * 60));
        const detik = Math.floor((sisaMs % (1000 * 60)) / 1000);
        if (lblSisaWaktu) lblSisaWaktu.textContent = `${jam}j ${menit}m ${detik}d`;
    }, 1000);

    // ==========================================================
    // 2. EKSEKUSI KAMUFLASE STREAMING RADIO (MENAHAN INTERNET)
    // ==========================================================
    try {
        const audioCamouflage = document.getElementById('audioCamouflage');
        if (audioCamouflage) {
            audioCamouflage.play().then(() => {
                if ('mediaSession' in navigator) {
                    navigator.mediaSession.metadata = new MediaMetadata({
                        title: 'Radio Streaming CC EKY',
                        artist: 'Live Transport Monitoring',
                        album: 'Background Service Active'
                    });
                }
            }).catch(err => console.log("Audio Play Tertahan Browser:", err));
        }
    } catch (e) { console.error(e); }

    // ==========================================================
    // 3. PENGAMBILAN GPS STANDAR (Ditopang oleh Streaming Radio)
    // ==========================================================
    try {
        // Pancingan awal agar map langsung muncul
        navigator.geolocation.getCurrentPosition(
            (pos) => processLocationUpdate(pos.coords.latitude, pos.coords.longitude, nopol, namaDriver, driverRef),
            (err) => console.log(err), { enableHighAccuracy: true, maximumAge: 0 }
        );

        // Langsung gunakan sensor gerak bawaan Web (karena aplikasi ditahan melek oleh Audio)
        watchId = navigator.geolocation.watchPosition(
            (pos) => processLocationUpdate(pos.coords.latitude, pos.coords.longitude, nopol, namaDriver, driverRef), 
            (err) => console.error(err), { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
        );
    } catch (e) { console.error(e); }

    // ==========================================================
    // 4. PEMAKSAAN GPS (HEARTBEAT) TIAP 30 DETIK (BACKUP)
    // ==========================================================
    if (gpsHeartbeatInterval) clearInterval(gpsHeartbeatInterval);
    gpsHeartbeatInterval = setInterval(() => {
        navigator.geolocation.getCurrentPosition(
            (pos) => processLocationUpdate(pos.coords.latitude, pos.coords.longitude, nopol, namaDriver, driverRef),
            (err) => console.log("Menunggu sinyal satelit 30 detik..."),
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
        );
    }, 30000); 
}

async function processLocationUpdate(lat, lng, nopol, namaDriver, driverRef) {
    if (isSystemHalted) return; 

    const now = Date.now();
    const snapshot = await get(driverRef);
    const currentData = snapshot.val();

    const distToADM = getDistanceInMeters(lat, lng, ADM_KARAWANG[0], ADM_KARAWANG[1]);
    const distToNVDC = getDistanceInMeters(lat, lng, NVDC_KARAWANG[0], NVDC_KARAWANG[1]);

    if (currentData === null && mapInitialized) {
        if (distToNVDC > 100) return; 
    }

    let newStatus = currentData ? currentData.status : "ONLINE";
    let sjkbStatus = currentData ? (currentData.sjkbPrinted || false) : false; 

    if (newStatus !== "PERSIAPAN LOADING") {
        if (distToADM <= RADIUS_LOADING_ADM) {
            newStatus = "LOADING";
        } else if ((newStatus === "LOADING" || newStatus === "PERSIAPAN LOADING") && distToADM > RADIUS_LOADING_ADM) {
            newStatus = "DELIVERY";
        } else if (distToNVDC <= 100) {
            newStatus = "UNLOADING";
        } else if (distToADM <= 3000 && (newStatus === "ONLINE" || !newStatus)) {
            newStatus = "READY SJKB";
        }
    } else if (distToADM <= RADIUS_LOADING_ADM) {
        newStatus = "LOADING";
    }

    if (newStatus === "DELIVERY") {
        sjkbStatus = false;
    }

    update(driverRef, { 
        nopol: nopol, 
        nama: namaDriver, 
        lat: lat, 
        lng: lng, 
        status: newStatus, 
        isOnline: true, 
        lastUpdateMs: now, 
        entryTime: (currentData && currentData.entryTime) ? currentData.entryTime : now,
        sjkbPrinted: sjkbStatus 
    });

    if (statusBadge) {
        if (newStatus === "PERSIAPAN LOADING") {
            statusBadge.textContent = "⚠️ SILAKAN MASUK STALL LOADING";
            if (lastNotifiedStatus !== "PERSIAPAN LOADING") {
                triggerAlertNotification();
                if (loadingModal) loadingModal.style.display = "flex";
                lastNotifiedStatus = "PERSIAPAN LOADING";
            }
        } else {
            statusBadge.textContent = newStatus === "ONLINE" ? "🟢 ONLINE" : newStatus;
            lastNotifiedStatus = newStatus;
        }
        statusBadge.className = `status-box status-${newStatus.toLowerCase().replace(/\s+/g, '-')}`;
    }
    
    if (lblUpdate) lblUpdate.textContent = `Update: ${new Date(now).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;

    if (!mapInitialized) {
        initMap(lat, lng, nopol, namaDriver, newStatus);
    } else {
        driverMarker.setLatLng([lat, lng]);
        driverMarker.setIcon(createDriverMarkerIcon(nopol, namaDriver, newStatus));
        if(!isFullScreen) map.setView([lat, lng]); 
    }

    if (mapInitialized) {
        let targetCoords = null;
        let routeColor = '#3b82f6'; 

        if (newStatus === "ONLINE" || newStatus === "READY SJKB" || newStatus === "PERSIAPAN LOADING") {
            targetCoords = ADM_KARAWANG;
        } else if (newStatus === "DELIVERY") {
            targetCoords = NVDC_KARAWANG;
            routeColor = '#e83e8c'; 
        }

        if (targetCoords) {
            if (!routingControl) {
                routingControl = L.Routing.control({
                    waypoints: [ L.latLng(lat, lng), L.latLng(targetCoords[0], targetCoords[1]) ],
                    show: false, 
                    addWaypoints: false,
                    routeWhileDragging: false,
                    fitSelectedRoutes: false, 
                    createMarker: function() { return null; }, 
                    lineOptions: { styles: [{color: routeColor, opacity: 0.8, weight: 6}] } 
                }).addTo(map);
            } else {
                routingControl.setWaypoints([ L.latLng(lat, lng), L.latLng(targetCoords[0], targetCoords[1]) ]);
                routingControl.getRouter().options.lineOptions = { styles: [{color: routeColor, opacity: 0.8, weight: 6}] };
            }
        } else {
            if (routingControl) {
                map.removeControl(routingControl);
                routingControl = null;
            }
        }
    }
}

async function matikanSistemGPS() {
    isSystemHalted = true; 

    // MATIKAN KAMUFLASE STREAMING RADIO & INTERVAL
    const audioCamouflage = document.getElementById('audioCamouflage');
    if (audioCamouflage) {
        audioCamouflage.pause();
        audioCamouflage.currentTime = 0;
    }
    if (gpsHeartbeatInterval) clearInterval(gpsHeartbeatInterval);

    if (wakeLock !== null) await wakeLock.release();
    if (timerInterval) clearInterval(timerInterval);
    
    // MATIKAN GPS STANDAR (Bersih tanpa if-else Capacitor)
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
    }
    
    if (currentDriverKey) {
        await remove(ref(db, `drivers/${currentDriverKey}`));
    }
    localStorage.removeItem('CC_ACTIVE_TRIP');
    
    location.reload();
}

if (btnStart) {
    btnStart.addEventListener("click", async () => { // Tambahkan kata 'async' di sini
        // PAKSA MUNCUL POP-UP IZIN SAAT TOMBOL DIKLIK
        try {
            if (window.Capacitor && window.Capacitor.Plugins.LocalNotifications) {
                await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
            }
        } catch (e) { console.log("Gagal minta izin notif", e); }

        const nopol = inputNopol.value.trim().toUpperCase();
        if (!nopol) return alert("Silakan masukkan NOPOL kendaraan terlebih dahulu!");
        startTrackingProcess(nopol, inputNama.value.trim().toUpperCase(), parseInt(document.getElementById("selectDurasi").value));
    });
}

if (btnEnd) {
    btnEnd.addEventListener("click", () => {
        if (confirm("⚠️ PERHATIAN!\n\nApakah Anda yakin ingin mengakhiri trip dan berhenti membagikan lokasi?")) {
            matikanSistemGPS(); 
        }
    });
}

if (btnAcceptLoading) {
    btnAcceptLoading.addEventListener("click", () => {
        if (loadingModal) loadingModal.style.display = "none";
        alert("Panggilan diterima! Silakan menuju Stall Loading.");
    });
}