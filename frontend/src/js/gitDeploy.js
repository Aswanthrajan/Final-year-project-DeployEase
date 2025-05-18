/**
 * GitDeployer class for handling Git-based deployments
 */
class GitDeployer {
    /**
     * Constructor for the GitDeployer class
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
        try {
            console.log('Dashboard initialized with config:', config);
            
            // Configuration
            this.apiBaseUrl = config.apiBaseUrl || 'http://localhost:3000';
            this.websocketUrl = config.websocketUrl || 'ws://localhost:3000/deployease';
            
            // State
            this.deployInProgress = false;
            this.currentEnvironment = 'dev';
            this.socket = null;
            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = 5; // Maximum 5 retry attempts
            this.reconnectDelay = 2000;
            this.selectedFile = null;
            
            // Initialize after DOM is fully loaded
            if (document.readyState === 'complete') {
                this.initialize();
            } else {
                document.addEventListener('DOMContentLoaded', () => this.initialize());
            }
        } catch (error) {
            console.error('Error initializing GitDeployer:', error);
        }
    }

    /**
     * Main initialization method
     */
    initialize() {
        try {
            // DOM Elements - Find them once to avoid repeated DOM queries
            this.initDomElements();
            
            // Initialize event listeners
            this.initEventListeners();
            
            // Connect to WebSocket for real-time updates
            this.connectWebSocket();
            
            // Load initial data
            this.loadInitialData();
            
            console.log('GitDeployer initialized');
        } catch (error) {
            console.error('Error during initialization:', error);
        }
    }
    
    /**
     * Initialize DOM element references
     */
    initDomElements() {
        try {
            // Main container elements
            this.deployModal = document.getElementById('deployModal');
            this.deployForm = document.getElementById('deployForm');
            this.fileDropArea = document.getElementById('fileDropZone');
            this.fileInput = document.getElementById('fileUpload');
            this.selectedFileDisplay = document.getElementById('fileList');
            this.deployBtn = document.getElementById('newDeploymentBtn');
            this.cancelDeployBtn = document.getElementById('cancelDeployBtn');
            this.deployConfirmBtn = document.getElementById('confirmDeployBtn');
            this.environmentSwitcher = document.getElementById('deploymentType');
            this.deploymentsList = document.getElementById('deploymentHistoryTableBody');
            this.statusIndicator = document.querySelector('.environment-status');
            this.deploySpinner = document.createElement('div'); // Will be added dynamically if needed
            this.toastContainer = document.getElementById('toast') || document.body;
            
            // Check if critical elements are missing
            const criticalElements = [this.deployForm, this.fileInput];
            const missingElements = criticalElements.filter(el => !el);
            
            if (missingElements.length > 0) {
                console.error('Critical DOM elements are missing. Check your HTML structure.');
                this.showToast('Application initialization error. Some features may not work.', 'error');
            }
        } catch (error) {
            console.error('Error initializing DOM elements:', error);
        }
    }
    
    /**
     * Initialize event listeners for all interactive elements
     */
    initEventListeners() {
        try {
            // Deploy button to show modal
            if (this.deployBtn) {
                this.deployBtn.addEventListener('click', () => this.showModal());
            }
            
            // Cancel button to hide modal
            if (this.cancelDeployBtn) {
                this.cancelDeployBtn.addEventListener('click', () => this.hideModal());
            }
            
            // Deploy confirmation button
            if (this.deployConfirmBtn) {
                this.deployConfirmBtn.addEventListener('click', () => this.handleDeploy());
            }
            
            // File input change event
            if (this.fileInput) {
                this.fileInput.addEventListener('change', (event) => this.handleFileSelect(event));
            }
            
            // File drop area drag and drop events
            if (this.fileDropArea) {
                this.fileDropArea.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.fileDropArea.classList.add('dragover');
                });
                
                this.fileDropArea.addEventListener('dragleave', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.fileDropArea.classList.remove('dragover');
                });
                
                this.fileDropArea.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.fileDropArea.classList.remove('dragover');
                    
