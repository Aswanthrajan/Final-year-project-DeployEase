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

// Store original branch configuration for rollback capability
const originalConfig = {
  blue: 'blue',
  green: 'green',
  initialActiveBranch: 'blue' // Default initial active branch is blue
};

class EnvironmentController {
    /**
     * Get status of both environments with caching
     */
    async getEnvironmentStatus(req, res) {
        try {
            // Check cache first
            if (statusCache.data && Date.now() - statusCache.lastUpdated < statusCache.ttl) {
                statusCache.data.cache = { cached: true };
                return res.status(200).json(statusCache.data);
            }

            const [activeBranch, blueDeploy, greenDeploy, blueHealth, greenHealth] = await Promise.allSettled([
                redirectService.getActiveBranch(),
                netlifyService.getLatestDeploy('blue'),
                netlifyService.getLatestDeploy('green'),
                netlifyService.getBranchHealth('blue'),
                netlifyService.getBranchHealth('green')
            ]);

            // Determine active branch with fallback
            const currentBranch = activeBranch.status === 'fulfilled' ? 
                activeBranch.value : null;

            // Prepare environment data with fallbacks
            const environmentData = {
                success: true,
                blue: {
                    status: currentBranch === 'blue' ? 'active' : 'inactive',
                    branch: 'blue',
                    url: 'https://blue--deployeaselive.netlify.app/',
                    deployStatus: blueDeploy.status === 'fulfilled' ? blueDeploy.value : { error: 'Status unavailable' },
                    health: blueHealth.status === 'fulfilled' ? blueHealth.value : 'unknown',
                    lastUpdated: new Date().toISOString()
                },
                green: {
                    status: currentBranch === 'green' ? 'active' : 'inactive',
                    branch: 'green',
                    url: 'https://green--deployeaselive.netlify.app/',
                    deployStatus: greenDeploy.status === 'fulfilled' ? greenDeploy.value : { error: 'Status unavailable' },
                    health: greenHealth.status === 'fulfilled' ? greenHealth.value : 'unknown',
                    lastUpdated: new Date().toISOString()
                },
                activeBranch: currentBranch,
                isSwapped: currentBranch !== originalConfig.initialActiveBranch,
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
    }

    /**
     * Switch traffic between blue and green environments
     */
    async switchTraffic(req, res) {
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
            const [redirectResult, purgeResult, deployResult] = await Promise.all([
                redirectService.updateRedirects(targetBranch),
                netlifyService.purgeCache(),
                netlifyService.triggerDeploy('main')
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
                previousEnvironment: currentBranch,
                activeEnvironment: targetBranch,
                changed: true,
                redirects: {
                    commitUrl: redirectResult.commitUrl,
                    rulesPreview: redirectResult.rulesPreview,
                    updated: redirectResult.updated
                },
                cachePurge: {
                    purgedAt: new Date().toISOString(),
                    success: purgeResult.success
                },
                deployTriggered: deployResult.success,
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
    }

    /**
     * Rollback to the original environment configuration
     */
    async rollbackEnvironment(req, res) {
        try {
            // Get current active branch
            const currentBranch = await redirectService.getActiveBranch();
            
            // If already on the initial branch, no need to rollback
            if (currentBranch === originalConfig.initialActiveBranch) {
                return res.status(200).json({
                    success: true,
                    message: `Already on initial environment (${originalConfig.initialActiveBranch})`,
                    activeBranch: currentBranch,
                    changed: false,
                    timestamp: new Date().toISOString()
                });
            }
            
            // Execute rollback to initial branch
            const [redirectResult, purgeResult, deployResult] = await Promise.all([
                redirectService.updateRedirects(originalConfig.initialActiveBranch),
                netlifyService.purgeCache(),
                netlifyService.triggerDeploy('main')
            ]);

            // Invalidate cache
            statusCache.lastUpdated = null;

            // Notify all connected clients via WebSocket
            websocketService.broadcast({
                type: 'environment_rollback',
                newActive: originalConfig.initialActiveBranch,
                previousActive: currentBranch,
                timestamp: new Date().toISOString()
            });

            logger.info(`Environment rolled back to ${originalConfig.initialActiveBranch}`, {
                repository: process.env.REPOSITORY_URL,
                commitUrl: redirectResult.commitUrl,
                previousBranch: currentBranch,
                timestamp: new Date().toISOString()
            });

            res.status(200).json({
                success: true,
                message: `Environment rolled back to ${originalConfig.initialActiveBranch}`,
                previousEnvironment: currentBranch,
                activeEnvironment: originalConfig.initialActiveBranch,
                changed: true,
                redirects: {
                    commitUrl: redirectResult.commitUrl,
                    rulesPreview: redirectResult.rulesPreview,
                    updated: redirectResult.updated
                },
                cachePurge: {
                    purgedAt: new Date().toISOString(),
                    success: purgeResult.success
                },
                deployTriggered: deployResult.success,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error('Environment rollback failed', {
                error: error.message,
                stack: error.stack,
                repository: process.env.REPOSITORY_URL,
                timestamp: new Date().toISOString()
            });

            res.status(500).json({
                success: false,
                message: "Environment rollback failed",
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Get status of both environments (legacy version)
     * @deprecated Use getEnvironmentStatus instead
     */
    async getEnvironmentsStatus(req, res) {
        try {
            // Get current active branch from redirect rules
            const activeBranch = await redirectService.getActiveBranch();
            
            // Get health status from Netlify for both branches
            const [blueHealth, greenHealth] = await Promise.all([
                netlifyService.getBranchHealth('blue'),
                netlifyService.getBranchHealth('green')
            ]);
            
            res.status(200).json({
                success: true,
                blue: {
                    status: activeBranch === 'blue' ? 'active' : 'inactive',
                    health: blueHealth || 'unknown',
                    url: 'https://blue--deployeaselive.netlify.app/'
                },
                green: {
                    status: activeBranch === 'green' ? 'active' : 'inactive',
                    health: greenHealth || 'unknown',
                    url: 'https://green--deployeaselive.netlify.app/'
                },
                activeBranch: activeBranch,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error('Failed to get environment status', {
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                message: "Failed to get environment status",
                error: error.message
            });
        }
    }

    /**
     * Switch traffic between blue and green environments (legacy version)
     * @deprecated Use switchTraffic instead
     */
    async legacySwitchTraffic(req, res) {
        try {
            // Get current active branch
            const currentActive = await redirectService.getActiveBranch();
            
            // Switch to the other branch
            const targetBranch = currentActive === 'blue' ? 'green' : 'blue';
            
            // Update redirects in GitHub and trigger Netlify rebuild
            const result = await redirectService.updateRedirects(targetBranch);
            
            // Force Netlify to rebuild the site to pick up the new redirects
            await netlifyService.triggerDeploy('main');
            
            // Return updated status
            res.status(200).json({
                success: true,
                message: `Traffic switched to ${targetBranch}`,
                previousEnvironment: currentActive,
                activeEnvironment: targetBranch,
                updated: result.updated,
                redirectsUrl: result.commitUrl
            });
        } catch (error) {
            logger.error('Failed to switch traffic', {
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                message: "Failed to switch traffic",
                error: error.message
            });
        }
    }
}

module.exports = new EnvironmentController();