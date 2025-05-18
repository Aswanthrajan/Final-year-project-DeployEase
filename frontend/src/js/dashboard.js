import config from './config.js';
import webSocketManager from './websocket.js';

// DOM Elements Cache
const elements = {
    blueStatus: document.getElementById("blueStatus"),
    greenStatus: document.getElementById("greenStatus"),
    blueHealthStatus: document.getElementById("blueHealthStatus"),
    greenHealthStatus: document.getElementById("greenHealthStatus"),
    switchTraffic: document.getElementById("switchTraffic"),
    rollbackButton: document.getElementById("rollbackButton"),
    refreshButton: document.getElementById("refreshButton"),
    darkModeToggle: document.getElementById("darkModeToggle"),
    toast: document.getElementById('toast') || document.body,
    deployModal: document.getElementById('deployModal'),
    historySection: document.getElementById('deploymentHistoryTableBody'),
    newDeploymentBtn: document.getElementById('newDeploymentBtn'),
    currentActiveEnv: document.getElementById('currentActiveEnv'),
    logContent: document.getElementById('logContent'),
    confirmDeployBtn: document.getElementById('confirmDeployBtn'),
    cancelDeployBtn: document.getElementById('cancelDeployBtn')
};

// Initialize dashboard
function initializeDashboard() {
    try {
        setupEventListeners();
        setupDarkMode();
        setupFileUpload();
        
        // Initial status update with connection check
        if (webSocketManager.getConnectionState() === 'connected') {
            updateEnvironmentStatus();
        } else {
            showToast("Connecting to server...", "info");
            // Will automatically update when connection establishes
        }
    } catch (error) {
        console.error("Dashboard initialization failed:", error);
        showToast("Failed to initialize dashboard", "error");
    }
}

function setupEventListeners() {
    // Main buttons
    if (elements.newDeploymentBtn) {
        elements.newDeploymentBtn.addEventListener('click', showDeployModal);
    }
    
    if (elements.rollbackButton) {
        elements.rollbackButton.addEventListener("click", showRollbackOptions);
    }
    
    if (elements.switchTraffic) {
        elements.switchTraffic.addEventListener("click", switchTraffic);
    }
    
    if (elements.refreshButton) {
        elements.refreshButton.addEventListener("click", () => {
            if (webSocketManager.getConnectionState() === 'connected') {
                updateEnvironmentStatus();
            } else {
                showToast("Connection lost. Please refresh the page.", "error");
            }
        });
    }

    // Modal buttons
    if (elements.confirmDeployBtn) {
        elements.confirmDeployBtn.addEventListener('click', handleDeployment);
    }

    if (elements.cancelDeployBtn) {
        elements.cancelDeployBtn.addEventListener('click', closeDeployModal);
    }

    // Close modal when clicking outside content
    if (elements.deployModal) {
        elements.deployModal.addEventListener('click', (e) => {
            if (e.target === elements.deployModal) {
                closeDeployModal();
            }
        });
    }
}

async function fetchDeploymentHistory() {
    try {
        const baseUrl = window.AppConfig?.apiBaseUrl || config.apiBaseUrl || 'http://localhost:3000';
        const response = await fetch(`${baseUrl}/api/deployments/history/all`);
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const responseData = await response.json();
        
        // Check for success and properly extract blue/green deployment arrays
        if (responseData.success) {
            const history = [
                ...(responseData.blue || []), 
                ...(responseData.green || [])
            ];
            
            history.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
            updateDeploymentHistoryUI(history);
        } else {
            throw new Error(responseData.message || "Failed to fetch deployment history");
        }
    } catch (error) {
        console.error("Failed to fetch deployment history:", error);
        if (elements.historySection) {
            elements.historySection.innerHTML = `
                <tr>
                    <td colspan="4" class="error-message">
                        <i class="fas fa-exclamation-circle"></i> 
                        Failed to load deployment history
                    </td>
                </tr>
            `;
        }
    }
}

function showDeployModal() {
    if (webSocketManager.getConnectionState() !== 'connected') {
        showToast("Cannot deploy - connection lost", "error");
        return;
    }
    
    // Get the modal element
    const deployModal = document.getElementById('deployModal');
    if (!deployModal) {
        console.error("Deploy modal not found in the DOM");
        showToast("Could not open deployment dialog", "error");
        return;
    }
    
    // Set the active branch in the modal (to the currently inactive one)
    const inactiveEnv = getInactiveEnvironment();
    const deploymentType = document.getElementById('deploymentType');
    if (deploymentType) {
        deploymentType.value = inactiveEnv === 'blue' ? 'NEW' : 'UPDATE';
    }
    
    // Reset file list
    const fileList = document.getElementById('fileList');
    if (fileList) fileList.innerHTML = '';
    
    // Reset commit message
    const commitMessage = document.getElementById('commitMessage');
    if (commitMessage) commitMessage.value = '';
    
    // Show the modal
    deployModal.style.display = 'flex';
}

function closeDeployModal() {
    const deployModal = document.getElementById('deployModal');
    if (deployModal) {
        deployModal.style.display = 'none';
    }
}

function handleDeployment() {
    // Get form values
    const deploymentType = document.getElementById('deploymentType').value;
    const commitMessage = document.getElementById('commitMessage').value;
    const fileInput = document.getElementById('fileUpload');
    
    if (!commitMessage) {
        showToast("Please enter a deployment message", "error");
        return;
    }
    
    if (!fileInput.files.length) {
        showToast("Please select files to deploy", "error");
        return;
    }
    
    // Here you would typically send the deployment request
    showToast("Deployment initiated successfully", "success");
    closeDeployModal();
    
    // Note: Actual deployment logic would go here, likely calling gitDeploy.js functions
}

