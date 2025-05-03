const WebSocket = require('ws');
const logger = require('../utils/logger');

class WebSocketService {
    constructor() {
        this.wss = null;
        this.clients = new Map();
        this.messageHandlers = new Map();
        this.pingInterval = null;
        this.connectionTimeout = 30000; // 30 seconds timeout
        this.maxPayload = 1048576; // 1MB max message size
        this._isInitialized = false;
    }

    /**
     * Check if WebSocket service is initialized
     * @returns {boolean} True if initialized
     */
    isInitialized() {
        return this._isInitialized;
    }

    /**
     * Initialize WebSocket server
     * @param {http.Server} server - HTTP server instance
     */
    init(server) {
        try {
            if (this._isInitialized) {
                logger.warn('WebSocket server already initialized');
                return;
            }

            // Initialize WebSocket server with configuration
            this.wss = new WebSocket.Server({ 
                server,
                path: '/deployease',
                clientTracking: false,
                maxPayload: this.maxPayload,
                perMessageDeflate: {
                    zlibDeflateOptions: {
                        chunkSize: 1024,
                        memLevel: 7,
                        level: 3
                    },
                    zlibInflateOptions: {
                        chunkSize: 10 * 1024
                    },
                    clientNoContextTakeover: true,
                    serverNoContextTakeover: true,
                    concurrencyLimit: 10
                }
            });

            this._isInitialized = true;

            // Setup ping interval (25 seconds - less than timeout)
            this.pingInterval = setInterval(() => {
                this._pingClients();
            }, 25000);

            this.wss.on('connection', (ws, req) => {
                const clientId = this._generateClientId(req);
                const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
                
                logger.info(`New WebSocket connection from ${ip}`, { clientId });

                // Set up connection timeout
                const timeout = setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        logger.warn(`Terminating stale connection: ${clientId}`);
                        ws.terminate();
                    }
                }, this.connectionTimeout);

                // Store client with metadata
                this.clients.set(clientId, {
                    ws,
                    ip,
                    connectedAt: new Date(),
                    lastActivity: new Date(),
                    isAlive: true,
                    subscriptions: []
                });

                // Setup message handler
                ws.on('message', (message) => {
                    clearTimeout(timeout); // Reset timeout on activity
                    this.clients.get(clientId).lastActivity = new Date();
                    this._handleMessage(clientId, message);
                });

                // Handle pong responses
                ws.on('pong', () => {
                    this.clients.get(clientId).isAlive = true;
                });

                // Handle connection close
                ws.on('close', () => {
                    clearTimeout(timeout);
                    this._handleDisconnect(clientId);
                });

                // Handle errors
                ws.on('error', (error) => {
                    clearTimeout(timeout);
                    this._handleError(clientId, error);
                });

                // Send connection acknowledgement
                this.send(clientId, {
                    type: 'connection_ack',
                    status: 'connected',
                    clientId,
                    timestamp: new Date().toISOString(),
                    config: {
                        pingInterval: 25000,
                        maxPayload: this.maxPayload
                    }
                });
            });
            
            logger.info('WebSocket server initialized', {
                path: '/deployease',
                port: server.listening ? server.address().port : process.env.PORT || 3000,
                maxPayload: this.maxPayload
            });

        } catch (error) {
            this._isInitialized = false;
            logger.error('WebSocket initialization failed:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Send a message to a specific client
     * @param {string} clientId - ID of the client to send to
     * @param {Object} message - Message to send
     * @returns {boolean} True if message was sent successfully
     */
    send(clientId, message) {
        if (!this.clients.has(clientId)) {
            logger.warn(`Attempted to send message to non-existent client: ${clientId}`);
            return false;
        }

        const client = this.clients.get(clientId);
        try {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify(message), (error) => {
                    if (error) {
                        logger.error(`Failed to send message to ${clientId}:`, error);
                        return false;
                    }
                });
                return true;
            }
            return false;
        } catch (error) {
            logger.error(`Failed to send message to ${clientId}:`, {
                error: error.message,
                stack: error.stack
            });
            return false;
        }
    }

    /**
     * Broadcast message to all connected clients
     * @param {Object} message - Message to broadcast
     * @param {Function} [filter] - Optional filter function (clientId, client) => boolean
     * @returns {number} Number of clients that received the message
     */
    broadcast(message, filter = null) {
        if (!this._isInitialized) {
            logger.warn('Attempted to broadcast while WebSocket server is not initialized');
            return 0;
        }

        const messageStr = JSON.stringify(message);
        let sentCount = 0;

        this.clients.forEach((client, clientId) => {
            try {
                if (client.ws.readyState === WebSocket.OPEN && 
                    (!filter || filter(clientId, client))) {
                    client.ws.send(messageStr, (error) => {
                        if (error) {
                            logger.error(`Failed to broadcast to ${clientId}:`, error);
                        } else {
                            sentCount++;
                        }
                    });
                }
            } catch (error) {
                logger.error(`Failed to broadcast to ${clientId}:`, {
                    error: error.message,
                    stack: error.stack
                });
            }
        });

        return sentCount;
    }

    /**
     * Get connected clients count
     * @returns {number} Number of connected clients
     */
    getConnectedClients() {
        return this.clients.size;
    }

    /**
     * Close WebSocket server
     */
    close() {
        if (!this._isInitialized) return;

        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        
        this.clients.forEach(client => {
            try {
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.close(1000, 'Server shutdown');
                }
            } catch (error) {
                logger.error('Error closing client connection:', {
                    error: error.message,
                    stack: error.stack
                });
            }
        });

        if (this.wss) {
            this.wss.close((error) => {
                if (error) {
                    logger.error('Error closing WebSocket server:', {
                        error: error.message,
                        stack: error.stack
                    });
                } else {
                    logger.info('WebSocket server closed gracefully');
                }
                this._isInitialized = false;
                this.wss = null;
            });
        }
    }

    // ==================== PRIVATE METHODS ====================

    _generateClientId(req) {
        return req.headers['sec-websocket-key'] || 
               `client-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    }

    _handleMessage(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client) return;

        try {
            const data = JSON.parse(message);
            logger.debug(`Message from ${clientId}`, { 
                type: data.type,
                size: message.length 
            });

            switch(data.type) {
                case 'subscribe':
                    this._handleSubscribe(clientId, data);
                    break;
                case 'ping':
                    this.send(clientId, { 
                        type: 'pong',
                        timestamp: new Date().toISOString()
                    });
                    break;
                case 'unsubscribe':
                    this._handleUnsubscribe(clientId, data);
                    break;
                default:
                    this.broadcast(data);
            }
        } catch (error) {
            logger.error(`Error processing message from ${clientId}:`, {
                error: error.message,
                stack: error.stack,
                message: message.toString()
            });
            
            // Send error response to client
            this.send(clientId, {
                type: 'error',
                message: 'Invalid message format',
                timestamp: new Date().toISOString()
            });
        }
    }

    _handleSubscribe(clientId, data) {
        if (!data.channels || !Array.isArray(data.channels)) {
            this.send(clientId, {
                type: 'error',
                message: 'Invalid subscription format',
                timestamp: new Date().toISOString()
            });
            return;
        }

        // Store subscription channels for the client
        const client = this.clients.get(clientId);
        if (client) {
            client.subscriptions = data.channels;
        }

        this.send(clientId, {
            type: 'subscription_ack',
            status: 'subscribed',
            channels: data.channels,
            timestamp: new Date().toISOString()
        });
    }

    _handleUnsubscribe(clientId, data) {
        const client = this.clients.get(clientId);
        if (client && client.subscriptions) {
            if (data.channels) {
                client.subscriptions = client.subscriptions.filter(
                    channel => !data.channels.includes(channel)
                );
            } else {
                client.subscriptions = [];
            }
        }

        this.send(clientId, {
            type: 'unsubscription_ack',
            status: 'unsubscribed',
            timestamp: new Date().toISOString()
        });
    }

    _handleDisconnect(clientId) {
        if (this.clients.has(clientId)) {
            const client = this.clients.get(clientId);
            logger.info(`Client disconnected: ${clientId}`, {
                ip: client.ip,
                duration: new Date() - client.connectedAt
            });
            this.clients.delete(clientId);
        }
    }

    _handleError(clientId, error) {
        logger.error(`WebSocket error (${clientId}):`, {
            error: error.message,
            stack: error.stack
        });

        if (this.clients.has(clientId)) {
            try {
                this.clients.get(clientId).ws.terminate();
            } catch (terminateError) {
                logger.error(`Error terminating client ${clientId}:`, {
                    error: terminateError.message,
                    stack: terminateError.stack
                });
            }
            this.clients.delete(clientId);
        }
    }

    _pingClients() {
        this.clients.forEach((client, clientId) => {
            if (!client.isAlive) {
                logger.warn(`Terminating unresponsive client: ${clientId}`, {
                    ip: client.ip,
                    lastActivity: client.lastActivity
                });
                client.ws.terminate();
                return this.clients.delete(clientId);
            }

            client.isAlive = false;
            try {
                client.ws.ping(null, false, (err) => {
                    if (err) {
                        logger.error(`Ping failed for ${clientId}:`, {
                            error: err.message,
                            stack: err.stack
                        });
                        client.ws.terminate();
                        this.clients.delete(clientId);
                    }
                });
            } catch (error) {
                logger.error(`Error sending ping to ${clientId}:`, {
                    error: error.message,
                    stack: error.stack
                });
                this.clients.delete(clientId);
            }
        });
    }
}

module.exports = new WebSocketService();