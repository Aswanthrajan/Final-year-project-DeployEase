// backend/server/config/netlify.js
const crypto = require('crypto');
const logger = require('../utils/logger');

// Constants tied to your repository
const REPOSITORY_URL = 'https://github.com/Aswanthrajan/blue';
const REPOSITORY_ID = crypto.createHash('sha256').update(REPOSITORY_URL).digest('hex').slice(0, 12);

module.exports = {
  // Core configuration
  site: {
    id: process.env.NETLIFY_SITE_ID || `deployease-${REPOSITORY_ID}`,
    name: 'DeployEase Blue-Green',
    url: process.env.NETLIFY_SITE_URL || `https://${REPOSITORY_ID}.netlify.app`,
    adminUrl: `https://app.netlify.com/sites/${process.env.NETLIFY_SITE_ID || REPOSITORY_ID}`
  },

  // GitHub integration
  repository: {
    url: REPOSITORY_URL,
    owner: REPOSITORY_URL.split('/')[3], // Extracts 'Aswanthrajan'
    name: REPOSITORY_URL.split('/')[4],  // Extracts 'blue'
    branches: {
      production: 'blue',
      staging: 'green',
      base: 'main'
    }
  },

  // Authentication
  auth: {
    token: process.env.NETLIFY_TOKEN,
    webhookSecret: process.env.NETLIFY_WEBHOOK_SECRET || crypto.randomBytes(16).toString('hex')
  },

  // Build hooks (automatically configured)
  hooks: {
    blue: process.env.NETLIFY_BLUE_HOOK || `${process.env.NETLIFY_API_URL}/build_hooks/${REPOSITORY_ID}-blue`,
    green: process.env.NETLIFY_GREEN_HOOK || `${process.env.NETLIFY_API_URL}/build_hooks/${REPOSITORY_ID}-green`
  },

  // Deployment settings
  deployment: {
    concurrency: 1, // Ensure sequential deployments
    timeout: 900,   // 15 minutes
    legacy: false   // Force new deployment API
  },

  // Cache settings
  cache: {
    ttl: 3600,      // 1 hour
    purgeOnDeploy: true
  },

  // Monitoring
  monitoring: {
    enabled: true,
    endpoint: `https://api.netlify.com/api/v1/sites/${process.env.NETLIFY_SITE_ID || REPOSITORY_ID}/monitoring`
  },

  // Utility methods
  getSiteId: () => this.site.id,
  getRepositoryInfo: () => this.repository,
  getHookUrl: (branch) => this.hooks[branch],

  // Validation
  validateConfig: () => {
    if (!process.env.NETLIFY_TOKEN) {
      logger.error('Netlify access token is required');
      throw new Error('Missing Netlify configuration');
    }
    return true;
  }
};