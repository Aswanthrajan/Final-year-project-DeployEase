import config from './config.js';

class GitDeployer {
    constructor() {
        console.log('Initializing GitDeployer...');
        this.initializeElements();
        this.uploadedFiles = [];
        this.isDeploying = false;
        this.ws = null;
        this.wsReconnectAttempts = 0;
        this.maxWsReconnectAttempts = 5;
        
        this.initEventListeners();
        this.loadInitialData();
        this.initWebSocket();
    }

    initializeElements() {
        this.elements = {
            modal: document.getElementById('deployModal'),
            deployForm: document.getElementById('deployForm'),
            deploymentType: document.getElementById('deploymentType'),
            fileUpload: document.getElementById('fileUpload'),
            fileDropZone: document.getElementById('fileDropZone'),
            fileList: document.getElementById('fileList'),
            commitMessage: document.getElementById('commitMessage'),
            confirmBtn: document.getElementById('confirmDeployBtn'),
            cancelBtn: document.getElementById('cancelDeployBtn'),
            switchBtn: document.getElementById('switchTraffic'),
            logContent: document.getElementById('logContent'),
            toastContainer: document.getElementById('toast') || document.body,
            blueStatus: document.getElementById('blueStatus'),
            greenStatus: document.getElementById('greenStatus'),
            blueVersion: document.getElementById('blueVersion'),
            greenVersion: document.getElementById('greenVersion'),
            blueReplicas: document.getElementById('blueReplicas'),
            greenReplicas: document.getElementById('greenReplicas'),
            deploymentHistoryTable: document.getElementById('deploymentHistoryTableBody'),
            recentDeploymentsTable: document.getElementById('deploymentsTableBody')
        };
    }

    initWebSocket() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.ws = new WebSocket(config.websocketUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.wsReconnectAttempts = 0;
            
            // Send initial handshake
            this.ws.send(JSON.stringify({
                type: "subscribe",
                channels: ["deployment_logs"],
                client: "deployease-web",
                timestamp: Date.now()
            }));

            // Clear log content on new connection
            if (this.elements.logContent) {
                this.elements.logContent.textContent = '✅ Connected to deployment logs\n';
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleWsMessage(data);
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.showToast('Connection error', 'error');
        };

        this.ws.onclose = (event) => {
            if (event.code === 1000) return;

            if (this.wsReconnectAttempts < this.maxWsReconnectAttempts) {
                const delay = Math.min(3000 * Math.pow(2, this.wsReconnectAttempts), 30000);
                console.log(`Reconnecting in ${delay/1000} seconds...`);
                
                setTimeout(() => {
                    this.wsReconnectAttempts++;
                    this.initWebSocket();
                }, delay);
            } else {
                console.error('Max reconnection attempts reached');
                this.showToast('Disconnected from logs', 'error');
            }
        };
    }

    handleWsMessage(data) {
        if (!this.elements.logContent) return;

        // Skip connection acknowledgements
        if (data.type === "connection_ack" || data.type === "subscription_ack") {
            return;
        }

        // Format timestamp for display
        const timestamp = data.timestamp ? 
            new Date(data.timestamp).toLocaleTimeString() : 
            new Date().toLocaleTimeString();

        // Handle different message types
        switch(data.type) {
            case "log":
                this.elements.logContent.textContent += `[${timestamp}] ${data.message}\n`;
                break;
            case "system":
                this.elements.logContent.textContent += `[${timestamp}] SYSTEM: ${data.message}\n`;
                break;
            case "deploy_status":
                this.showToast(`Deployment ${data.status}: ${data.message}`, 
                             data.status === 'success' ? 'success' : 'error');
                this.elements.logContent.textContent += `[${timestamp}] DEPLOYMENT: ${data.message}\n`;
                if (data.status === 'success' || data.status === 'failed') {
                    this.loadInitialData();
                }
                break;
            default:
                console.log('Unhandled message type:', data.type, data);
        }

        // Scroll to bottom
        this.elements.logContent.scrollTop = this.elements.logContent.scrollHeight;
    }

