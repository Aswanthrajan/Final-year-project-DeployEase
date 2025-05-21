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
    cancelDeployBtn: document.getElementById('cancelDeployBtn'),
    // Added new elements for progress bar
    deploymentProgressBar: document.getElementById('deploymentProgressBar'),
    deploymentStatusText: document.getElementById('deploymentStatusText')
};

// Progress bar state
let progressBarInterval = null;
let isDeploying = false;

// Track original branch assignments for rollback
let originalBranchConfig = {
    blue: 'blue',
    green: 'green',
    isSwapped: false
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
        elements.rollbackButton.addEventListener("click", handleRollback);
    }
    
    if (elements.switchTraffic) {
        elements.switchTraffic.addEventListener("click", switchTraffic);
    }
    
    if (elements.refreshButton) {
        elements.refreshButton.addEventListener("click", () => {
            if (webSocketManager.getConnectionState() === 'connected') {
                updateEnvironmentStatus();
                showToast("Refreshing data...", "info");
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
        // Ensure display property is set to 'none'
        deployModal.style.display = 'none';
        
        // Reset form elements if needed
        const fileList = document.getElementById('fileList');
        if (fileList) fileList.innerHTML = '';
        
        const commitMessage = document.getElementById('commitMessage');
        if (commitMessage) commitMessage.value = '';
    }
}

async function handleDeployment() {
    // Get form values
    const deploymentType = document.getElementById('deploymentType').value;
    const commitMessage = document.getElementById('commitMessage').value;
    const fileInput = document.getElementById('fileUpload');
    const branch = deploymentType === 'NEW' ? 'blue' : 'green';
    
    if (!commitMessage) {
        showToast("Please enter a deployment message", "error");
        return;
    }
    
    if (!fileInput.files.length) {
        showToast("Please select files to deploy", "error");
        return;
    }

    try {
        showToast("Preparing deployment...", "info");
        
        // Process files to match the expected format in the backend
        const processedFiles = [];
        for (const file of fileInput.files) {
            const reader = new FileReader();
            const filePromise = new Promise((resolve, reject) => {
                reader.onload = () => {
                    resolve({
                        path: file.name,
                        content: reader.result
                    });
                };
                reader.onerror = reject;
            });
            
            reader.readAsText(file);
            processedFiles.push(filePromise);
        }
        
        // Wait for all files to be processed
        const files = await Promise.all(processedFiles);
        
        const deploymentData = {
            branch,
            commitMessage,
            files
        };
        
        // First close the modal before initiating deployment
        // This ensures the modal is closed even if there's a delay in the network request
        closeDeployModal();
        
        // Start the deployment progress animation immediately
        // This gives immediate feedback to the user
        startDeploymentProgress();
        
        const baseUrl = window.AppConfig?.apiBaseUrl || config.apiBaseUrl || 'http://localhost:3000';
        const response = await fetch(`${baseUrl}/api/deployments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(deploymentData)
        });

        if (!response.ok) {
            const errorData = await response.json();
            if (errorData.retryAfter) {
                showRetryPrompt(errorData.retryAfter);
            } else {
                throw new Error(errorData.message || errorData.error || "Deployment failed");
            }
            return;
        }

        const result = await response.json();
        showToast(`Deployment to ${branch} started! ${fileInput.files.length} files uploaded`, "success");
        updateEnvironmentStatus();
        
    } catch (error) {
        console.error("Deployment failed:", error);
        showToast(`Deployment failed: ${error.message}`, "error");
        
        // Even if deployment fails, we should ensure the modal is closed
        closeDeployModal();
    }
}

function showRetryPrompt(seconds) {
    const toast = document.createElement('div');
    toast.className = 'toast warning';
    toast.innerHTML = `
        <p>GitHub rate limit exceeded</p>
        <p>Auto-retrying in <span class="countdown">${seconds}</span> seconds</p>
        <button class="retry-now">Retry Now</button>
    `;
    
    const countdown = setInterval(() => {
        seconds--;
        toast.querySelector('.countdown').textContent = seconds;
        if (seconds <= 0) {
            clearInterval(countdown);
            handleDeployment();
        }
    }, 1000);

    toast.querySelector('.retry-now').addEventListener('click', () => {
        clearInterval(countdown);
        handleDeployment();
    });

    (elements.toast || document.body).appendChild(toast);
}

// Function to start the deployment progress animation
function startDeploymentProgress() {
    // Clear any existing interval
    if (progressBarInterval) {
        clearInterval(progressBarInterval);
    }
    
    // Reset progress bar state
    isDeploying = true;
    const progressBar = elements.deploymentProgressBar;
    const statusText = elements.deploymentStatusText;
    
    if (!progressBar || !statusText) return;
    
    // Set initial states
    progressBar.style.width = '0%';
    progressBar.classList.remove('complete');
    statusText.textContent = 'Deploying...';
    
    // Calculate a random duration between 15-55 seconds
    const duration = Math.floor(Math.random() * (55 - 15 + 1)) + 15; // 15-55 seconds
    const intervalTime = 100; // Update every 100ms for smooth animation
    const steps = (duration * 1000) / intervalTime;
    let currentStep = 0;
    
    progressBarInterval = setInterval(() => {
        currentStep++;
        const progress = Math.min((currentStep / steps) * 100, 100);
        
        progressBar.style.width = `${progress}%`;
        
        // When progress reaches 100%
        if (progress >= 100) {
            clearInterval(progressBarInterval);
            progressBar.classList.add('complete');
            statusText.textContent = 'Deployment Complete';
            isDeploying = false;
            
            // After a delay, reset the progress bar
            setTimeout(() => {
                if (!isDeploying) {
                    statusText.textContent = 'Ready';
                    progressBar.style.width = '0%';
                }
            }, 5000);
        }
    }, intervalTime);
}

async function switchTraffic() {
    if (webSocketManager.getConnectionState() !== 'connected') {
        showToast("Cannot switch traffic - connection lost", "error");
        return;
    }

    try {
        const targetBranch = getInactiveEnvironment();
        showToast(`Switching traffic to ${targetBranch}...`, "info");
        
        const baseUrl = window.AppConfig?.apiBaseUrl || config.apiBaseUrl || 'http://localhost:3000';
        const response = await fetch(`${baseUrl}/api/environments/switch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ targetBranch })
        });

        if (!response.ok) throw new Error(await response.text());

        const result = await response.json();
        
        // Track that branches are swapped for proper rollback functionality
        originalBranchConfig.isSwapped = !originalBranchConfig.isSwapped;
        
        // Update rollback button state
        updateRollbackButtonState();
        
        showToast(`Traffic switched to ${result.activeEnvironment}`, "success");
        updateEnvironmentStatus();
        
        // Start progress bar for the switch operation
        startDeploymentProgress();
    } catch (error) {
        console.error("Failed to switch traffic:", error);
        showToast(`Switch failed: ${error.message}`, "error");
    }
}

