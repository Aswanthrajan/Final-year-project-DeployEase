import config from './config.js';

// ==================== Core Functions ====================
const REFRESH_INTERVAL = 30000; // 30 seconds
let refreshIntervalId = null;
let isInitialLoad = true;

// DOM Elements Cache
const elements = {
    blueStatus: null,
    greenStatus: null,
    blueVersion: null,
    greenVersion: null,
    blueReplicas: null,
    greenReplicas: null,
    switchTraffic: null,
    rollbackButton: null,
    refreshButton: null,
    darkModeToggle: null,
    toast: null,
    deployModal: null
};

// Initialize DOM elements with null checks
function initializeElements() {
    elements.blueStatus = document.getElementById("blueStatus");
    elements.greenStatus = document.getElementById("greenStatus");
    elements.blueVersion = document.getElementById("blueVersion");
    elements.greenVersion = document.getElementById("greenVersion");
    elements.blueReplicas = document.getElementById("blueReplicas");
    elements.greenReplicas = document.getElementById("greenReplicas");
    elements.switchTraffic = document.getElementById("switchTraffic");
    elements.rollbackButton = document.getElementById("rollbackButton");
    elements.refreshButton = document.getElementById("refreshButton");
    elements.darkModeToggle = document.getElementById("darkModeToggle");
    elements.toast = document.getElementById('toast') || document.body;
    elements.deployModal = document.getElementById('deployModal');
}

// Improved refresh guard
function setupRefreshGuard() {
    if (sessionStorage.getItem('refreshBlocked')) {
        sessionStorage.removeItem('refreshBlocked');
    } else if (isInitialLoad) {
        sessionStorage.setItem('refreshBlocked', 'true');
        location.reload();
        return false; // Stop execution if reloading
    }
    return true;
}

async function fetchEnvironmentStatus(retries = 3) {
    try {
        const response = await fetch(`${config.apiBaseUrl}/api/environments/status`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        console.error("Fetch error:", error);
        if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return fetchEnvironmentStatus(retries - 1);
        }
        return { 
            blue: { status: "Error", version: "N/A", replicas: "0/0" },
            green: { status: "Error", version: "N/A", replicas: "0/0" }
        };
    }
}

async function updateEnvironmentStatus() {
    try {
        const status = await fetchEnvironmentStatus();
        
        // Update Blue Environment
        if (elements.blueStatus) {
            elements.blueStatus.textContent = status.blue?.status || "Error";
            elements.blueStatus.className = `status-badge ${status.blue?.status === "active" ? "active" : "inactive"}`;
            
            if (elements.blueVersion) elements.blueVersion.textContent = status.blue?.version || "N/A";
            if (elements.blueReplicas) elements.blueReplicas.textContent = status.blue?.replicas || "0/0";
        }
        
        // Update Green Environment
        if (elements.greenStatus) {
            elements.greenStatus.textContent = status.green?.status || "Error";
            elements.greenStatus.className = `status-badge ${status.green?.status === "active" ? "active" : "inactive"}`;
            
            if (elements.greenVersion) elements.greenVersion.textContent = status.green?.version || "N/A";
            if (elements.greenReplicas) elements.greenReplicas.textContent = status.green?.replicas || "0/0";
        }
        
    } catch (error) {
        console.error("Update error:", error);
    }
}

// ==================== Deployment Functions ====================
async function showDeployModal() {
    if (!elements.deployModal) return;
    
    elements.deployModal.style.display = 'flex';

    // Set up modal close button
    const closeBtn = elements.deployModal.querySelector('.close-modal');
    if (closeBtn) {
        closeBtn.onclick = () => {
            elements.deployModal.style.display = 'none';
        };
    }

    // Set up cancel button
    const cancelBtn = document.getElementById('cancelDeployBtn');
    if (cancelBtn) {
        cancelBtn.onclick = () => {
            elements.deployModal.style.display = 'none';
        };
    }

    // Set up deploy button
    const deployBtn = document.getElementById('confirmDeployBtn');
    if (deployBtn) {
        deployBtn.onclick = async () => {
            const image = document.getElementById('deployImage')?.value;
            const environment = document.getElementById('deployEnvironment')?.value;
            const replicas = document.getElementById('deployReplicas')?.value;
            const switchAfter = document.getElementById('switchAfterDeploy')?.checked;

            try {
                deployBtn.disabled = true;
                deployBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deploying...';

                const response = await fetch(`${config.apiBaseUrl}/api/deployments`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        image, 
                        environment: environment === 'auto' ? getInactiveEnvironment() : environment,
                        replicas 
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.message || 'Deployment failed');
                }
                
                const result = await response.json();
                showToast(`Deployed: ${result.message}`, 'success');
                
                if (switchAfter) {
                    await switchTraffic();
                }
                
                elements.deployModal.style.display = 'none';
                await updateEnvironmentStatus();
            } catch (error) {
                showToast(`Error: ${error.message}`, 'error');
            } finally {
                deployBtn.disabled = false;
                deployBtn.textContent = 'Deploy';
            }
        };
    }
}

