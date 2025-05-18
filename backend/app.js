/**
 * Main application server for DeployEase
 * Handles Express server initialization, routes setup, and WebSocket integration
 */

// Core dependencies
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const morgan = require('morgan');
const dotenv = require('dotenv');
const fs = require('fs');

// Load environment variables
dotenv.config();

// Initialize logger
const logger = require('./server/utils/logger');

// Import services
const websocketService = require('./server/services/websocketService');

// Import route handlers
const deploymentRoutes = require('./server/routes/deployments');
const environmentRoutes = require('./server/routes/environments');
const gitRoutes = require('./server/routes/git');

// Constants
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;
const CONNECTION_RETRY_LIMIT = 5;
const CONNECTION_RETRY_TIMEOUT = 5000; // 5 seconds

// Application state
let retryCount = 0;
let retryTimeout = null;
let deploymentStatusCache = {
  blue: null,
  green: null,
  lastChecked: null
};

// Create Express app
const app = express();

// Create HTTP server
const server = http.createServer(app);

// Configure middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Set up request logging
if (NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  // Create a write stream for access logs in production
  const accessLogStream = fs.createWriteStream(
    path.join(__dirname, 'logs', 'access.log'),
    { flags: 'a' }
  );
  app.use(morgan('combined', { stream: accessLogStream }));
}

// Configure routes
app.use('/api/deployments', deploymentRoutes);
app.use('/api/environments', environmentRoutes);
app.use('/api/git', gitRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  const healthData = {
    status: 'UP',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    websocket: {
      connected: websocketService.isConnected(),
      clients: websocketService.getClientCount(),
      retryCount: retryCount
    },
    server: {
      uptime: process.uptime(),
      port: PORT
    }
  };
  res.json(healthData);
});

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({
    message: 'Route not found',
    path: req.originalUrl
  });
});

// Error handler
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  logger.error(`Error: ${err.message}`);
  logger.error(err.stack);
  
  res.status(statusCode).json({
    message: err.message,
    error: NODE_ENV === 'development' ? err : {}
  });
});

/**
 * Initialize WebSocket service with retry capability
 */
function initializeWebSocket() {
  if (retryCount >= CONNECTION_RETRY_LIMIT) {
    logger.warn(`WebSocket initialization failed after ${CONNECTION_RETRY_LIMIT} attempts. Continuing without WebSocket functionality.`);
    return Promise.resolve(false);
  }

  retryCount++;
  logger.info(`WebSocket initialization attempt ${retryCount}/${CONNECTION_RETRY_LIMIT}`);

  return websocketService.init(WS_PORT)
    .then(() => {
      logger.info(`WebSocket server successfully initialized on port ${WS_PORT}`);
      retryCount = 0; // Reset counter on success
      return true;
    })
    .catch(err => {
      logger.error(`WebSocket initialization failed (attempt ${retryCount}/${CONNECTION_RETRY_LIMIT}): ${err.message || 'Unknown error'}`);
      
      if (retryCount < CONNECTION_RETRY_LIMIT) {
        logger.info(`Retrying WebSocket initialization in ${CONNECTION_RETRY_TIMEOUT / 1000} seconds...`);
        
        // Clear any existing timeout to prevent memory leaks
        if (retryTimeout) {
          clearTimeout(retryTimeout);
        }
        
        // Set up retry
        return new Promise(resolve => {
          retryTimeout = setTimeout(() => {
            initializeWebSocket().then(resolve);
          }, CONNECTION_RETRY_TIMEOUT);
        });
      }
      return false;
    });
}

/**
 * Get cached deployment status or fetch new status
 * Implements circuit breaker pattern to prevent continuous failing calls
 */
function getDeploymentStatus(branch) {
  // Check if we have a recent cache (less than 60 seconds old)
  const now = Date.now();
  if (
    deploymentStatusCache[branch] && 
    deploymentStatusCache.lastChecked && 
    now - deploymentStatusCache.lastChecked < 60000
  ) {
    return Promise.resolve(deploymentStatusCache[branch]);
  }

  // Fetch new status (implementation would be in a service)
  // This is a placeholder for your actual implementation
  return Promise.resolve({ status: 'unknown' })
    .then(status => {
      // Update cache
      deploymentStatusCache[branch] = status;
      deploymentStatusCache.lastChecked = now;
      return status;
    })
    .catch(err => {
      logger.error(`Failed to get deployment status for branch ${branch}: ${err.message}`);
      // On error, return cached value if available, otherwise unknown
      return deploymentStatusCache[branch] || { status: 'unknown' };
    });
}

/**
 * Start the server and initialize services
 */
function startServer() {
  return new Promise((resolve, reject) => {
    // Start HTTP server
    server.listen(PORT, err => {
      if (err) {
        logger.error(`Error starting server: ${err.message}`);
        return reject(err);
      }
      
      logger.info(`Server running in ${NODE_ENV} mode on port ${PORT}`);
      resolve();
    });
  });
}

/**
 * Graceful shutdown handler
 */
function shutdown() {
  logger.info('SIGINT received - shutting down');
  
  // Close WebSocket server
  websocketService.close()
    .then(() => {
      logger.info('WebSocket server closed gracefully');
      
      // Close HTTP server
      server.close(() => {
        logger.info('Server stopped');
        process.exit(0);
      });
    })
    .catch(err => {
      logger.error(`Error during WebSocket shutdown: ${err.message}`);
      // Force exit after timeout
      setTimeout(() => {
        logger.warn('Forcing exit after failed graceful shutdown');
        process.exit(1);
      }, 3000);
    });
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught exceptions
process.on('uncaughtException', err => {
  logger.error(`uncaughtException: ${err.message}`);
  logger.error(err.stack);
  
  // Attempt graceful shutdown
  shutdown();
});

// Start the server and initialize WebSocket
startServer()
  .then(() => initializeWebSocket())
  .catch(err => {
    logger.error(`Failed to start the application: ${err.message}`);
    process.exit(1);
  });

module.exports = app;