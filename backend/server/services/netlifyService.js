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
        url: response.data.ssl_url,
        adminUrl: `https://app.netlify.com/sites/${response.data.name}`
      };
    } catch (error) {
      logger.error('Netlify connection verification failed:', error.message);
      return {
        connected: false,
        error: error.message
      };
    }
  }

  /**
   * Trigger deployment for a specific branch
   * @param {string} branch - Target branch (blue/green)
   * @returns {Promise<{id: string, url: string, state: string}>}
   */
  async triggerDeploy(branch) {
    if (!this.enabled) {
      throw new Error('Netlify service not configured');
    }

    if (!['blue', 'green'].includes(branch)) {
      throw new Error(`Invalid branch specified: ${branch}`);
    }

    try {
      // Use build hook if available
      if (this.buildHooks[branch]) {
        await axios.post(this.buildHooks[branch], {});
        return this.getLatestDeploy(branch);
      }

      // Fallback to API deployment
      const response = await this.api.post(`/sites/${this.siteId}/builds`, {
        branch,
        clear_cache: true
      });

      return {
        id: response.data.id,
        url: response.data.deploy_ssl_url,
        state: response.data.state,
        branch: response.data.branch
      };
    } catch (error) {
      logger.error(`Failed to trigger deployment for branch ${branch}:`, error.message);
      throw new Error(`Deployment failed: ${error.message}`);
    }
  }

  /**
   * Get latest deployment status for a branch
   * @param {string} branch - Branch name
   * @returns {Promise<{id?: string, url?: string, state: string, branch: string}>}
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
          sort: 'created_at',
          order: 'desc'
        }
      });

      if (!response.data.length) {
        return { branch, state: 'not_found' };
      }

      return {
        id: response.data[0].id,
        url: response.data[0].ssl_url,
        state: response.data[0].state,
        branch: response.data[0].branch
      };
    } catch (error) {
      logger.error(`Failed to get deployment status for branch ${branch}:`, error.message);
      return { branch, state: 'error', error: error.message };
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
      await this.api.post(`/sites/${this.siteId}/purge`);
      return { success: true };
    } catch (error) {
      logger.error('Cache purge failed:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// Export singleton instance
module.exports = new NetlifyService();