                    const files = e.dataTransfer.files;
                    if (files.length > 0) {
                        this.fileInput.files = files;
                        this.handleFileSelect({ target: this.fileInput });
                    }
                });
                
                this.fileDropArea.addEventListener('click', () => {
                    this.fileInput.click();
                });
            }
            
            // Environment switcher
            if (this.environmentSwitcher) {
                this.environmentSwitcher.addEventListener('change', (event) => {
                    this.switchEnvironment(event.target.value);
                });
            }
            
            // Form submission prevention
            if (this.deployForm) {
                this.deployForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    return false;
                });
            }
            
            console.log('Event listeners initialized successfully');
        } catch (error) {
            console.error('Error initializing event listeners:', error);
        }
    }
    
    /**
     * Connect to WebSocket for real-time updates
     */
    connectWebSocket() {
        try {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.log('Max reconnection attempts reached. Manual refresh required.');
                this.showToast('Connection failed. Please refresh the page.', 'error');
                return;
            }

            console.log('🔌 Connecting to ' + this.websocketUrl + '...');
            this.socket = new WebSocket(this.websocketUrl);
            
            this.socket.onopen = () => {
                console.log('✅ Connected to deployment logs');
                this.reconnectAttempts = 0;
                try {
                    this.socket.send(JSON.stringify({ type: 'subscribe', data: { channel: 'deployments' } }));
                } catch (e) {
                    console.error('Error sending subscription message:', e);
                }
            };
            
            this.socket.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    console.log('WebSocket message received:', message);
                    
                    switch (message.type) {
                        case 'deployment_status':
                            this.updateDeploymentStatus(message.data);
                            break;
                        case 'deployment_complete':
                            this.handleDeploymentComplete(message.data);
                            break;
                        case 'deployment_error':
                            this.handleDeploymentError(message.data);
                            break;
                        case 'environment_status':
                            this.updateEnvironmentStatus(message.data);
                            break;
                        default:
                            console.log('Unknown message type:', message.type);
                    }
                } catch (err) {
                    console.error('Error processing WebSocket message:', err);
                }
            };
            
            this.socket.onclose = (event) => {
                const reason = event.reason || 'Unknown reason';
                console.log(`WebSocket connection closed: Code ${event.code} - ${reason}`);
                
                // Don't automatically reconnect if closure was intentional (codes 1000, 1001)
                if (event.code !== 1000 && event.code !== 1001) {
                    this.handleWebSocketDisconnect(event);
                }
            };
            
            this.socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.handleWebSocketDisconnect();
            };
        } catch (error) {
            console.error('Error connecting to WebSocket:', error);
            this.handleWebSocketDisconnect();
        }
    }
    
    /**
     * Handle WebSocket disconnection with limited reconnection attempts
     */
    handleWebSocketDisconnect(event = {}) {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const code = event.code ? ` (Code: ${event.code})` : '';
            console.log(`WebSocket disconnected${code}. Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
            
            setTimeout(() => {
                this.connectWebSocket();
            }, this.reconnectDelay);
        } else {
            console.error('Maximum reconnection attempts reached. WebSocket connection failed.');
            this.showToast('Connection to server lost. Please refresh the page manually.', 'error');
        }
    }
    
    /**
     * Load initial data from the API
     */
    loadInitialData() {
        try {
            this.fetchDeploymentHistory();
            this.fetchEnvironmentStatus();
        } catch (error) {
            console.error('Error loading initial data:', error);
        }
    }
    
    /**
     * Fetch deployment history from the API
     */
    fetchDeploymentHistory() {
        console.log(`\n           GET ${this.apiBaseUrl}/api/deployments/history/all`);
        fetch(`${this.apiBaseUrl}/api/deployments/history/all`)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                console.log('Deployment history:', data);
                this.renderDeploymentHistory(Array.isArray(data) ? data : []);
            })
            .catch(error => {
                console.error('Error fetching deployment history:', error);
                // Display empty state instead of crashing
                if (this.deploymentsList) {
                    this.deploymentsList.innerHTML = '<tr><td colspan="4" class="error-state">Could not load deployments</td></tr>';
                }
            });
    }
    
    /**
     * Fetch environment status from the API
     */
    fetchEnvironmentStatus() {
        console.log(`\n           GET ${this.apiBaseUrl}/api/environments/status`);
        fetch(`${this.apiBaseUrl}/api/environments/status`)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                console.log('Environment status:', data);
                this.updateEnvironmentStatus(data);
            })
            .catch(error => {
                console.error('Error fetching environment status:', error);
                // Display error state instead of crashing
                if (this.statusIndicator) {
                    this.statusIndicator.innerHTML = '<div class="error-state">Status unavailable</div>';
                }
            });
    }
    
    /**
     * Render deployment history in the UI
     * @param {Array} deployments - List of deployments
     */
    renderDeploymentHistory(deployments) {
        if (!this.deploymentsList) return;
        
        this.deploymentsList.innerHTML = '';
        
        if (!Array.isArray(deployments) || deployments.length === 0) {
            const emptyMessage = document.createElement('tr');
            emptyMessage.innerHTML = '<td colspan="4" class="empty-state">No deployments found</td>';
            this.deploymentsList.appendChild(emptyMessage);
            return;
        }
        
        deployments.forEach(deployment => {
            try {
                const deploymentItem = document.createElement('tr');
                deploymentItem.className = `deployment-item ${(deployment.status || '').toLowerCase()}`;
                
                const timestamp = deployment.timestamp ? new Date(deployment.timestamp).toLocaleString() : 'Unknown date';
                const environment = (deployment.environment || 'unknown').toUpperCase();
                
                deploymentItem.innerHTML = `
                    <td>#${deployment.id || 'N/A'}</td>
                    <td>${timestamp}</td>
                    <td>${environment}</td>
                    <td class="status-${(deployment.status || 'unknown').toLowerCase()}">
                        ${deployment.status || 'Unknown'}
                    </td>
                `;
                
                this.deploymentsList.appendChild(deploymentItem);
            } catch (err) {
                console.error('Error rendering deployment item:', err);
            }
        });
    }
    
    /**
     * Update environment status in the UI
     * @param {Object} status - Environment status data
     */
    updateEnvironmentStatus(status) {
        if (!this.statusIndicator) return;
        
        try {
            // This updates the main environment status cards
            const blueStatus = document.getElementById('blueStatus');
            const greenStatus = document.getElementById('greenStatus');
            const blueHealth = document.getElementById('blueHealthStatus');
            const greenHealth = document.getElementById('greenHealthStatus');
            
            if (blueStatus && greenStatus) {
                if (status.blue?.status === 'active') {
                    blueStatus.textContent = 'Active';
                    blueStatus.className = 'status-badge active';
                    greenStatus.textContent = 'Inactive';
                    greenStatus.className = 'status-badge inactive';
                } else if (status.green?.status === 'active') {
                    blueStatus.textContent = 'Inactive';
                    blueStatus.className = 'status-badge inactive';
                    greenStatus.textContent = 'Active';
                    greenStatus.className = 'status-badge active';
                }
            }
            
            if (blueHealth && status.blue) {
                blueHealth.textContent = status.blue.health || 'Unknown';
            }
            
            if (greenHealth && status.green) {
                greenHealth.textContent = status.green.health || 'Unknown';
            }
        } catch (err) {
            console.error('Error updating environment status:', err);
        }
    }
    
    /**
     * Show the deployment modal
     */
    showModal() {
        if (!this.deployModal) return;
        
        this.resetModal();
        this.deployModal.classList.add('show');
        document.body.classList.add('modal-open');
    }
    
    /**
     * Hide the deployment modal
     */
    hideModal() {
        if (!this.deployModal) return;
        
        this.deployModal.classList.remove('show');
        document.body.classList.remove('modal-open');
        this.resetModal();
    }
    
    /**
     * Reset the modal state
     */
    resetModal() {
        if (this.fileInput) this.fileInput.value = '';
        if (this.selectedFileDisplay) this.selectedFileDisplay.innerHTML = '';
        this.selectedFile = null;
        
        if (this.deployConfirmBtn) {
            this.deployConfirmBtn.disabled = true;
            this.deployConfirmBtn.textContent = 'Deploy';
        }
        
        if (this.fileDropArea) {
            this.fileDropArea.classList.remove('has-file');
            this.fileDropArea.classList.remove('dragover');
        }
    }
    
    /**
     * Handle file selection
     * @param {Event} event - File input change event
     */
    handleFileSelect(event) {
        if (!event || !event.target || !event.target.files) {
            console.error('Invalid file selection event');
            return;
        }
        
        const files = event.target.files;
        
        if (files.length > 0) {
            const file = files[0];
            
            // Check if it's a zip or tar.gz file
            if (!/\.(zip|tar\.gz|tgz)$/i.test(file.name)) {
                this.showToast('Please select a .zip or .tar.gz file', 'error');
                this.resetModal();
                return;
            }
            
            this.selectedFile = file;
            
            if (this.selectedFileDisplay) {
                this.selectedFileDisplay.innerHTML = `
                    <div class="file-item">
                        <span class="file-name">${file.name}</span>
                        <span class="file-size">${(file.size / 1024).toFixed(2)} KB</span>
                        <span class="remove-file" onclick="this.parentNode.remove()"><i class="fas fa-times"></i></span>
                    </div>
                `;
            }
            
            if (this.fileDropArea) {
                this.fileDropArea.classList.add('has-file');
            }
            
            if (this.deployConfirmBtn) {
                this.deployConfirmBtn.disabled = false;
            }
        }
    }
    
    /**
     * Handle the deployment process
     */
    handleDeploy() {
        if (!this.selectedFile || this.deployInProgress) return;
        
        this.deployInProgress = true;
        
        if (this.deployConfirmBtn) {
            this.deployConfirmBtn.disabled = true;
            this.deployConfirmBtn.textContent = 'Deploying...';
        }
        
        const formData = new FormData();
        formData.append('file', this.selectedFile);
        formData.append('environment', this.currentEnvironment);
        
        fetch(`${this.apiBaseUrl}/api/deployments/upload`, {
            method: 'POST',
            body: formData
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }
            return response.json();
        })
        .then(data => {
            console.log('Deployment initiated:', data);
            this.showToast(`Deployment #${data.deploymentId || 'unknown'} initiated`, 'success');
            
            // The rest of the process will be handled via WebSocket updates
            this.hideModal();
        })
        .catch(error => {
            console.error('Deployment error:', error);
            this.showToast('Deployment failed: ' + error.message, 'error');
            this.deployInProgress = false;
            
            if (this.deployConfirmBtn) {
                this.deployConfirmBtn.disabled = false;
                this.deployConfirmBtn.textContent = 'Deploy';
            }
        });
    }
    
    /**
     * Update deployment status based on WebSocket messages
     * @param {Object} data - Deployment status data
     */
    updateDeploymentStatus(data) {
        console.log('Updating deployment status:', data);
        
        // Refresh the deployment history list - but only if we have proper data
        if (data && (data.deploymentId || data.status)) {
            this.fetchDeploymentHistory();
        }
    }
    
    /**
     * Handle deployment completion
     * @param {Object} data - Deployment completion data
     */
    handleDeploymentComplete(data) {
        console.log('Deployment complete:', data);
        
        this.deployInProgress = false;
        
        this.showToast(`Deployment #${data?.deploymentId || 'unknown'} completed successfully`, 'success');
        
        // Refresh data
        this.fetchDeploymentHistory();
        this.fetchEnvironmentStatus();
    }
    
    /**
     * Handle deployment errors
     * @param {Object} data - Deployment error data
     */
    handleDeploymentError(data) {
        console.error('Deployment error:', data);
        
        this.deployInProgress = false;
        
        this.showToast(`Deployment #${data?.deploymentId || 'unknown'} failed: ${data?.error || 'Unknown error'}`, 'error');
        
        // Refresh data
        this.fetchDeploymentHistory();
    }
    
    /**
     * Switch to a different environment
     * @param {string} environment - Target environment (dev, stage, prod)
     */
    switchEnvironment(environment) {
        if (['NEW', 'UPDATE'].includes(environment)) {
            this.currentEnvironment = environment === 'NEW' ? 'blue' : 'green';
            console.log(`Switched to ${this.currentEnvironment} environment`);
        }
    }
    
    /**
     * Display a toast notification
     * @param {string} message - Toast message
     * @param {string} type - Toast type (success, error, warning, info)
     */
    showToast(message, type = 'info') {
        if (!this.toastContainer) {
            console.error('Toast container not found');
            return;
        }
        
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <div class="toast-content">
                <span class="toast-message">${message}</span>
            </div>
        `;
        
        this.toastContainer.appendChild(toast);
        
        // Show toast
        setTimeout(() => {
            toast.classList.add('show');
        }, 10);
        
        // Auto-hide toast after 5 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode === this.toastContainer) {
                    this.toastContainer.removeChild(toast);
                }
            }, 300);
        }, 5000);
    }
}

// Initialize GitDeployer when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    try {
        // Create instance with configuration
        window.gitDeployer = new GitDeployer({
            apiBaseUrl: window.AppConfig?.apiBaseUrl || 'http://localhost:3000',
            websocketUrl: window.AppConfig?.websocketUrl || 'ws://localhost:3000/deployease'
        });
    } catch (error) {
        console.error('Failed to initialize GitDeployer:', error);
        // Show error message to user without refreshing
        const errorContainer = document.createElement('div');
        errorContainer.className = 'error-message';
        errorContainer.textContent = 'An error occurred while initializing the application. Please check the console for details.';
        document.body.appendChild(errorContainer);
    }
});