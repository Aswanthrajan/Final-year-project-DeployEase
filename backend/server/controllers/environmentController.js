// backend/server/controllers/environmentController.js
const gitService = require('../services/gitService');
const netlifyService = require('../services/netlifyService');
const redirectService = require('../services/redirectService');
const logger = require('../utils/logger');
const websocketService = require('../services/websocketService');

// Cache environment status to reduce API calls
const statusCache = {
  lastUpdated: null,
  data: null,
  ttl: 30000 // 30 seconds cache
};

const getEnvironmentStatus = async (req, res) => {
  try {
    // Check cache first
    if (statusCache.data && Date.now() - statusCache.lastUpdated < statusCache.ttl) {
      statusCache.data.cache = { cached: true };
      return res.status(200).json(statusCache.data);
    }

    const [activeBranch, blueDeploy, greenDeploy] = await Promise.allSettled([
      redirectService.getActiveBranch(),
      netlifyService.getLatestDeploy('blue'),
      netlifyService.getLatestDeploy('green')
    ]);

    // Determine active branch with fallback
    const currentBranch = activeBranch.status === 'fulfilled' ? 
      activeBranch.value : 'blue';

    // Prepare environment data with fallbacks
    const environmentData = {
      blue: {
        status: currentBranch === 'blue' ? 'active' : 'inactive',
        branch: 'blue',
        url: process.env.NETLIFY_BLUE_URL || `${process.env.NETLIFY_SITE_URL}/blue`,
        deployStatus: blueDeploy.status === 'fulfilled' ? blueDeploy.value : { error: 'Status unavailable' },
        lastUpdated: new Date().toISOString()
      },
      green: {
        status: currentBranch === 'green' ? 'active' : 'inactive',
        branch: 'green',
        url: process.env.NETLIFY_GREEN_URL || `${process.env.NETLIFY_SITE_URL}/green`,
        deployStatus: greenDeploy.status === 'fulfilled' ? greenDeploy.value : { error: 'Status unavailable' },
        lastUpdated: new Date().toISOString()
      },
      activeBranch: currentBranch,
      timestamp: new Date().toISOString(),
      cache: {
        cached: false,
        ttl: statusCache.ttl
      }
    };

    // Update cache
    statusCache.data = environmentData;
    statusCache.lastUpdated = Date.now();

    res.status(200).json(environmentData);
  } catch (error) {
    logger.error('Failed to fetch environment status', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    // Return cached data if available
    if (statusCache.data) {
      statusCache.data.cache = { cached: true, stale: true };
      return res.status(200).json(statusCache.data);
    }

    res.status(500).json({
      success: false,
      message: "Failed to fetch environment status",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

const switchTraffic = async (req, res) => {
  try {
    const { targetBranch } = req.body;
    
    // Validate target branch
    if (!['blue', 'green'].includes(targetBranch)) {
      return res.status(400).json({
        success: false,
        message: "Invalid target branch specified",
        validBranches: ['blue', 'green'],
        timestamp: new Date().toISOString()
      });
    }

    // Get current branch
    const currentBranch = await redirectService.getActiveBranch();
    
    // Check if already on target branch
    if (currentBranch === targetBranch) {
      return res.status(200).json({
        success: true,
        message: `Already on ${targetBranch} environment`,
        activeBranch: targetBranch,
        changed: false,
        timestamp: new Date().toISOString()
      });
    }

    // Execute switch operations in parallel
    const [redirectResult, purgeResult] = await Promise.all([
      redirectService.updateRedirects(targetBranch),
      netlifyService.purgeCache()
    ]);

    // Invalidate cache
    statusCache.lastUpdated = null;

    // Notify all connected clients via WebSocket
    websocketService.broadcast({
      type: 'environment_switch',
      newActive: targetBranch,
      timestamp: new Date().toISOString()
    });

    logger.info(`Traffic switched to ${targetBranch}`, {
      repository: process.env.REPOSITORY_URL,
      commitUrl: redirectResult.commitUrl,
      branch: targetBranch,
      timestamp: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      message: `Traffic switched to ${targetBranch}`,
      activeBranch: targetBranch,
      changed: true,
      redirects: {
        commitUrl: redirectResult.commitUrl,
        rulesPreview: redirectResult.rulesPreview
      },
      cachePurge: {
        purgedAt: new Date().toISOString(),
        success: purgeResult.success
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Environment switch failed', {
      error: error.message,
      stack: error.stack,
      repository: process.env.REPOSITORY_URL,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      message: "Environment switch failed",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

module.exports = {
  getEnvironmentStatus,
  switchTraffic
};