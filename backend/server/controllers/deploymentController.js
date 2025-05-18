// backend/server/controllers/deploymentController.js
const gitService = require('../services/gitService');
const netlifyService = require('../services/netlifyService');
const logger = require('../utils/logger');

class DeploymentController {
    /**
     * Get deployment history for all environments (blue and green)
     */
    async getAllDeploymentHistory(req, res) {
        try {
            // Get history for both branches in parallel
            const [blueHistory, greenHistory] = await Promise.all([
                gitService.getDeploymentHistory('blue'),
                gitService.getDeploymentHistory('green')
            ]);

            // Standardize the history format
            const formatDeployment = (deployment, branch) => {
                return {
                    id: deployment.id || deployment.sha?.slice(0, 7),
                    branch: branch,
                    status: deployment.state || 'success',
                    timestamp: deployment.timestamp || deployment.commit?.committer?.date || new Date().toISOString(),
                    commitSha: deployment.sha,
                    commitUrl: deployment.html_url,
                    commitMessage: deployment.commit?.message || `Deployment to ${branch}`,
                    committer: deployment.commit?.committer?.name || 'DeployEase System'
                };
            };

            res.status(200).json({
                success: true,
                blue: blueHistory.map(d => formatDeployment(d, 'blue')),
                green: greenHistory.map(d => formatDeployment(d, 'green')),
                repository: process.env.REPOSITORY_URL,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error('Failed to get deployment history', {
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                message: "Failed to get deployment history",
                error: error.message
            });
        }
    }

    /**
     * Get deployment history for a specific branch
     */
    async getDeploymentHistory(req, res) {
        try {
            const { branch } = req.params;
            
            if (!['blue', 'green'].includes(branch)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid branch specified. Must be 'blue' or 'green'"
                });
            }

            const history = await gitService.getDeploymentHistory(branch);
            
            // Format the response consistently
            const formattedHistory = history.map(deployment => ({
                id: deployment.id || deployment.sha?.slice(0, 7),
                branch: branch,
                status: deployment.state || 'success',
                timestamp: deployment.timestamp || deployment.commit?.committer?.date || new Date().toISOString(),
                commitSha: deployment.sha,
                commitUrl: deployment.html_url,
                commitMessage: deployment.commit?.message || `Deployment to ${branch}`,
                committer: deployment.commit?.committer?.name || 'DeployEase System'
            }));

            res.status(200).json({
                success: true,
                branch,
                deployments: formattedHistory,
                repository: process.env.REPOSITORY_URL,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error('Failed to fetch deployment history', {
                error: error.message,
                stack: error.stack
            });
            res.status(500).json({
                success: false,
                message: "Failed to fetch deployment history",
                error: error.message
            });
        }
    }

    /**
     * Create a new deployment
     */
    async createDeployment(req, res) {
        try {
            const { branch, files, commitMessage } = req.body;

            // Validate input
            if (!branch || !files) {
                return res.status(400).json({
                    success: false,
                    message: "Branch and files are required"
                });
            }

            if (!['blue', 'green'].includes(branch)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid branch specified. Must be 'blue' or 'green'"
                });
            }

            // Deploy to GitHub branch
            const gitResult = await gitService.deployToBranch(
                branch,
                files,
                commitMessage || `DeployEase: ${branch} deployment`
            );

            // Trigger Netlify build
            const netlifyResult = await netlifyService.triggerDeploy(branch);

            logger.info('Deployment successful', {
                branch,
                commitUrl: gitResult.commitUrl,
                deployId: netlifyResult.deployId,
                files: files.map(f => f.path)
            });

            res.status(200).json({
                success: true,
                message: `Deployment to ${branch} started`,
                git: gitResult,
                netlify: netlifyResult,
                deployId: `${branch}-${Date.now()}`
            });
        } catch (error) {
            logger.error('Deployment failed', {
                error: error.message,
                stack: error.stack,
                payload: req.body
            });
            res.status(500).json({
                success: false,
                message: "Deployment failed",
                error: error.message
            });
        }
    }

    /**
     * Rollback to a specific commit
     */
    async rollbackToRevision(req, res) {
        try {
            const { branch, commitSha } = req.params;

            if (!['blue', 'green'].includes(branch)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid branch specified. Must be 'blue' or 'green'"
                });
            }

            // Revert to specific commit in GitHub
            const gitResult = await gitService.rollbackToCommit(branch, commitSha);

            // Trigger Netlify build
            const netlifyResult = await netlifyService.triggerDeploy(branch);

            logger.info('Rollback successful', {
                branch,
                commitSha,
                commitUrl: gitResult.commitUrl,
                deployId: netlifyResult.deployId
            });

            res.status(200).json({
                success: true,
                message: `Rolled back ${branch} to commit ${commitSha.slice(0, 7)}`,
                git: gitResult,
                netlify: netlifyResult
            });
        } catch (error) {
            logger.error('Rollback failed', {
                error: error.message,
                stack: error.stack,
                params: req.params
            });
            res.status(500).json({
                success: false,
                message: "Rollback failed",
                error: error.message
            });
        }
    }
}

module.exports = new DeploymentController();