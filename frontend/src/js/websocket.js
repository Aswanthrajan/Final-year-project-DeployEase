// frontend/src/js/websocket.js
import config from './config.js';

class WebSocketManager {
  constructor() {
    this.socket = null;
    this.logOutput = document.getElementById("logContent");
    this.isManualClose = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 1; // Set to 1 for single attempt, or 5 for max 5 attempts
    this.connectionState = 'disconnected';
    this.connectionTimeout = null;
    this.heartbeatInterval = null;
  }

  // Initialize WebSocket connection (will only try once or up to maxConnectionAttempts)
  connect() {
    if (this.connectionState === 'connected' || 
        this.connectionState === 'connecting' || 
        this.connectionAttempts >= this.maxConnectionAttempts) {
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

      // Format different message types
      let logMessage = '';
      switch(data.type) {
        case "log":
          logMessage = `[${new Date(data.timestamp).toLocaleTimeString()}] ${data.message}`;
          break;
        case "deploy_status":
          logMessage = `[DEPLOY] ${data.status.toUpperCase()}: ${data.message}`;
          break;
        default:
          logMessage = `[${data.type}] ${JSON.stringify(data)}`;
      }
      
      this.log(logMessage);
    } catch (error) {
      this.log(`[ERROR] Failed to parse message: ${event.data}`);
    }
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
      this.showConnectionError();
    }
  }

  // Handle connection failures
  handleConnectionFailure(reason) {
    this.cleanup();
    this.connectionState = 'disconnected';
    this.log(`Connection failed: ${reason}`);
    
    if (this.connectionAttempts < this.maxConnectionAttempts) {
      // If we want to try multiple times (up to maxConnectionAttempts)
      setTimeout(() => this.connect(), 1000);
    } else {
      this.showConnectionError();
    }
  }

  // Show user-friendly error message
  showConnectionError() {
    const errorElement = document.createElement('div');
    errorElement.className = 'connection-error';
    errorElement.innerHTML = `
      <p>Connection failed after ${this.connectionAttempts} attempt(s). Please <a href="javascript:location.reload()">refresh</a> to try again.</p>
    `;
    
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
    // Set maxConnectionAttempts to 1 for single attempt, or 5 for max 5 attempts
    webSocketManager.maxConnectionAttempts = 1; // CHANGE TO 5 IF YOU WANT UP TO 5 ATTEMPTS
    webSocketManager.connect();
  });

  window.addEventListener('beforeunload', () => {
    webSocketManager.disconnect();
  });
}

export default webSocketManager;