    initEventListeners() {
        console.log('Initializing event listeners...');
        
        document.querySelectorAll('#newDeploymentBtn, #newDeploymentBtn2').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.showModal();
            });
        });

        this.elements.fileUpload?.addEventListener('change', (e) => {
            this.handleFileSelect(e);
        });
        
        this.elements.fileDropZone?.addEventListener('click', () => {
            this.elements.fileUpload?.click();
        });
        
        const handleDrag = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        
        this.elements.fileDropZone?.addEventListener('dragover', (e) => {
            handleDrag(e);
            this.elements.fileDropZone?.classList.add('dragover');
        });
        
        this.elements.fileDropZone?.addEventListener('dragleave', () => {
            this.elements.fileDropZone?.classList.remove('dragover');
        });
        
        this.elements.fileDropZone?.addEventListener('drop', (e) => {
            handleDrag(e);
            this.elements.fileDropZone?.classList.remove('dragover');
            this.handleFileSelect({ target: { files: e.dataTransfer.files } });
        });
        
        document.querySelector('.close-modal')?.addEventListener('click', () => {
            this.hideModal();
        });

        this.elements.modal?.addEventListener('click', (e) => {
            if (e.target === this.elements.modal) {
                this.hideModal();
            }
        });

        this.elements.cancelBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            this.hideModal();
        });
        
        this.elements.deployForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleDeploy();
        });
        
        this.elements.switchBtn?.addEventListener('click', async () => {
            await this.switchTraffic();
        });
        
        const debounce = (func, delay) => {
            let timer;
            return function() {
                clearTimeout(timer);
                timer = setTimeout(() => func.apply(this, arguments), delay);
            };
        };
        
        const debouncedLoad = debounce(() => this.loadInitialData(), 500);
        document.querySelectorAll('.refresh-card, #refreshButton').forEach(btn => {
            btn.addEventListener('click', debouncedLoad);
        });
    }

    showModal() {
        console.log('Showing modal');
        if (this.elements.modal) {
            this.resetModal();
            this.elements.modal.style.display = 'flex';
            document.body.style.overflow = 'hidden';
        } else {
            console.error('Modal element not found');
        }
    }

    hideModal() {
        if (this.elements.modal) {
            this.elements.modal.style.display = 'none';
            document.body.style.overflow = '';
        }
    }

    resetModal() {
        this.uploadedFiles = [];
        if (this.elements.fileList) this.elements.fileList.innerHTML = '';
        if (this.elements.commitMessage) this.elements.commitMessage.value = '';
        if (this.elements.deploymentType) this.elements.deploymentType.value = 'NEW';
        if (this.elements.confirmBtn) {
            this.elements.confirmBtn.disabled = false;
            this.elements.confirmBtn.innerHTML = 'Deploy';
        }
        this.isDeploying = false;
    }

    handleFileSelect(event) {
        const files = Array.from(event.target.files);
        const validTypes = ['text/html', 'text/css', 'application/javascript'];
        
        files.forEach(file => {
            if (!validTypes.includes(file.type)) {
                const ext = file.name.split('.').pop().toLowerCase();
                if (!['html', 'css', 'js'].includes(ext)) {
                    this.showToast(`Skipped ${file.name}: Invalid file type`, 'error');
                    return;
                }
            }

            if (file.size > 5 * 1024 * 1024) {
                this.showToast(`Skipped ${file.name}: File too large (max 5MB)`, 'error');
                return;
            }

            if (!this.uploadedFiles.some(f => f.name === file.name && f.size === file.size)) {
                this.uploadedFiles.push(file);
                this.renderFileItem(file);
            }
        });
        
        if (this.elements.fileUpload) {
            this.elements.fileUpload.value = '';
        }
    }

    renderFileItem(file) {
        if (!this.elements.fileList) return;
        
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.innerHTML = `
            <span class="file-name">${file.name}</span>
            <span class="file-size">${(file.size / 1024).toFixed(2)} KB</span>
            <span class="remove-file" data-name="${file.name}">&times;</span>
        `;
        
        const removeBtn = fileItem.querySelector('.remove-file');
        if (removeBtn) {
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeFile(file.name);
            });
        }
        
        this.elements.fileList.appendChild(fileItem);
    }

    removeFile(fileName) {
        this.uploadedFiles = this.uploadedFiles.filter(f => f.name !== fileName);
        if (this.elements.fileList) {
            const items = this.elements.fileList.querySelectorAll('.file-item');
            items.forEach(item => {
                if (item.querySelector('.file-name')?.textContent === fileName) {
                    item.remove();
                }
            });
        }
    }

    async handleDeploy() {
        if (this.isDeploying) return;
        
        if (this.uploadedFiles.length === 0) {
            this.showToast('Please upload at least one file', 'error');
            return;
        }

        const branch = this.elements.deploymentType?.value === 'NEW' ? 'blue' : 'green';
        const commitMsg = this.elements.commitMessage?.value || `DeployEase: ${branch} deployment`;
        
        try {
            this.isDeploying = true;
            this.showToast('Preparing deployment...', 'info');
            
            if (this.elements.confirmBtn) {
                this.elements.confirmBtn.disabled = true;
                this.elements.confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deploying...';
            }

            const fileContents = await Promise.all(
                this.uploadedFiles.map(async file => ({
                    path: file.name,
                    content: await this.readFileAsText(file)
                }))
            );

            const response = await fetch(`${config.apiBaseUrl}/api/deployments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    branch,
                    files: fileContents,
                    commitMessage: commitMsg
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Deployment failed');
            }
            
            const result = await response.json();
            this.showToast(`Deployment to ${branch} started`, 'success');
            
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'subscribe',
                    deployId: result.deployId,
                    branch
                }));
            }
            
            this.hideModal();
        } catch (error) {
            this.showToast(error.message, 'error');
            console.error('Deployment error:', error);
        } finally {
            this.isDeploying = false;
            if (this.elements.confirmBtn) {
                this.elements.confirmBtn.disabled = false;
                this.elements.confirmBtn.textContent = 'Deploy';
            }
        }
    }

    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = e => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    async switchTraffic() {
        try {
            const currentActive = document.querySelector('.status-badge.active');
            if (!currentActive) {
                throw new Error('Could not determine current active environment');
            }
            
            const targetBranch = currentActive.parentElement.parentElement.id.includes('blue') ? 'green' : 'blue';
            this.showToast(`Switching traffic to ${targetBranch}...`, 'info');
            
            if (this.elements.switchBtn) {
                this.elements.switchBtn.disabled = true;
                this.elements.switchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Switching...';
            }
            
            const response = await fetch(`${config.apiBaseUrl}/api/environments/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetBranch })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || "Switch failed");
            }
            
            const result = await response.json();
            this.showToast(`Success: ${result.message}`, 'success');
            await this.updateEnvironmentStatus();
        } catch (error) {
            this.showToast(`Error: ${error.message}`, 'error');
            console.error('Switch error:', error);
        } finally {
            if (this.elements.switchBtn) {
                this.elements.switchBtn.disabled = false;
                this.elements.switchBtn.innerHTML = 'Switch Traffic';
                const currentActive = document.querySelector('.status-badge.active');
                if (currentActive) {
                    this.elements.switchBtn.textContent = `Switch to ${currentActive.parentElement.parentElement.id.includes('blue') ? 'Green' : 'Blue'}`;
                }
            }
        }
    }

    async loadInitialData() {
        try {
            const statusResponse = await fetch(`${config.apiBaseUrl}/api/environments/status`);
            if (!statusResponse.ok) throw new Error('Failed to fetch environment status');
            const status = await statusResponse.json();
            this.updateEnvironmentStatus(status);
            
        } catch (error) {
            this.showToast('Failed to load data', 'error');
            console.error('Initial data load error:', error);
        }
    }

    updateEnvironmentStatus(status) {
        if (!status) return;
        
        if (this.elements.blueStatus) {
            this.elements.blueStatus.textContent = status.blue?.status || "Error";
            this.elements.blueStatus.className = `status-badge ${status.blue?.status === "active" ? "active" : "inactive"}`;
            if (this.elements.blueVersion) this.elements.blueVersion.textContent = status.blue?.version || "N/A";
            if (this.elements.blueReplicas) this.elements.blueReplicas.textContent = status.blue?.replicas || "0/0";
        }
        
        if (this.elements.greenStatus) {
            this.elements.greenStatus.textContent = status.green?.status || "Error";
            this.elements.greenStatus.className = `status-badge ${status.green?.status === "active" ? "active" : "inactive"}`;
            if (this.elements.greenVersion) this.elements.greenVersion.textContent = status.green?.version || "N/A";
            if (this.elements.greenReplicas) this.elements.greenReplicas.textContent = status.green?.replicas || "0/0";
        }
        
        if (this.elements.switchBtn) {
            this.elements.switchBtn.textContent = `Switch to ${status.blue?.status === "active" ? "Green" : "Blue"}`;
        }
    }

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        this.elements.toastContainer.appendChild(toast);
        
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new GitDeployer();
});