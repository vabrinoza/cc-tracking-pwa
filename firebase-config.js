import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "eky-cc-tracking-a8353.firebaseapp.com",
    // WAJIB CANTUMKAN DATABASEURL LENGKAP REGION ASIA:
    databaseURL: "https://eky-cc-tracking-a8353-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "eky-cc-tracking-a8353",
    storageBucket: "eky-cc-tracking-a8353.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
// Operkan databaseURL ke getDatabase agar tidak nyasar ke US server
export const db = getDatabase(app, firebaseConfig.databaseURL);