function getInactiveEnvironment() {
    return elements.blueStatus?.classList.contains('active') ? 'green' : 'blue';
}

// ==================== Rollback Functions ====================
async function showRollbackOptions() {
    try {
        const environment = getInactiveEnvironment();
        const response = await fetch(
            `${config.apiBaseUrl}/api/deployments/history/${environment}`
        );
        
        if (!response.ok) {
            throw new Error('Failed to fetch deployment history');
        }
        
        const history = await response.json();

        // Create modal for rollback options
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h4>Rollback ${environment} Environment</h4>
                    <button class="close-modal">&times;</button>
                </div>
                <div class="modal-body">
                    ${history.length === 0 
                        ? '<p>No deployment history available</p>' 
                        : `
                        <table>
                            <thead>
                                <tr>
                                    <th>Revision</th>
                                    <th>Change Cause</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${history.map(item => `
                                    <tr>
                                        <td>${item.revision}</td>
                                        <td>${item.changeCause || 'N/A'}</td>
                                        <td>
                                            <button class="rollback-btn" 
                                                data-revision="${item.revision}">
                                                Rollback
                                            </button>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                        `}
                </div>
                <div class="modal-footer">
                    <button class="secondary-button close-modal">Cancel</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Add event listeners
        modal.querySelector('.close-modal')?.addEventListener('click', () => {
            modal.remove();
        });

        modal.querySelectorAll('.rollback-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    btn.disabled = true;
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

                    const revision = btn.dataset.revision;
                    const response = await fetch(
                        `${config.apiBaseUrl}/api/deployments/rollback/${environment}/${revision}`,
                        { method: 'POST' }
                    );

                    if (!response.ok) {
                        const errorData = await response.json();
                        throw new Error(errorData.message || 'Rollback failed');
                    }

                    const result = await response.json();
                    showToast(`Rollback successful: ${result.message}`, 'success');
                    modal.remove();
                    await updateEnvironmentStatus();
                } catch (error) {
                    showToast(`Rollback failed: ${error.message}`, 'error');
                    btn.disabled = false;
                    btn.textContent = 'Rollback';
                }
            });
        });

    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

// ==================== Traffic Switching ====================
async function switchTraffic() {
    if (!elements.switchTraffic) return;
    
    const originalText = elements.switchTraffic.innerHTML;
    const targetBranch = getInactiveEnvironment();
    
    try {
        elements.switchTraffic.disabled = true;
        elements.switchTraffic.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Switching...';
        
        const response = await fetch(`${config.apiBaseUrl}/api/environments/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetBranch }) // Added proper payload
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || "Switch failed");
        }
        
        const result = await response.json();
        showToast(`Success: ${result.message}`, 'success');
        await updateEnvironmentStatus();
        
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        console.error("Switch error:", error);
    } finally {
        elements.switchTraffic.disabled = false;
        elements.switchTraffic.innerHTML = originalText;
    }
}

// ==================== UI Helpers ====================
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toast.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}

// ==================== Initialization ====================
function initializeDashboard() {
    initializeElements(); // Initialize all DOM elements first
    
    if (!setupRefreshGuard()) return;
    
    // Button event listeners with null checks
    elements.rollbackButton?.addEventListener("click", showRollbackOptions);
    elements.switchTraffic?.addEventListener("click", switchTraffic);
    elements.refreshButton?.addEventListener("click", updateEnvironmentStatus);
    
    // Initialize dark mode toggle
    if (elements.darkModeToggle) {
        const darkModePreference = localStorage.getItem("darkMode") === "true";
        elements.darkModeToggle.checked = darkModePreference;
        document.body.classList.toggle("dark-mode", darkModePreference);
        
        elements.darkModeToggle.addEventListener("change", (e) => {
            document.body.classList.toggle("dark-mode", e.target.checked);
            localStorage.setItem("darkMode", e.target.checked);
        });
    }
    
    // Initial data load
    updateEnvironmentStatus();
    
    // Auto-refresh with cleanup
    refreshIntervalId = setInterval(updateEnvironmentStatus, REFRESH_INTERVAL);
    
    // Cleanup
    window.addEventListener('beforeunload', () => {
        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
        }
    });
    
    isInitialLoad = false;
}

document.addEventListener('DOMContentLoaded', initializeDashboard);