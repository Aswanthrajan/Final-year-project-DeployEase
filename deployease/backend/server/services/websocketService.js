// backend/server/services/websocketService.js
const WebSocket = require('ws');
const logger = require('../utils/logger');

class WebSocketService {
    constructor() {
        this.wss = null;
        this.clients = new Map();
        this.messageHandlers = new Map();
        this.pingInterval = null;
    }

    /**
     * Initialize WebSocket server
     * @param {http.Server} server - HTTP server instance
     */
    init(server) {
        try {
            // Initialize WebSocket server on /deployease path
            this.wss = new WebSocket.Server({ 
                server,
                path: '/deployease',
                clientTracking: false
            });

            // Setup ping interval (30 seconds)
            this.pingInterval = setInterval(() => {
                this._pingClients();
            }, 30000);

            this.wss.on('connection', (ws, req) => {
                const clientId = this._generateClientId(req);
                const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
                
                logger.info(`New WebSocket connection from ${ip}`, { clientId });

                // Store client with metadata
                this.clients.set(clientId, {
                    ws,
                    ip,
                    connectedAt: new Date(),
                    lastActivity: new Date(),
                    isAlive: true
                });

                // Setup message handler
                ws.on('message', (message) => {
                    this._handleMessage(clientId, message);
                    this.clients.get(clientId).lastActivity = new Date();
                });

                // Handle pong responses
                ws.on('pong', () => {
                    this.clients.get(clientId).isAlive = true;
                });

                // Handle connection close
                ws.on('close', () => {
                    this._handleDisconnect(clientId);
                });

                // Handle errors
                ws.on('error', (error) => {
                    this._handleError(clientId, error);
                });

                // Send connection acknowledgement
                ws.send(JSON.stringify({
                    type: 'connection_ack',
                    status: 'connected',
                    clientId,
                    timestamp: new Date().toISOString()
                }));
            });
            
            logger.info('WebSocket server initialized', {
                path: '/deployease',
                port: server.listening ? server.address().port : process.env.PORT || 3000
            });

        } catch (error) {
            logger.error('WebSocket initialization failed:', error);
            throw error;
        }
    }

    /**
     * Broadcast message to all connected clients
     * @param {Object} message - Message to broadcast
     */
    broadcast(message) {
        if (!this.wss) return;

        const messageStr = JSON.stringify(message);
        this.clients.forEach((client, clientId) => {
            try {
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(messageStr);
                }
            } catch (error) {
                logger.error(`Failed to broadcast to ${clientId}:`, error);
            }
        });
    }

    /**
     * Get connected clients count
     */
    getConnectedClients() {
        return this.clients.size;
    }

    /**
     * Close WebSocket server
     */
    close() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        
        this.clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.close(1000, 'Server shutdown');
            }
        });

        if (this.wss) {
            this.wss.close();
            logger.info('WebSocket server closed');
        }
    }

    // Private methods
    _generateClientId(req) {
        return req.headers['sec-websocket-key'] || 
               `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    _handleMessage(clientId, message) {
        try {
            const data = JSON.parse(message);
            logger.debug(`Message from ${clientId}`, { type: data.type });

            // Handle different message types
            switch(data.type) {
                case 'subscribe':
                    this._handleSubscribe(clientId, data);
                    break;
                case 'ping':
                    this.send(clientId, { type: 'pong' });
                    break;
                default:
                    this.broadcast(data);
            }
        } catch (error) {
            logger.error(`Error processing message from ${clientId}:`, error);
        }
    }

    _handleSubscribe(clientId, data) {
        // Implement subscription logic if needed
        this.send(clientId, {
            type: 'subscription_ack',
            status: 'subscribed',
            timestamp: new Date().toISOString()
        });
    }

    _handleDisconnect(clientId) {
        this.clients.delete(clientId);
        logger.info(`Client disconnected: ${clientId}`);
    }

    _handleError(clientId, error) {
        logger.error(`WebSocket error (${clientId}):`, error);
        if (this.clients.has(clientId)) {
            this.clients.get(clientId).ws.terminate();
            this.clients.delete(clientId);
        }
    }

    _pingClients() {
        this.clients.forEach((client, clientId) => {
            if (!client.isAlive) {
                logger.warn(`Terminating unresponsive client: ${clientId}`);
                client.ws.terminate();
                return this.clients.delete(clientId);
            }

            client.isAlive = false;
            client.ws.ping(null, false, (err) => {
                if (err) {
                    logger.error(`Ping failed for ${clientId}:`, err);
                    client.ws.terminate();
                    this.clients.delete(clientId);
                }
            });
        });
    }
}

module.exports = new WebSocketService();