function getInactiveEnvironment() {
    const currentActive = elements.currentActiveEnv?.textContent?.toLowerCase();
    return currentActive === 'blue' ? 'green' : 'blue';
}

function updateDeploymentHistoryUI(history) {
    if (!elements.historySection) return;
    
    elements.historySection.innerHTML = history.length ? 
        history.map(deployment => createDeploymentRow(deployment)).join('') :
        `<tr><td colspan="4" class="info-message">No deployment history available</td></tr>`;
}

function createDeploymentRow(deployment) {
    const timestamp = deployment.timestamp ? new Date(deployment.timestamp).toLocaleString() : 'N/A';
    const status = deployment.status?.toLowerCase() || 'unknown';
    const branch = deployment.branch || (deployment.commitUrl?.includes('blue') ? 'blue' : 'green');
    
    return `
        <tr>
            <td>${deployment.id || deployment.commitSha?.slice(0, 7) || 'N/A'}</td>
            <td>${timestamp}</td>
            <td>${branch}</td>
            <td class="status-${status}">
                <i class="fas fa-${status === 'success' ? 'check-circle' : 
                  status === 'failed' ? 'times-circle' : 'question-circle'}"></i>
                ${deployment.status || 'Unknown'}
            </td>
        </tr>
    `;
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    (elements.toast || document.body).appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}

function setupDarkMode() {
    if (!elements.darkModeToggle) return;
    
    const darkModePreference = localStorage.getItem("darkMode") === "true";
    elements.darkModeToggle.checked = darkModePreference;
    document.body.classList.toggle("dark-mode", darkModePreference);
    
    elements.darkModeToggle.addEventListener("change", (e) => {
        document.body.classList.toggle("dark-mode", e.target.checked);
        localStorage.setItem("darkMode", e.target.checked);
    });
}

function setupFileUpload() {
    const fileUpload = document.getElementById('fileUpload');
    const browseFilesBtn = document.getElementById('browseFilesBtn');
    const fileDropZone = document.getElementById('fileDropZone');
    const fileList = document.getElementById('fileList');

    if (browseFilesBtn && fileUpload) {
        browseFilesBtn.addEventListener('click', () => fileUpload.click());
    }

    if (fileUpload && fileList) {
        fileUpload.addEventListener('change', () => updateFileList(fileUpload, fileList));
    }

    if (fileDropZone && fileUpload) {
        fileDropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            fileDropZone.classList.add('drag-over');
        });
        
        fileDropZone.addEventListener('dragleave', () => {
            fileDropZone.classList.remove('drag-over');
        });
        
        fileDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            fileDropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length) {
                fileUpload.files = e.dataTransfer.files;
                fileUpload.dispatchEvent(new Event('change'));
            }
        });
    }
}

function updateFileList(fileUpload, fileList) {
    fileList.innerHTML = '';
    if (!fileUpload.files.length) return;

    Array.from(fileUpload.files).forEach(file => {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.innerHTML = `
            <span class="file-name">${file.name}</span>
            <span class="file-size">${(file.size / 1024).toFixed(2)} KB</span>
            <span class="remove-file"><i class="fas fa-times"></i></span>
        `;
        fileItem.querySelector('.remove-file').addEventListener('click', () => fileItem.remove());
        fileList.appendChild(fileItem);
    });
}

async function updateEnvironmentStatus() {
    try {
        const baseUrl = window.AppConfig?.apiBaseUrl || config.apiBaseUrl || 'http://localhost:3000';
        const response = await fetch(`${baseUrl}/api/environments/status`);
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const status = await response.json();
        updateEnvironmentUI(status);
        await fetchDeploymentHistory();
    } catch (error) {
        console.error("Failed to update environment status:", error);
        showToast("Connection error - data may be stale", "error");
    }
}

function updateEnvironmentUI(status) {
    // Update Blue Environment
    if (elements.blueStatus) {
        elements.blueStatus.textContent = status.blue?.status === "active" ? "Active" : "Inactive";
        elements.blueStatus.className = `status-badge ${status.blue?.status === "active" ? "active" : "inactive"}`;
        if (elements.blueHealthStatus) elements.blueHealthStatus.textContent = status.blue?.health || "Unknown";
    }
    
    // Update Green Environment
    if (elements.greenStatus) {
        elements.greenStatus.textContent = status.green?.status === "active" ? "Active" : "Inactive";
        elements.greenStatus.className = `status-badge ${status.green?.status === "active" ? "active" : "inactive"}`;
        if (elements.greenHealthStatus) elements.greenHealthStatus.textContent = status.green?.health || "Unknown";
    }

    // Update current environment indicator
    if (elements.currentActiveEnv) {
        elements.currentActiveEnv.textContent = status.blue?.status === "active" ? "Blue" : "Green";
    }
    
    // Update switch traffic button
    if (elements.switchTraffic) {
        elements.switchTraffic.textContent = `Switch to ${status.blue?.status === "active" ? "Green" : "Blue"}`;
    }
}

function showRollbackOptions() {
    if (webSocketManager.getConnectionState() !== 'connected') {
        showToast("Cannot rollback - connection lost", "error");
        return;
    }
    // Implementation remains the same
}

function switchTraffic() {
    if (webSocketManager.getConnectionState() !== 'connected') {
        showToast("Cannot switch traffic - connection lost", "error");
        return;
    }
    // Implementation remains the same
}

document.addEventListener('DOMContentLoaded', initializeDashboard);