// backend/server/controllers/gitController.js
const gitService = require('../services/gitService');
const ghAuth = require('../middlewares/ghAuth');
const logger = require('../utils/logger');
const { validateDeploymentPayload } = require('../validators/gitValidators');
const REPOSITORY_URL = 'https://github.com/Aswanthrajan/blue';

class GitController {
  /**
   * Initialize repository with blue-green branches
   * @returns {Promise<{status: string, branches: object}>}
   */
  async initializeRepository(req, res) {
    try {
      // Verify repository access first
      await ghAuth.verifyRepositoryAccess();
      
      const result = await gitService.initializeRepository();
      
      logger.info(`Repository initialized: ${REPOSITORY_URL}`, {
        branches: result.branches
      });

      res.status(200).json({
        success: true,
        repository: REPOSITORY_URL,
        ...result
      });
    } catch (error) {
      logger.error('Repository initialization failed', {
        error: error.message,
        repository: REPOSITORY_URL
      });
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
        repository: REPOSITORY_URL
      });
    }
  }

  /**
   * Deploy files to specified environment
   * @param {string} branch - Target branch (blue/green)
   * @param {Array} files - Files to deploy
   * @param {string} commitMessage - Custom commit message
   * @returns {Promise<{commitUrl: string, branch: string}>}
   */
  async deployToEnvironment(req, res) {
    try {
      const { error } = validateDeploymentPayload(req.body);
      if (error) throw new Error(`Invalid payload: ${error.details[0].message}`);

      const { branch, files, commitMessage } = req.body;
      
      // Verify write access before deployment
      const { hasWriteAccess } = await ghAuth.verifyRepositoryAccess();
      if (!hasWriteAccess) {
        throw new Error('Insufficient permissions for deployment');
      }

      const result = await gitService.deployToBranch(
        branch,
        files,
        commitMessage || `DeployEase: Automated deployment to ${branch} branch`
      );

      logger.info(`Deployment successful to ${branch} branch`, {
        commitUrl: result.commitUrl,
        repository: REPOSITORY_URL
      });

      res.status(200).json({
        success: true,
        repository: REPOSITORY_URL,
        ...result
      });
    } catch (error) {
      logger.error('Deployment failed', {
        error: error.message,
        repository: REPOSITORY_URL,
        payload: req.body
      });
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
        repository: REPOSITORY_URL
      });
    }
  }

  /**
   * Switch active environment
   * @param {string} targetBranch - Branch to switch to (blue/green)
   * @returns {Promise<{redirectsUrl: string, activeBranch: string}>}
   */
  async switchEnvironment(req, res) {
    try {
      const { targetBranch } = req.body;
      
      if (!['blue', 'green'].includes(targetBranch)) {
        throw new Error('Invalid target branch specified');
      }

      // Verify admin access for environment switching
      const { permissions } = await ghAuth.verifyRepositoryAccess();
      if (permissions.permission !== 'admin') {
        throw new Error('Admin privileges required for environment switching');
      }

      const currentBranch = await gitService.getActiveBranch();
      if (currentBranch === targetBranch) {
        return res.status(200).json({
          success: true,
          message: `Already on ${targetBranch} environment`,
          activeBranch: targetBranch,
          repository: REPOSITORY_URL
        });
      }

      const result = await gitService.switchEnvironment(targetBranch);

      logger.info(`Environment switched to ${targetBranch}`, {
        repository: REPOSITORY_URL,
        commitUrl: result.commitUrl
      });

      res.status(200).json({
        success: true,
        repository: REPOSITORY_URL,
        ...result
      });
    } catch (error) {
      logger.error('Environment switch failed', {
        error: error.message,
        repository: REPOSITORY_URL
      });
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
        repository: REPOSITORY_URL
      });
    }
  }

  /**
   * Get current deployment status
   * @returns {Promise<{activeBranch: string, branches: object}>}
   */
  async getDeploymentStatus(req, res) {
    try {
      const [activeBranch, branches] = await Promise.all([
        gitService.getActiveBranch(),
        gitService.listBranches()
      ]);

      res.status(200).json({
        success: true,
        repository: REPOSITORY_URL,
        activeBranch,
        branches,
        redirectsFile: `${REPOSITORY_URL}/blob/main/_redirects`
      });
    } catch (error) {
      logger.error('Failed to get deployment status', {
        error: error.message,
        repository: REPOSITORY_URL
      });
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
        repository: REPOSITORY_URL
      });
    }
  }
}

module.exports = new GitController();