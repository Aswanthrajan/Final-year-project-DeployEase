// frontend/src/js/websocket.js
import config from './config.js';

class WebSocketManager {
  constructor() {
    this.socket = null;
    this.logOutput = document.getElementById("logContent");
    this.isManualClose = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3; // Default to 3 attempts
    this.connectionState = 'disconnected';
    this.connectionTimeout = null;
    this.heartbeatInterval = null;
  }

  // Initialize WebSocket connection (will only try up to maxConnectionAttempts times)
  connect() {
    if (this.connectionState === 'connected' || 
        this.connectionState === 'connecting' || 
        this.connectionAttempts >= this.maxConnectionAttempts) {
      
      // If we've hit the max attempts, show an error message instead of retrying
      if (this.connectionAttempts >= this.maxConnectionAttempts) {
        this.log(`Maximum connection attempts reached (${this.maxConnectionAttempts}). Please refresh the page manually to try again.`);
        this.showMaxAttemptsError();
      }
      return;
    }

    this.connectionState = 'connecting';
    this.connectionAttempts++;
    this.disconnect(); // Clean up any existing connection

    try {
      const wsUrl = new URL(config.websocketUrl);
      wsUrl.pathname = '/deployease';

      this.socket = new WebSocket(wsUrl.toString());
      this.socket.onopen = this.handleOpen.bind(this);
      this.socket.onmessage = this.handleMessage.bind(this);
      this.socket.onerror = this.handleError.bind(this);
      this.socket.onclose = this.handleClose.bind(this);

      this.log(`Attempting connection (${this.connectionAttempts}/${this.maxConnectionAttempts})...`);
      
      // Set connection timeout (10 seconds)
      this.connectionTimeout = setTimeout(() => {
        if (this.connectionState !== 'connected') {
          this.handleConnectionFailure('Connection timeout');
        }
      }, 10000);

    } catch (error) {
      this.handleConnectionFailure(`Initialization error: ${error.message}`);
    }
  }

  // Handle successful connection
  handleOpen() {
    clearTimeout(this.connectionTimeout);
    this.connectionState = 'connected';
    this.log("WebSocket connection established");

    // Send initial subscription message
    this.send({
      type: "subscribe",
      channels: ["deployment_logs"],
      client: "deployease-web"
    });

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.send({ type: "ping" });
      }
    }, 30000); // 30 second heartbeat
  }

  // Handle incoming messages
  handleMessage(event) {
    try {
      const data = JSON.parse(event.data);
      
      // Filter out system messages
      if (["connection_ack", "subscription_ack", "pong"].includes(data.type)) {
        return;
      }

      // Handle specific message types
      switch(data.type) {
        case "log":
          this.log(`[${new Date(data.timestamp).toLocaleTimeString()}] ${data.message}`);
          break;
        
        case "deploy_status":
          this.log(`[DEPLOY] ${data.status.toUpperCase()}: ${data.message}`);
          break;
        
        case "deployment_history":
          // Instead of logging raw JSON, handle deployment history separately
          this.handleDeploymentHistory(data.data);
          break;
          
        default:
          // For any other message types, just log a simple notification
          this.log(`[${data.type}] Message received`);
      }
    } catch (error) {
      this.log(`[ERROR] Failed to parse message: ${event.data}`);
    }
  }
  
  // Handle deployment history data specifically
  handleDeploymentHistory(data) {
    if (!data || !data.success) {
      this.log("[ERROR] Failed to load deployment history");
      return;
    }
    
    // Just log a simple summary instead of the full data
    const blueCount = data.blue?.length || 0;
    const greenCount = data.green?.length || 0;
    
    this.log(`Deployment history loaded: ${blueCount} blue deployments, ${greenCount} green deployments`);
    
    // Dispatch an event so other components can use this data
    const event = new CustomEvent('deploymentHistoryLoaded', { detail: data });
    document.dispatchEvent(event);
  }

  // Handle connection errors
  handleError(error) {
    this.log(`WebSocket error: ${error.message || 'Unknown error'}`);
    this.handleConnectionFailure('Connection error');
  }

  // Handle connection closure
  handleClose(event) {
    this.cleanup();
    this.connectionState = 'disconnected';
    
    if (event.code !== 1000 || !this.isManualClose) {
      this.log(`Connection closed: ${event.reason || 'Unknown reason'}`);
      
      // Only show error and retry if we haven't hit the max attempts
      if (this.connectionAttempts < this.maxConnectionAttempts) {
        // Retry connection after a delay
        setTimeout(() => this.connect(), 3000);
      } else {
        this.showMaxAttemptsError();
      }
    }
  }

  // Handle connection failures
  handleConnectionFailure(reason) {
    this.cleanup();
    this.connectionState = 'disconnected';
    this.log(`Connection failed: ${reason}`);
    
    if (this.connectionAttempts < this.maxConnectionAttempts) {
      // Wait for 3 seconds before retry
      this.log(`Retrying in 3 seconds... (Attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})`);
      setTimeout(() => this.connect(), 3000);
    } else {
      this.showMaxAttemptsError();
    }
  }

  // Show user-friendly error message after max retry attempts
  showMaxAttemptsError() {
    const errorElement = document.createElement('div');
    errorElement.className = 'connection-error';
    errorElement.innerHTML = `
      <p>Connection failed after ${this.maxConnectionAttempts} attempts. Please <button class="retry-button">try again</button> or <a href="javascript:location.reload()">refresh the page</a>.</p>
    `;
    
    // Add a manual retry button
    const retryButton = errorElement.querySelector('.retry-button');
    if (retryButton) {
      retryButton.addEventListener('click', () => {
        // Reset connection attempts and try again
        this.connectionAttempts = 0;
        if (errorElement.parentNode) {
          errorElement.parentNode.removeChild(errorElement);
        }
        this.connect();
      });
    }
    
    if (this.logOutput) {
      this.logOutput.appendChild(errorElement);
    }
  }

  // Send data through WebSocket
  send(data) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(data));
        return true;
      } catch (error) {
        this.log(`Failed to send message: ${error.message}`);
        return false;
      }
    }
    return false;
  }

  // Clean up resources
  cleanup() {
    clearTimeout(this.connectionTimeout);
    clearInterval(this.heartbeatInterval);
    
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  // Disconnect manually
  disconnect() {
    this.isManualClose = true;
    this.cleanup();
    this.connectionState = 'disconnected';
  }

  // Log messages to output
  log(message) {
    console.log(message);
    if (this.logOutput) {
      this.logOutput.textContent += `${message}\n`;
      this.logOutput.scrollTop = this.logOutput.scrollHeight;
    }
  }

  // Get connection state
  getConnectionState() {
    return this.connectionState;
  }

  // Get connection attempts count
  getConnectionAttempts() {
    return this.connectionAttempts;
  }
}

// Singleton instance
const webSocketManager = new WebSocketManager();

// Initialize when DOM is ready
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    // You can configure the max attempts here
    // webSocketManager.maxConnectionAttempts = 5; // Uncomment to change from default 3
    webSocketManager.connect();
  });

  window.addEventListener('beforeunload', () => {
    webSocketManager.disconnect();
  });
}

export default webSocketManager;