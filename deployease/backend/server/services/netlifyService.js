// backend/server/services/netlifyService.js
const axios = require('axios');
const logger = require('../utils/logger');

class NetlifyService {
  constructor() {
    if (!process.env.NETLIFY_TOKEN || !process.env.NETLIFY_SITE_ID) {
      throw new Error('Missing required Netlify configuration (NETLIFY_TOKEN and NETLIFY_SITE_ID)');
    }

    this.api = axios.create({
      baseURL: 'https://api.netlify.com/api/v1',
      timeout: 30000, // 30 seconds timeout
      headers: {
        'Authorization': `Bearer ${process.env.NETLIFY_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DeployEase/2.0',
        'Accept': 'application/json'
      }
    });

    this.siteId = process.env.NETLIFY_SITE_ID;
    this.cache = {
      deployments: new Map(),
      status: new Map(),
      ttl: 60000 // Cache for 60 seconds
    };
  }

  /**
   * Verify Netlify connection and site configuration
   * @returns {Promise<Object>} Connection status and site info
   */
  async verifyConnection() {
    try {
      const response = await this.api.get(`/sites/${this.siteId}`);
      logger.info('Netlify connection verified', {
        site: response.data.name,
        url: response.data.ssl_url
      });

      return {
        connected: true,
        siteName: response.data.name,
        url: response.data.ssl_url || response.data.url,
        adminUrl: `https://app.netlify.com/sites/${response.data.name}`,
        repoUrl: response.data.build_settings.repo_url,
        lastDeployed: response.data.published_deploy?.published_at
      };
    } catch (error) {
      logger.error('Netlify connection failed:', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      throw this._formatError(error, 'Failed to connect to Netlify API');
    }
  }

  /**
   * Trigger a new deployment for a specific branch
   * @param {string} branch - Branch to deploy (blue/green)
   * @returns {Promise<Object>} Deployment data
   */
  async triggerDeploy(branch) {
    try {
      if (!['blue', 'green'].includes(branch)) {
        throw new Error('Invalid branch. Must be "blue" or "green"');
      }

      const hookUrl = process.env[`NETLIFY_${branch.toUpperCase()}_HOOK`];
      let response;

      if (hookUrl) {
        // Use build hook if available
        response = await axios.post(hookUrl, {}, {
          headers: { 'Content-Type': 'application/json' }
        });
        
        // Need to fetch deploy details separately
        const deployId = response.data.id;
        return await this.getDeployStatus(deployId);
      } else {
        // Fallback to API deployment
        response = await this.api.post(`/sites/${this.siteId}/builds`, {
          branch,
          clear_cache: true
        });

        const deployData = {
          id: response.data.id,
          url: response.data.deploy_ssl_url,
          state: response.data.state,
          branch: response.data.branch,
          createdAt: new Date(response.data.created_at),
          commitRef: response.data.commit_ref,
          commitUrl: response.data.links?.permalink
        };

        this._updateCache(response.data.id, deployData);
        return deployData;
      }
    } catch (error) {
      logger.error('Deployment failed:', {
        error: error.message,
        branch,
        status: error.response?.status,
        data: error.response?.data
      });
      throw this._formatError(error, 'Failed to trigger deployment');
    }
  }

  /**
   * Get deployment status by ID
   * @param {string} deployId - Deployment ID
   * @returns {Promise<Object>} Deployment status
   */
  async getDeployStatus(deployId) {
    try {
      // Check cache first
      const cached = this.cache.status.get(deployId);
      if (cached && Date.now() - cached.timestamp < this.cache.ttl) {
        return cached.data;
      }

      const response = await this.api.get(`/sites/${this.siteId}/deploys/${deployId}`);
      
      const statusData = {
        id: response.data.id,
        state: response.data.state,
        branch: response.data.branch,
        url: response.data.ssl_url,
        updatedAt: new Date(response.data.updated_at),
        commitRef: response.data.commit_ref,
        commitUrl: response.data.links?.permalink,
        error: response.data.error_message
      };

      this._updateCache(deployId, statusData);
      return statusData;
    } catch (error) {
      logger.error('Status check failed:', {
        deployId,
        error: error.message,
        status: error.response?.status
      });
      throw this._formatError(error, 'Failed to get deployment status');
    }
  }

  /**
   * Purge Netlify cache
   * @returns {Promise<Object>} Purge operation result
   */
  async purgeCache() {
    try {
      const response = await this.api.post(`/sites/${this.siteId}/purge`);
      const result = {
        success: true,
        purgedAt: new Date(),
        stats: response.data
      };

      logger.info('Cache purge successful', result);
      return result;
    } catch (error) {
      logger.error('Cache purge failed:', {
        error: error.message,
        status: error.response?.status
      });
      throw this._formatError(error, 'Failed to purge cache');
    }
  }

  /**
   * Get site-wide deployment history
   * @param {number} limit - Number of deployments to return
   * @returns {Promise<Array>} List of deployments
   */
  async getDeployHistory(limit = 10) {
    try {
      const response = await this.api.get(`/sites/${this.siteId}/deploys`, {
        params: { per_page: limit }
      });

      return response.data.map(deploy => ({
        id: deploy.id,
        state: deploy.state,
        branch: deploy.branch,
        url: deploy.ssl_url,
        createdAt: new Date(deploy.created_at),
        commitRef: deploy.commit_ref,
        commitUrl: deploy.links?.permalink,
        error: deploy.error_message
      }));
    } catch (error) {
      logger.error('Failed to get deployment history:', {
        error: error.message,
        status: error.response?.status
      });
      throw this._formatError(error, 'Failed to get deployment history');
    }
  }

  /**
   * Get latest deployment for a branch
   * @param {string} branch - Branch name (blue/green)
   * @returns {Promise<Object>} Deployment info
   */
  async getLatestDeploy(branch) {
    try {
      const response = await this.api.get(`/sites/${this.siteId}/deploys`, {
        params: { branch, per_page: 1 }
      });

      if (response.data.length === 0) {
        return { branch, state: 'none', found: false };
      }

      return {
        branch,
        state: response.data[0].state,
        id: response.data[0].id,
        url: response.data[0].ssl_url,
        updatedAt: new Date(response.data[0].updated_at),
        found: true
      };
    } catch (error) {
      logger.error('Failed to get latest deployment:', {
        branch,
        error: error.message
      });
      throw this._formatError(error, 'Failed to get latest deployment');
    }
  }

  // Private helper methods

  /**
   * Update cache with deployment data
   * @private
   */
  _updateCache(id, data) {
    this.cache.status.set(id, {
      data,
      timestamp: Date.now()
    });
    // Keep cache from growing indefinitely
    if (this.cache.status.size > 100) {
      const oldestKey = this.cache.status.keys().next().value;
      this.cache.status.delete(oldestKey);
    }
  }

  /**
   * Format API errors consistently
   * @private
   */
  _formatError(error, context) {
    const formattedError = new Error(`${context}: ${error.message}`);
    formattedError.statusCode = error.response?.status || 500;
    formattedError.details = error.response?.data || {};
    formattedError.isAxiosError = error.isAxiosError || false;
    return formattedError;
  }
}

// Singleton instance
module.exports = new NetlifyService();