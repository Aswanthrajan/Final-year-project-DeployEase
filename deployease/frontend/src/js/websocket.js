// frontend/src/js/websocket.js
import config from './config.js';

let socket;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const baseReconnectDelay = 3000; // 3 seconds base delay
const logOutput = document.getElementById("logs");

// Calculate delay with exponential backoff
function getReconnectDelay(attempt) {
  return Math.min(baseReconnectDelay * Math.pow(2, attempt), 30000); // Max 30 seconds
}

function connectWebSocket() {
  // Clear any existing connection
  if (socket) {
    socket.close();
  }

  // Use the correct WebSocket path (/deployease)
  const wsUrl = new URL(config.websocketUrl);
  wsUrl.pathname = '/deployease';
  socket = new WebSocket(wsUrl.toString());

  socket.onopen = () => {
    reconnectAttempts = 0;
    if (logOutput) {
      logOutput.textContent += "✅ Connected to deployment logs\n";
    }
    
    // Send initial handshake with proper format
    socket.send(JSON.stringify({
      type: "subscribe",
      channels: ["deployment_logs"],
      client: "deployease-web",
      timestamp: Date.now()
    }));

    // Start heartbeat
    heartbeat();
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (logOutput) {
        // Handle different message types
        if (data.type === "log") {
          const line = `[${new Date(data.timestamp).toLocaleTimeString()}] ${data.message}\n`;
          logOutput.textContent += line;
        } else if (data.type === "system") {
          logOutput.textContent += `SYSTEM: ${data.message}\n`;
        } else if (data.type === "pong") {
          // Received pong response to our ping
          return;
        }
        
        logOutput.scrollTop = logOutput.scrollHeight;
      }
    } catch (error) {
      if (logOutput) {
        logOutput.textContent += `[${new Date().toLocaleTimeString()}] ${event.data}\n`;
      }
    }
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
    if (logOutput) {
      logOutput.textContent += `[${new Date().toLocaleTimeString()}] ⚠️ Connection error: ${error.message || 'Unknown error'}\n`;
    }
  };

  socket.onclose = (event) => {
    if (event.code === 1000) {
      // Normal closure
      if (logOutput) {
        logOutput.textContent += `[${new Date().toLocaleTimeString()}] 🔌 Connection closed\n`;
      }
      return;
    }

    if (reconnectAttempts < maxReconnectAttempts) {
      const delay = getReconnectDelay(reconnectAttempts);
      if (logOutput) {
        logOutput.textContent += `[${new Date().toLocaleTimeString()}] ⌛ Reconnecting in ${delay/1000}s... (Attempt ${reconnectAttempts + 1}/${maxReconnectAttempts})\n`;
      }
      
      setTimeout(() => {
        reconnectAttempts++;
        connectWebSocket();
      }, delay);
    } else {
      if (logOutput) {
        logOutput.textContent += `[${new Date().toLocaleTimeString()}] ❌ Max reconnection attempts reached\n`;
      }
    }
  };

  // Heartbeat function to keep connection alive
  function heartbeat() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    
    socket.send(JSON.stringify({ type: "ping" }));
    setTimeout(heartbeat, 25000); // Send ping every 25 seconds
  }
}

// Initialize with auto-reconnect
connectWebSocket();

// Export for manual reconnection if needed
export function reconnect() {
  if (reconnectAttempts >= maxReconnectAttempts) {
    reconnectAttempts = 0; // Reset attempts if manually reconnecting
  }
  connectWebSocket();
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (socket) {
    socket.close(1000, "User navigating away"); // Normal closure code
  }
});

// Safely handle logOutput being null
if (!logOutput) {
  console.warn("Log output element not found. WebSocket messages will only appear in console.");
}