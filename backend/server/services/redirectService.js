// backend/server/services/redirectService.js
const gitService = require('./gitService');
const netlifyService = require('./netlifyService');
const logger = require('../utils/logger');
const REPOSITORY_URL = 'https://github.com/Aswanthrajan/blue';

class RedirectService {
  constructor() {
    // Cache redirect rules to minimize GitHub API calls
    this.redirectCache = {
      rules: null,
      lastUpdated: null,
      activeBranch: null
    };

    // Default redirect rules template
    this.defaultRules = `# DeployEase Traffic Routing
/*  /:branch/:splat  200
/   /:branch/index.html  200`;
  }

  /**
   * Update redirects to point to active branch
   * @param {string} activeBranch - Target branch (blue/green)
   * @returns {Promise<{updated: boolean, branch: string, commitUrl: string}>}
   */
  async updateRedirects(activeBranch) {
    if (!['blue', 'green'].includes(activeBranch)) {
      throw new Error(`Invalid branch: ${activeBranch}`);
    }

    try {
      // 1. Get current active branch
      const currentBranch = await this.getActiveBranch();

      // Skip if already pointing to the correct branch
      if (currentBranch === activeBranch) {
        return {
          updated: false,
          branch: activeBranch,
          message: 'Redirects already point to this branch'
        };
      }

      // 2. Generate new redirect rules
      const rules = this.generateRules(activeBranch);

      // 3. Commit to main branch
      const commitResult = await gitService.deployToBranch('main', [
        {
          path: '_redirects',
          content: rules
        }
      ], `DeployEase: Switch traffic to ${activeBranch} branch`);

      // 4. Purge Netlify cache
      await netlifyService.purgeCache();

      // Update cache
      this.redirectCache = {
        rules,
        lastUpdated: new Date(),
        activeBranch
      };

      logger.info(`Redirects updated to ${activeBranch} branch`, {
        repository: REPOSITORY_URL,
        commitUrl: commitResult.commitUrl
      });

      return {
        updated: true,
        branch: activeBranch,
        commitUrl: commitResult.commitUrl,
        rulesPreview: rules.split('\n').slice(0, 2).join('\n') + '\n...'
      };
    } catch (error) {
      logger.error('Failed to update redirects', {
        repository: REPOSITORY_URL,
        error: error.message,
        branch: activeBranch
      });
      throw new Error(`Redirect update failed: ${error.message}`);
    }
  }

  /**
   * Get currently active branch from redirects
   * @returns {Promise<string>} - Active branch (blue/green)
   */
  async getActiveBranch() {
    try {
      // Check cache first
      if (this.redirectCache.activeBranch) {
        return this.redirectCache.activeBranch;
      }

      const { owner, repo } = this.parseRepositoryUrl();
      const content = await gitService.getFileContent(
        owner,
        repo,
        '_redirects',
        'main'
      );

      const activeBranch = content.includes('/blue/') ? 'blue' : 
                         content.includes('/green/') ? 'green' : 'blue';

      // Update cache
      this.redirectCache.activeBranch = activeBranch;

      return activeBranch;
    } catch (error) {
      logger.error('Failed to detect active branch', {
        repository: REPOSITORY_URL,
        error: error.message
      });
      return 'blue'; // Fallback to blue
    }
  }

  /**
   * Generate redirect rules for a branch
   * @param {string} branch - Target branch (blue/green)
   * @returns {string} - Formatted redirect rules
   */
  generateRules(branch) {
    return this.defaultRules.replace(/:branch/g, branch) + `

# Additional rules can be added below
# /old-path /new-path 301
`;
  }

  /**
   * Parse repository URL into owner and repo
   * @private
   */
  parseRepositoryUrl() {
    const match = REPOSITORY_URL.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match || !match[1] || !match[2]) {
      throw new Error(`Invalid repository URL: ${REPOSITORY_URL}`);
    }
    return { 
      owner: match[1], 
      repo: match[2].replace(/\.git$/, '') 
    };
  }
}

// Singleton instance
module.exports = new RedirectService();