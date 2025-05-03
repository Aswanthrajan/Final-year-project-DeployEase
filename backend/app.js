require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const logger = require('./server/utils/logger');
const http = require('http');

// Initialize services first
const netlifyService = require('./server/services/netlifyService');
const websocketService = require('./server/services/websocketService');

// Import routes
const deploymentsRouter = require('./server/routes/deployments');
const environmentsRouter = require('./server/routes/environments.js');
const gitRouter = require('./server/routes/git');

// Create Express app
const app = express();

// Configuration
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Create HTTP server explicitly for WebSocket
const server = http.createServer(app);

// Enhanced CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Socket-ID'],
  credentials: true,
  exposedHeaders: ['X-Socket-ID']
};
app.use(cors(corsOptions));

// Body parser middleware with limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Enhanced request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// API Routes
app.use('/api/deployments', deploymentsRouter);
app.use('/api/environments', environmentsRouter);
app.use('/api/git', gitRouter);

// Enhanced Health Check Endpoint
app.get('/api/health', async (req, res) => {
  try {
    const [netlifyStatus, wsStatus] = await Promise.all([
      netlifyService.verifyConnection(),
      {
        connectedClients: websocketService.getConnectedClients(),
        status: websocketService.isInitialized() ? 'active' : 'inactive'
      }
    ]);

    res.json({
      status: 'healthy',
      version: process.env.npm_package_version || '1.0.0',
      environment: NODE_ENV,
      uptime: process.uptime(),
      services: {
        netlify: netlifyStatus,
        websocket: wsStatus,
        database: 'ok'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'degraded',
      error: 'Service unavailable',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// WebSocket status endpoint
app.get('/api/websocket', (req, res) => {
  res.json({
    enabled: process.env.ENABLE_WEBSOCKET !== 'false',
    path: '/deployease',
    connectedClients: websocketService.getConnectedClients(),
    status: websocketService.isInitialized() ? 'active' : 'inactive'
  });
});

// Enhanced Error Handling Middleware
app.use((err, req, res, next) => {
  const statusCode = err.status || 500;
  const errorId = require('crypto').randomBytes(8).toString('hex');
  
  logger.error(`Request Error [${errorId}]: ${req.method} ${req.originalUrl}`, {
    error: err.message,
    stack: err.stack,
    statusCode,
    body: req.body,
    params: req.params
  });

  res.status(statusCode).json({
    error: NODE_ENV === 'development' ? {
      message: err.message,
      stack: err.stack,
      errorId
    } : {
      message: 'An unexpected error occurred',
      errorId
    },
    timestamp: new Date().toISOString()
  });
});

// Frontend Fallback (if serving frontend from backend)
if (process.env.SERVE_FRONTEND === 'true') {
  const frontendPath = path.join(__dirname, '../../frontend/public');
  
  // Serve static files with cache control
  app.use(express.static(frontendPath, {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0'
  }));

  // Handle SPA routing
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// Server Initialization
const startServer = async () => {
  try {
    // Verify Netlify connection first
    await netlifyService.verifyConnection();
    logger.info('Netlify service connected successfully');

    // Initialize WebSocket server before starting HTTP server
    if (process.env.ENABLE_WEBSOCKET !== 'false') {
      websocketService.init(server);
      logger.info('WebSocket service initialized at /deployease');
    }

    // Start HTTP server
    server.listen(PORT, () => {
      logger.info(`Server running in ${NODE_ENV} mode on port ${PORT}`);
      if (websocketService.isInitialized()) {
        logger.info(`WebSocket available at ws://localhost:${PORT}/deployease`);
      }
    });

    // Enhanced graceful shutdown
    const shutdown = (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);
      
      // Close WebSocket server first
      if (websocketService.isInitialized()) {
        websocketService.close();
      }

      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });

      // Force shutdown after timeout
      setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      shutdown('uncaughtException');
    });

  } catch (error) {
    logger.error('Server startup failed:', error);
    process.exit(1);
  }
};

// Start the server
startServer();

module.exports = app;