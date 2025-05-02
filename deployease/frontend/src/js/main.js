// frontend/src/js/main.js
import config from './config.js';

// Initialize the dashboard with proper error handling
document.addEventListener("DOMContentLoaded", () => {
    console.log("Dashboard initialized with config:", config);

    // Dark Mode Toggle - Improved with localStorage stability
    const darkModeToggle = document.getElementById("darkModeToggle");
    const darkModePreference = localStorage.getItem("darkMode") === "true";

    // Initialize dark mode without triggering refresh
    const applyDarkMode = (isDark) => {
        document.body.classList.toggle("dark-mode", isDark);
        if (darkModeToggle) {
            darkModeToggle.checked = isDark;
        }
    };

    // Set initial state
    applyDarkMode(darkModePreference);

    // Toggle handler with debounce
    if (darkModeToggle) {
        let debounceTimer;
        darkModeToggle.addEventListener("change", (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const isDark = e.target.checked;
                localStorage.setItem("darkMode", isDark);
                applyDarkMode(isDark);
            }, 200); // 200ms debounce
        });
    }

    // Session storage guard - Prevent infinite refresh loops
    if (sessionStorage.getItem('blockRefresh')) {
        sessionStorage.removeItem('blockRefresh');
    } else {
        // Only set blockRefresh if we're doing an actual refresh
        window.addEventListener('beforeunload', () => {
            if (!sessionStorage.getItem('blockRefresh')) {
                sessionStorage.setItem('blockRefresh', 'true');
            }
        });
    }
});

// Error boundary for uncaught errors
window.addEventListener('error', (event) => {
    console.error('Uncaught error:', event.error);
    // Prevent default error handling that might cause refresh
    event.preventDefault();
});

// Promise rejection handler
window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    event.preventDefault();
});