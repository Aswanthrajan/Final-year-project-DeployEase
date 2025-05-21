// backend/server/services/netlifyService.js
const axios = require('axios');
const logger = require('../utils/logger');

class NetlifyService {
  constructor() {
    // Validate required configuration
    if (!process.env.NETLIFY_TOKEN || !process.env.NETLIFY_SITE_ID) {
      logger.warn('Netlify configuration incomplete - deployments will be disabled');
      this.enabled = false;
      return;
    }

    this.enabled = true;
    this.api = axios.create({
      baseURL: 'https://api.netlify.com/api/v1',
      timeout: 10000,
      headers: {
        'Authorization': `Bearer ${process.env.NETLIFY_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    this.siteId = process.env.NETLIFY_SITE_ID;
    this.siteUrl = process.env.NETLIFY_SITE_URL || 'https://deployeaselive.netlify.app';
    this.buildHooks = {
      blue: process.env.NETLIFY_BLUE_HOOK,
      green: process.env.NETLIFY_GREEN_HOOK
    };
  }

  /**
   * Verify connection to Netlify API
   * @returns {Promise<{connected: boolean, siteName?: string, error?: string}>}
   */
  async verifyConnection() {
    if (!this.enabled) {
      return { connected: false, error: 'Netlify service not configured' };
    }

    try {
      const response = await this.api.get(`/sites/${this.siteId}`);
      return {
        connected: true,
        siteName: response.data.name,
        url: response.data.ssl_url || this.siteUrl,
        adminUrl: `https://app.netlify.com/sites/${response.data.name}`
      };
    } catch (error) {
      logger.error('Netlify connection verification failed:', error.response?.data?.message || error.message);
      return {
        connected: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Trigger deployment for a specific branch
   * @param {string} branch - Target branch (blue/green/main)
   * @returns {Promise<{success: boolean, deployId: string, deployUrl: string, branch: string}>}
   */
  async triggerDeploy(branch) {
    if (!this.enabled) {
      throw new Error('Netlify service not configured');
    }

    if (!['blue', 'green', 'main'].includes(branch)) {
      throw new Error(`Invalid branch specified: ${branch}`);
    }

    try {
      // Use build hook if available
      if (this.buildHooks[branch]) {
        const hookUrl = this.buildHooks[branch];
        logger.info(`Triggering build hook for ${branch} branch: ${hookUrl.substring(0, 20)}...`);
        
        const response = await axios.post(hookUrl);
        logger.info(`Build hook triggered successfully for ${branch} branch`);
        
        // Wait a moment for Netlify to register the build
        await new Promise(resolve => setTimeout(resolve, 2000));
        const latestDeploy = await this.getLatestDeploy(branch);
        
        return {
          success: true,
          deployId: latestDeploy.id || `hook-${Date.now()}`,
          deployUrl: latestDeploy.url || this.siteUrl,
          branch
        };
      }

      // Fallback to direct API deployment
      logger.info(`No build hook configured for ${branch} branch, using API deployment`);
      const response = await this.api.post(`/sites/${this.siteId}/deploys`, {
        branch,
        clear_cache: true
      });

      logger.info(`Netlify build started for ${branch}`, {
        branch,
        buildId: response.data.id,
        deployUrl: response.data.deploy_ssl_url || response.data.ssl_url || this.siteUrl
      });

      return {
        success: true,
        deployId: response.data.id,
        deployUrl: response.data.deploy_ssl_url || response.data.ssl_url || this.siteUrl,
        branch
      };
    } catch (error) {
      if (error.response) {
        logger.error(`Failed to trigger deployment for branch ${branch}:`, {
          status: error.response.status,
          data: error.response.data
        });
      } else {
        logger.error(`Failed to trigger deployment for branch ${branch}:`, error.message);
      }
      
      throw new Error(`Deployment failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Get latest deployment status for a branch
   * @param {string} branch - Branch name
   * @returns {Promise<{id?: string, url?: string, state: string, branch: string, created_at?: string}>}
   */
  async getLatestDeploy(branch) {
    if (!this.enabled) {
      return { branch, state: 'disabled' };
    }

    try {
      const response = await this.api.get(`/sites/${this.siteId}/deploys`, {
        params: {
          branch,
          per_page: 1,
          sort_by: 'created_at',
          direction: 'desc'
        }
      });

      if (!response.data || response.data.length === 0) {
        return { branch, state: 'not_found' };
      }

      const deploy = response.data[0];
      return {
        id: deploy.id,
        url: deploy.ssl_url || deploy.url || this.siteUrl,
        state: deploy.state,
        branch: deploy.branch,
        created_at: deploy.created_at
      };
    } catch (error) {
      logger.error(`Failed to get deployment status for branch ${branch}:`, error.response?.data?.message || error.message);
      return { branch, state: 'error', error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Purge Netlify cache
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async purgeCache() {
    if (!this.enabled) {
      return { success: false, error: 'Netlify service not configured' };
    }

    try {
      await this.api.post(`/sites/${this.siteId}/cache`);
      logger.info('Netlify cache purged');
      return { success: true };
    } catch (error) {
      logger.error('Cache purge failed:', error.response?.data?.message || error.message);
      // Don't throw an error for cache purge failures - just log it
      return { 
        success: false, 
        error: error.response?.data?.message || error.message 
      };
    }
  }

  /**
   * Get branch deployment health status
   * @param {string} branch - Branch to check
   * @returns {Promise<string>} - Health status (online, offline, degraded)
   */
  async getBranchHealth(branch) {
    if (!this.enabled) {
      return 'disabled';
    }

    try {
      const deploy = await this.getLatestDeploy(branch);
      
      // Map Netlify deploy state to health status
      switch (deploy.state) {
        case 'ready':
          return 'online';
        case 'error':
          return 'offline';
        case 'building':
          return 'deploying';
        default:
          return deploy.state || 'unknown';
      }
    } catch (error) {
      logger.error(`Failed to get ${branch} health status`, {
        error: error.message,
        branch
      });
      return 'unknown';
    }
  }
}

// Export singleton instance
module.exports = new NetlifyService();