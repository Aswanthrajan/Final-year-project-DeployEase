// frontend/src/js/websocket.js
import config from './config.js';

class WebSocketManager {
  constructor() {
    this.socket = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.baseReconnectDelay = 3000; // 3 seconds base delay
    this.heartbeatInterval = null;
    this.logOutput = document.getElementById("logContent");
    this.isManualClose = false;
    this.messageQueue = [];
    this.subscribedChannels = new Set();
  }

  // Initialize WebSocket connection
  connect() {
    // Clear any existing connection
    if (this.socket) {
      this.socket.close();
      this.cleanup();
    }

    // Reset manual close flag
    this.isManualClose = false;

    try {
      // Create WebSocket URL with proper path
      const wsUrl = new URL(config.websocketUrl);
      if (!wsUrl.pathname.endsWith('/deployease')) {
        wsUrl.pathname = '/deployease';
      }

      this.socket = new WebSocket(wsUrl.toString());

      // Set up event handlers
      this.socket.onopen = this.handleOpen.bind(this);
      this.socket.onmessage = this.handleMessage.bind(this);
      this.socket.onerror = this.handleError.bind(this);
      this.socket.onclose = this.handleClose.bind(this);

    } catch (error) {
      console.error("WebSocket initialization error:", error);
      this.scheduleReconnect();
    }
  }

  // Handle WebSocket open event
  handleOpen() {
    this.reconnectAttempts = 0;
    this.log("✅ Connected to deployment logs");

    // Send initial handshake
    this.send({
      type: "subscribe",
      channels: ["deployment_logs"],
      client: "deployease-web",
      timestamp: Date.now()
    });

    // Start heartbeat
    this.startHeartbeat();

    // Process any queued messages
    this.processMessageQueue();
  }

  // Handle incoming messages
  handleMessage(event) {
    try {
      const data = JSON.parse(event.data);
      
      // Skip connection acknowledgements
      if (data.type === "connection_ack" || data.type === "subscription_ack") {
        return;
      }

      // Handle different message types
      switch(data.type) {
        case "log":
          this.log(`[${new Date(data.timestamp).toLocaleTimeString()}] ${data.message}`);
          break;
        case "system":
          this.log(`[SYSTEM] ${data.message}`);
          break;
        case "pong":
          // No action needed for pong responses
          break;
        case "deploy_status":
          this.log(`[DEPLOYMENT] ${data.status.toUpperCase()}: ${data.message}`);
          break;
        default:
          this.log(`[UNKNOWN] ${event.data}`);
      }
    } catch (error) {
      this.log(`[ERROR] Failed to parse message: ${event.data}`);
      console.error("Message parsing error:", error);
    }
  }

  // Handle errors
  handleError(error) {
    console.error("WebSocket error:", error);
    this.log(`⚠️ Connection error: ${error.message || 'Unknown error'}`);
  }

  // Handle connection close
  handleClose(event) {
    // Clear heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (event.code === 1000 && this.isManualClose) {
      // Normal closure initiated by us
      this.log("🔌 Connection closed by client");
      return;
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts && !this.isManualClose) {
      const delay = this.getReconnectDelay();
      this.log(`⌛ Reconnecting in ${delay/1000}s... (Attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
      }, delay);
    } else if (!this.isManualClose) {
      this.log("❌ Max reconnection attempts reached");
    }
  }

  // Send data through WebSocket
  send(data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(data));
      } catch (error) {
        console.error("WebSocket send error:", error);
        // Queue message if sending fails
        this.messageQueue.push(data);
      }
    } else {
      // Queue message if not connected
      this.messageQueue.push(data);
    }
  }

  // Process queued messages
  processMessageQueue() {
    while (this.messageQueue.length > 0 && this.socket.readyState === WebSocket.OPEN) {
      const message = this.messageQueue.shift();
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        console.error("Failed to send queued message:", error);
        this.messageQueue.unshift(message); // Put back if fails
        break;
      }
    }
  }

  // Close connection properly
  disconnect() {
    this.isManualClose = true;
    if (this.socket) {
      this.socket.close(1000, "User initiated disconnect");
    }
    this.cleanup();
  }

  // Reconnect manually
  reconnect() {
    this.reconnectAttempts = 0;
    this.connect();
  }

  // Cleanup resources
  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.messageQueue = [];
  }

  // Start heartbeat to keep connection alive
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.send({ type: "ping" });
      }
    }, 25000); // 25 seconds
  }

  // Calculate reconnect delay with exponential backoff
  getReconnectDelay() {
    return Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts), 30000); // Max 30 seconds
  }

  // Log message to output element and console
  log(message) {
    if (this.logOutput) {
      this.logOutput.textContent += `${message}\n`;
      this.logOutput.scrollTop = this.logOutput.scrollHeight;
    }
    console.log(message);
  }

  // Subscribe to specific channels
  subscribe(channels) {
    if (!Array.isArray(channels)) channels = [channels];
    channels.forEach(channel => this.subscribedChannels.add(channel));
    
    this.send({
      type: "subscribe",
      channels: Array.from(this.subscribedChannels),
      timestamp: Date.now()
    });
  }

  // Unsubscribe from channels
  unsubscribe(channels) {
    if (!Array.isArray(channels)) channels = [channels];
    channels.forEach(channel => this.subscribedChannels.delete(channel));
    
    this.send({
      type: "unsubscribe",
      channels: channels,
      timestamp: Date.now()
    });
  }
}

// Create and export singleton instance
const webSocketManager = new WebSocketManager();

// Initialize connection when imported
if (typeof window !== 'undefined') {
  webSocketManager.connect();
}

// Clean up on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    webSocketManager.disconnect();
  });
}

export default webSocketManager;