function updateRollbackButtonState() {
    if (elements.rollbackButton) {
        // Enable rollback button if branches are swapped, disable if in original state
        if (originalBranchConfig.isSwapped) {
            elements.rollbackButton.disabled = false;
            elements.rollbackButton.classList.remove('disabled');
            elements.rollbackButton.title = "Rollback to original branch configuration";
        } else {
            elements.rollbackButton.disabled = true;
            elements.rollbackButton.classList.add('disabled');
            elements.rollbackButton.title = "Currently in original configuration";
        }
    }
}

async function handleRollback() {
    if (!originalBranchConfig.isSwapped) {
        showToast("Already in original configuration", "info");
        return;
    }
    
    if (webSocketManager.getConnectionState() !== 'connected') {
        showToast("Cannot rollback - connection lost", "error");
        return;
    }

    try {
        // Get original active branch (before any swaps)
        const originalActiveBranch = 'blue'; // Default to blue as original active branch
        
        showToast(`Rolling back to original configuration...`, "info");
        
        const baseUrl = window.AppConfig?.apiBaseUrl || config.apiBaseUrl || 'http://localhost:3000';
        const response = await fetch(`${baseUrl}/api/environments/switch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ targetBranch: originalActiveBranch })
        });

        if (!response.ok) throw new Error(await response.text());

        const result = await response.json();
        
        // Reset the swap flag
        originalBranchConfig.isSwapped = false;
        
        // Update rollback button state
        updateRollbackButtonState();
        
        showToast(`Successfully rolled back to original configuration`, "success");
        updateEnvironmentStatus();
        
        // Start the deployment progress for rollback
        startDeploymentProgress();
    } catch (error) {
        console.error("Rollback failed:", error);
        showToast(`Rollback failed: ${error.message}`, "error");
    }
}

async function showRollbackOptions() {
    if (webSocketManager.getConnectionState() !== 'connected') {
        showToast("Cannot rollback - connection lost", "error");
        return;
    }

    try {
        const branch = getInactiveEnvironment();
        showToast(`Fetching rollback points for ${branch}...`, "info");
        
        const baseUrl = window.AppConfig?.apiBaseUrl || config.apiBaseUrl || 'http://localhost:3000';
        const response = await fetch(`${baseUrl}/api/deployments/history/${branch}`);
        
        if (!response.ok) throw new Error(await response.text());
        
        const rollbackPoints = await response.json();
        
        if (!rollbackPoints.length) {
            showToast("No rollback points available", "info");
        }
        
        showRollbackSelectionUI(rollbackPoints, branch);
    } catch (error) {
        console.error("Failed to get rollback options:", error);
        showToast(`Failed to get rollback options: ${error.message}`, "error");
    }
}

function showRollbackSelectionUI(rollbackPoints, branch) {
    // Create modal
    const modal = document.createElement('div');
    modal.className = 'rollback-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <h3>Rollback ${branch.toUpperCase()} to:</h3>
            <ul class="rollback-list">
                ${rollbackPoints.map(point => `
                    <li>
                        <button class="rollback-point" data-sha="${point.commitSha || point.id}">
                            <strong>${new Date(point.timestamp).toLocaleString()}</strong><br>
                            ${point.commitMessage || point.message || 'No message'} (${(point.commitSha || point.id || '').slice(0, 7)})
                        </button>
                    </li>
                `).join('')}
            </ul>
            <button class="cancel-rollback secondary-button">Cancel</button>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Add event listeners
    modal.querySelectorAll('.rollback-point').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const sha = e.currentTarget.dataset.sha;
            await performRollback(branch, sha);
            modal.remove();
        });
    });
    
    modal.querySelector('.cancel-rollback').addEventListener('click', () => {
        modal.remove();
    });
}

async function performRollback(branch, commitSha) {
    try {
        showToast(`Rolling back ${branch}...`, "info");
        const baseUrl = window.AppConfig?.apiBaseUrl || config.apiBaseUrl || 'http://localhost:3000';
        const response = await fetch(`${baseUrl}/api/deployments/rollback/${branch}/${commitSha}`, {
            method: 'POST'
        });

        if (!response.ok) throw new Error(await response.text());

        showToast(`Successfully rolled back ${branch}`, "success");
        updateEnvironmentStatus();
        
        // Start the deployment progress for rollback
        startDeploymentProgress();
    } catch (error) {
        console.error("Rollback failed:", error);
        showToast(`Rollback failed: ${error.message}`, "error");
    }
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
    const id = deployment.id || deployment.commitSha?.slice(0, 7) || 'N/A';
    
    return `
        <tr>
            <td>${id}</td>
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
        
        // Update rollback button state based on environment status
        updateRollbackButtonState();
        
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

    // Update current environment indicator - make it dynamic
    const activeEnvironment = status.blue?.status === "active" ? "Blue" : "Green";
    if (elements.currentActiveEnv) {
        elements.currentActiveEnv.textContent = activeEnvironment;
    }
    
    // Update switch traffic button
    if (elements.switchTraffic) {
        elements.switchTraffic.textContent = `Switch to ${status.blue?.status === "active" ? "Green" : "Blue"}`;
    }
}

document.addEventListener('DOMContentLoaded', initializeDashboard);