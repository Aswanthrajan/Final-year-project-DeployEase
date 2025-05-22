// backend/server/services/redirectService.js
const gitService = require('./gitService');
const netlifyService = require('./netlifyService');
const logger = require('../utils/logger');
const REPOSITORY_URL = process.env.REPOSITORY_URL || 'https://github.com/Aswanthrajan/blue';

class RedirectService {
  constructor() {
    // Cache redirect rules to minimize GitHub API calls
    this.redirectCache = {
      rules: null,
      lastUpdated: null,
      activeBranch: null
    };

    // Branch deploy URLs based on your Netlify site
    this.branchUrls = {
      blue: 'https://blue--deployeaselive.netlify.app',
      green: 'https://green--deployeaselive.netlify.app'
    };

    // Retry configuration
    this.maxRetries = 3;
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

    let attempt = 0;
    let lastError = null;

    while (attempt < this.maxRetries) {
      try {
        attempt++;
        logger.info(`Attempting to update redirects (attempt ${attempt}/${this.maxRetries})`, {
          branch: activeBranch
        });

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
          commitUrl: commitResult.commitUrl,
          attempt: attempt
        });

        return {
          updated: true,
          branch: activeBranch,
          commitUrl: commitResult.commitUrl,
          rulesPreview: rules.split('\n').slice(0, 2).join('\n') + '\n...',
          attempt: attempt
        };

      } catch (error) {
        lastError = error;
        logger.warn(`Redirect update attempt ${attempt} failed`, {
          repository: REPOSITORY_URL,
          error: error.message,
          branch: activeBranch,
          attempt: attempt
        });

        // If this was the last attempt, break out of the loop
        if (attempt >= this.maxRetries) {
          break;
        }

        // Wait before retrying (exponential backoff)
        const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // All retries failed
    logger.error('Failed to update redirects after all attempts', {
      repository: REPOSITORY_URL,
      error: lastError.message,
      branch: activeBranch,
      totalAttempts: attempt
    });
    throw new Error(`Redirect update failed after ${this.maxRetries} attempts: ${lastError.message}`);
  }

  /**
   * Get currently active branch from redirects
   * @returns {Promise<string>} - Active branch (blue/green) or null if none active
   */
  async getActiveBranch() {
    let attempt = 0;
    let lastError = null;

    while (attempt < this.maxRetries) {
      try {
        attempt++;

        // Check cache first
        if (this.redirectCache.activeBranch && this.redirectCache.lastUpdated &&
            (new Date() - this.redirectCache.lastUpdated) < 60000) {
          return this.redirectCache.activeBranch;
        }

        const { owner, repo } = this.parseRepositoryUrl();
        const content = await gitService.getFileContent(
          owner,
          repo,
          '_redirects',
          'main'
        );

        // Look for the explicit active branch marker
        const markerMatch = content.match(/# ACTIVE_BRANCH: (blue|green|none)/i);
        if (markerMatch && markerMatch[1]) {
          const branch = markerMatch[1].toLowerCase();
          this.redirectCache.activeBranch = branch === 'none' ? null : branch;
          this.redirectCache.lastUpdated = new Date();
          return this.redirectCache.activeBranch;
        }

        // Fallback to checking redirect rules for branch URLs
        const blueMatch = content.includes(this.branchUrls.blue);
        const greenMatch = content.includes(this.branchUrls.green);
        
        let activeBranch = null;
        if (blueMatch && !greenMatch) {
          activeBranch = 'blue';
        } else if (greenMatch && !blueMatch) {
          activeBranch = 'green';
        }
        // If both or neither are found, return null (no environment active)

        // Update cache
        this.redirectCache.activeBranch = activeBranch;
        this.redirectCache.lastUpdated = new Date();

        return activeBranch;

      } catch (error) {
        lastError = error;
        logger.warn(`Get active branch attempt ${attempt} failed`, {
          repository: REPOSITORY_URL,
          error: error.message,
          attempt: attempt
        });

        // If this was the last attempt, break out of the loop
        if (attempt >= this.maxRetries) {
          break;
        }

        // Wait before retrying
        const delay = Math.pow(2, attempt - 1) * 500; // 0.5s, 1s, 2s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // All retries failed, return null (no environment active)
    logger.error('Failed to detect active branch after all attempts', {
      repository: REPOSITORY_URL,
      error: lastError?.message || 'Unknown error',
      totalAttempts: attempt
    });
    return null; // No environment active
  }

  /**
   * Generate redirect rules for a branch
   * @param {string} branch - Target branch (blue/green)
   * @returns {string} - Formatted redirect rules
   */
  generateRules(branch) {
    const targetUrl = this.branchUrls[branch];
    
    return `# DeployEase Blue-Green Traffic Routing
# Route all traffic to ${branch} branch deployment
/*  ${targetUrl}/:splat  302!

# Root path redirect
/  ${targetUrl}/  302

# API and static assets from branch deploys
/api/*  ${targetUrl}/api/:splat  302
/assets/*  ${targetUrl}/assets/:splat  302

# Configuration marker - DO NOT REMOVE
# ACTIVE_BRANCH: ${branch}`;
  }

  /**
   * Generate rules for no active environment (maintenance mode)
   * @returns {string} - Formatted redirect rules for maintenance
   */
  generateMaintenanceRules() {
    return `# DeployEase Blue-Green Traffic Routing
# No active environment - maintenance mode
/*  /maintenance.html  200

# API and static assets (no redirection)
/.netlify/*  /.netlify/:splat  200
/api/*  /api/:splat  200
/assets/*  /assets/:splat  200

# Explicitly prevent redirects for certain paths
/favicon.ico /favicon.ico 200
/robots.txt /robots.txt 200

# Configuration marker - DO NOT REMOVE
# ACTIVE_BRANCH: none`;
  }

  /**
   * Parse repository URL into owner and repo
   * @private
   * @returns {{owner: string, repo: string}}
   */
  parseRepositoryUrl() {
    const repoUrl = REPOSITORY_URL;
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match || !match[1] || !match[2]) {
      throw new Error(`Invalid repository URL: ${repoUrl}`);
    }
    return { 
      owner: match[1], 
      repo: match[2].replace(/\.git$/, '') 
    };
  }

  /**
   * Clear the redirect cache
   * @returns {void}
   */
  clearCache() {
    this.redirectCache = {
      rules: null,
      lastUpdated: null,
      activeBranch: null
    };
    logger.info('Redirect cache cleared');
  }

  /**
   * Get cache status
   * @returns {Object} - Cache information
   */
  getCacheStatus() {
    return {
      ...this.redirectCache,
      cacheAge: this.redirectCache.lastUpdated ? 
        new Date() - this.redirectCache.lastUpdated : null
    };
  }
}

// Singleton instance
module.exports = new RedirectService();