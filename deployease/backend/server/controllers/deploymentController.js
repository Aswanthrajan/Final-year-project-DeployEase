// backend/server/controllers/deploymentController.js
const gitService = require('../services/gitService');
const netlifyService = require('../services/netlifyService');
const logger = require('../utils/logger');

class DeploymentController {
    /**
     * Get deployment history for an environment (blue/green)
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
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
            
            res.status(200).json({
                success: true,
                branch,
                deployments: history,
                repository: process.env.REPOSITORY_URL
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
     * Create a new deployment to specified environment
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
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
                deployId: netlifyResult.deployId
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
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
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