
/**
 * WebSocket Service for DeployEase
 * Handles real-time communication for deployment status and logs
 */

const WebSocket = require('ws');
const http = require('http');
const logger = require('../utils/logger');
const { exec } = require('child_process');
const gitService = require('../services/gitService');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.server = null;
    this.clients = new Map(); // Map to store client connections with unique IDs
    this.isInitialized = false;
    this.pingInterval = null;
    this.retryCount = 0;
    this.retryLimit = 5;
    this.retryTimeout = null;
  }

  /**
   * Initialize the WebSocket server
   * @param {number} port - Port for WebSocket server (default: 3001)
   * @returns {Promise<boolean>} - Resolves to true if initialization successful
   */
  init(port = 3001) {
    return new Promise((resolve, reject) => {
      try {
        // Check if already initialized
        if (this.isInitialized) {
          logger.info('WebSocket server already initialized');
          return resolve(true);
        }

        // Check if port is in use and kill process if necessary
        this.checkPortAndKillProcess(port)
          .then(() => {
            // Create HTTP server for WebSocket
            const server = http.createServer();
            
            // Create WebSocket server
            const wss = new WebSocket.Server({ server });
            
            // Store references
            this.server = server;
            this.wss = wss;

            // Set up WebSocket event handlers
            this.setupWebSocketEvents();

            // Start the server
            server.listen(port, () => {
              logger.info(`WebSocket server is running on port ${port}`);
              this.isInitialized = true;
              this.startPingInterval();
              resolve(true);
            });

            // Handle server errors
            server.on('error', (err) => {
              if (err.code === 'EADDRINUSE') {
                logger.error(`Port ${port} is already in use`);
                this.checkPortAndKillProcess(port)
                  .then(() => {
                    logger.info('Retry after killing process');
                    this.close().then(() => {
                      this.init(port).then(resolve).catch(reject);
                    });
                  })
                  .catch(reject);
              } else {
                logger.error(`WebSocket server error: ${err.message}`);
                reject(err);
              }
            });
          })
          .catch(err => {
            logger.error(`Error checking port: ${err.message}`);
            reject(err);
          });
      } catch (err) {
        logger.error(`Error during WebSocket server initialization: ${err.message}`);
        reject(err);
      }
    });
  }

  /**
   * Set up WebSocket event handlers
   */
  setupWebSocketEvents() {
    if (!this.wss) {
      logger.error('Cannot setup WebSocket events: WebSocket server not initialized');
      return;
    }

    // Connection event
    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      const clientIp = req.socket.remoteAddress;
      
      // Store client in map with metadata
      this.clients.set(clientId, {
        socket: ws,
        ip: clientIp,
        connectedAt: new Date(),
        lastPing: Date.now()
      });

      logger.info(`New WebSocket connection from ${clientIp} (ID: ${clientId})`);
      
      // Send initial deployment history on connection
      this.sendDeploymentHistory(clientId);

      // Set up client event handlers
      ws.on('message', (message) => {
        try {
          const parsedMessage = JSON.parse(message);
          this.handleClientMessage(clientId, parsedMessage);
        } catch (err) {
          logger.error(`Error parsing message from client ${clientId}: ${err.message}`);
        }
      });

      // Handle close event
      ws.on('close', () => {
        logger.info(`WebSocket connection closed: ${clientId}`);
        this.clients.delete(clientId);
      });

      // Handle error event
      ws.on('error', (err) => {
        logger.error(`WebSocket client error (${clientId}): ${err.message}`);
        this.clients.delete(clientId);
      });

      // Handle pong for keep-alive
      ws.on('pong', () => {
        if (this.clients.has(clientId)) {
          this.clients.get(clientId).lastPing = Date.now();
        }
      });
    });

    // Server error event
    this.wss.on('error', (err) => {
      logger.error(`WebSocket server error: ${err.message}`);
    });
  }

  /**
   * Handle incoming client messages
   * @param {string} clientId - Client identifier
   * @param {object} message - Parsed message from client
   */
  handleClientMessage(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) {
      logger.warn(`Received message from unknown client ${clientId}`);
      return;
    }

    // Handle different message types
    switch (message.type) {
      case 'subscribe':
        logger.info(`Received subscribe message from ${clientId}`);
        // Handle subscription logic
        break;
        
      case 'ping':
        // Update last ping time and respond with pong
        client.lastPing = Date.now();
        this.sendToClient(clientId, { type: 'pong', timestamp: Date.now() });
        break;
        
      case 'deployment':
        // Handle deployment status requests
        logger.info(`Received deployment status request from ${clientId}`);
        // Implementation for deployment status updates
        break;
        
      case 'request_history':
        // Send deployment history when requested
        logger.info(`Received history request from ${clientId}`);
        this.sendDeploymentHistory(clientId);
        break;
        
      default:
        logger.warn(`Received unknown message type from ${clientId}: ${message.type}`);
    }
  }

  /**
   * Send deployment history to a specific client
   * @param {string} clientId - Client identifier
   */
  async sendDeploymentHistory(clientId) {
    try {
      // Get deployment history directly from gitService instead of through deploymentController
      const historyBlue = await gitService.getDeploymentHistory('blue') || [];
      const historyGreen = await gitService.getDeploymentHistory('green') || [];
      
      // Format the deployments consistent with what the client expects
      const formatDeployment = (deployment, branch) => {
        return {
          id: deployment.id || deployment.sha?.slice(0, 7) || `${branch}-${Date.now()}`,
          branch: branch,
          status: deployment.state || 'success',
          timestamp: deployment.timestamp || deployment.commit?.committer?.date || new Date().toISOString(),
          commitSha: deployment.sha || '',
          commitUrl: deployment.html_url || '',
          commitMessage: deployment.commit?.message || `Deployment to ${branch}`,
          committer: deployment.commit?.committer?.name || 'DeployEase System'
        };
      };
      
      // Format the history data
      const formattedBlue = Array.isArray(historyBlue) 
        ? historyBlue.map(d => formatDeployment(d, 'blue')) 
        : [];
        
      const formattedGreen = Array.isArray(historyGreen) 
        ? historyGreen.map(d => formatDeployment(d, 'green')) 
        : [];
      
      const history = {
        success: true,
        blue: formattedBlue,
        green: formattedGreen,
        timestamp: new Date().toISOString()
      };
      
      // Send to client
      this.sendToClient(clientId, { 
        type: 'deployment_history',
        data: history
      });
      
      logger.debug(`Sent deployment history to client ${clientId}`);
    } catch (error) {
      logger.error(`Failed to fetch deployment history`, {
        error: error.message,
        stack: error.stack
      });
      logger.error(`Error sending deployment history to client ${clientId}: ${error.message}`);
      this.sendToClient(clientId, { 
        type: 'error',
        message: 'Failed to retrieve deployment history' 
      });
    }
  }

  /**
   * Broadcast deployment update to all connected clients
   * @param {object} deployment - Deployment data to broadcast
   */
  broadcastDeploymentUpdate(deployment) {
    this.broadcast({
      type: 'deployment_update',
      data: deployment
    });
    logger.debug(`Broadcast deployment update to all clients`);
  }

  /**
   * Generate a unique client identifier
   * @returns {string} - Unique client ID
   */
  generateClientId() {
    return Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
  }

  /**
   * Start the ping interval to check for stale connections
   */
  startPingInterval() {
    // Clear any existing interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Set up interval for regular pings
    this.pingInterval = setInterval(() => {
      if (!this.isInitialized || !this.wss) return;

      const now = Date.now();
      
      // Check each client and remove stale connections
      this.clients.forEach((client, clientId) => {
        try {
          // Check if client is still alive (30 second timeout)
          if (now - client.lastPing > 30000) {
            // Try to ping the client
            client.socket.ping();
            
            // If no pong received after 5 more seconds, consider dead
            setTimeout(() => {
              if (this.clients.has(clientId) && 
                  now - this.clients.get(clientId).lastPing > 30000) {
                logger.warn(`Client ${clientId} is unresponsive, closing connection`);
                client.socket.terminate();
                this.clients.delete(clientId);
              }
            }, 5000);
          } else {
            // Regular ping if active
            client.socket.ping();
          }
        } catch (err) {
          logger.error(`Error pinging client ${clientId}: ${err.message}`);
          this.clients.delete(clientId);
        }
      });
    }, 15000); // Check every 15 seconds
  }

  /**
   * Send message to a specific client
   * @param {string} clientId - Client identifier
   * @param {object} data - Data to send
   * @returns {boolean} - True if sent successfully
   */
  sendToClient(clientId, data) {
    try {
      const client = this.clients.get(clientId);
      if (!client) {
        logger.warn(`Attempted to send message to unknown client: ${clientId}`);
        return false;
      }

      client.socket.send(JSON.stringify(data));
      return true;
    } catch (err) {
      logger.error(`Error sending message to client ${clientId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Broadcast message to all connected clients
   * @param {object} data - Data to broadcast
   * @param {Function} filter - Optional filter function to select clients
   */
  broadcast(data, filter = null) {
    if (!this.isInitialized || !this.wss) {
      logger.warn('Cannot broadcast: WebSocket server not initialized');
      return;
    }

    const message = JSON.stringify(data);
    let sentCount = 0;

    this.clients.forEach((client, clientId) => {
      try {
        // Apply filter if provided
        if (filter && !filter(client, clientId)) {
          return;
        }

        client.socket.send(message);
        sentCount++;
      } catch (err) {
        logger.error(`Error broadcasting to client ${clientId}: ${err.message}`);
        // Remove failed client
        this.clients.delete(clientId);
      }
    });

    logger.debug(`Broadcast message sent to ${sentCount} clients`);
  }

  /**
   * Check if the WebSocket service is properly connected
   * @returns {boolean} - Connection status
   */
  isConnected() {
    return this.isInitialized && this.wss !== null;
  }

  /**
   * Get the number of connected clients
   * @returns {number} - Client count
   */
  getClientCount() {
    return this.clients.size;
  }

  /**
   * Close the WebSocket server and clean up resources
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve) => {
      // If not initialized, nothing to close
      if (!this.isInitialized) {
        return resolve();
      }

      // Clear intervals
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      if (this.retryTimeout) {
        clearTimeout(this.retryTimeout);
        this.retryTimeout = null;
      }

      // Close all client connections
      this.clients.forEach((client, clientId) => {
        try {
          logger.debug(`Closing connection to client ${clientId}`);
          client.socket.close();
        } catch (err) {
          logger.error(`Error closing client ${clientId}: ${err.message}`);
        }
      });
      
      // Clear client map
      this.clients.clear();

      // Close the server
      if (this.server) {
        this.server.close(() => {
          this.wss = null;
          this.server = null;
          this.isInitialized = false;
          resolve();
        });
      } else {
        // No server to close
        this.wss = null;
        this.isInitialized = false;
        resolve();
      }
    });
  }

  /**
   * Check if a port is in use and kill the process using it if needed
   * @param {number} port - Port to check
   * @returns {Promise<void>}
   */
  checkPortAndKillProcess(port) {
    return new Promise((resolve, reject) => {
      // Command to find process using the port
      const command = process.platform === 'win32'
        ? `netstat -ano | findstr :${port}`
        : `lsof -i :${port} -t`;

      exec(command, (error, stdout, stderr) => {
        if (error && error.code !== 1) {
          // An error occurred, but not "not found"
          logger.error(`Error checking port ${port}: ${error.message}`);
          return reject(error);
        }

        if (!stdout.trim()) {
          // No process using the port
          logger.debug(`Port ${port} is available`);
          return resolve();
        }

        // For Windows platforms, try to safely parse the PID
        if (process.platform === 'win32') {
          // Extract PID safely with more sophisticated parsing
          const lines = stdout.trim().split('\n');
          let pid = null;
          
          // Look through each line for a valid listen state
          for (const line of lines) {
            // Example line: "  TCP    0.0.0.0:3001          0.0.0.0:0              LISTENING       4532"
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5) {
              const possiblePid = parts[parts.length - 1];
              // Make sure PID is numeric and not a system process (0, 4, or other common system PIDs)
              const numericPid = parseInt(possiblePid, 10);
              if (!isNaN(numericPid) && numericPid > 10) {
                pid = numericPid;
                break;
              }
            }
          }
          
          if (!pid) {
            logger.warn(`Could not safely determine PID using port ${port}, skipping kill step`);
            // Continue without killing as we can't be sure which process to kill
            return resolve();
          }
          
          logger.info(`Identified process ${pid} using port ${port}`);
          
          // Command to kill the process
          const killCommand = `taskkill /F /PID ${pid}`;
          
          exec(killCommand, (killError, killStdout, killStderr) => {
            if (killError) {
              logger.error(`Error killing process ${pid} using port ${port}: ${killError.message}`);
              // Continue anyway - we'll try to start the server
              return resolve();
            }

            logger.info(`Successfully killed process ${pid} using port ${port}`);
            
            // Wait a moment for the port to be released
            setTimeout(resolve, 1000);
          });
        } else {
          // For Unix-like systems - PID is returned directly
          const pid = stdout.trim();
          
          if (!pid) {
            logger.warn(`Could not determine PID using port ${port}`);
            return resolve();
          }

          // Command to kill the process
          const killCommand = `kill -9 ${pid}`;

          exec(killCommand, (killError, killStdout, killStderr) => {
            if (killError) {
              logger.error(`Error killing process using port ${port}: ${killError.message}`);
              return reject(killError);
            }

            logger.info(`Successfully killed process ${pid} using port ${port}`);
            
            // Wait a moment for the port to be released
            setTimeout(resolve, 1000);
          });
        }
      });
    });
  }
}

// Create and export a singleton instance
const websocketService = new WebSocketService();
module.exports = websocketService;