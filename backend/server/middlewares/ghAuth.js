// backend/server/middlewares/ghAuth.js
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const logger = require('../utils/logger');

// Configuration constants
const REPOSITORY_URL = 'https://github.com/Aswanthrajan/blue';

class GitHubAuth {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN, // Using PAT directly
      userAgent: 'DeployEase v2.0',
      baseUrl: 'https://api.github.com',
      log: logger,
      request: {
        timeout: 10000
      }
    });
  }

  /**
   * Get authenticated Octokit instance
   * @returns {Promise<Octokit>}
   */
  async getAuthenticatedClient() {
    return this.octokit;
  }

  /**
   * Verify repository access permissions
   * @returns {Promise<{hasWriteAccess: boolean}>}
   */
  async verifyRepositoryAccess() {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      
      // For PAT, we'll check if we can access the repo
      await this.octokit.repos.get({
        owner,
        repo
      });

      return {
        hasWriteAccess: true, // PAT with repo access is assumed to have write
        permissions: { permission: 'write' }
      };
    } catch (error) {
      this.handleError('Repository access verification failed', error);
    }
  }

  /**
   * Create a repository dispatch event
   * @param {string} eventType - Custom event type
   * @param {object} payload - Event payload
   * @returns {Promise<{status: string}>}
   */
  async createRepositoryEvent(eventType, payload = {}) {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      await this.octokit.repos.createDispatchEvent({
        owner,
        repo,
        event_type: eventType,
        client_payload: payload
      });

      return { status: 'success' };
    } catch (error) {
      this.handleError('Repository event creation failed', error);
    }
  }

  // ==================== PRIVATE METHODS ====================

  /** Parse repository URL into owner and repo */
  parseRepositoryUrl() {
    const match = REPOSITORY_URL.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match || !match[1] || !match[2]) {
      throw new Error(`Invalid repository URL: ${REPOSITORY_URL}`);
    }
    return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
  }

  /** Standardized error handling */
  handleError(context, error) {
    const errorId = crypto.randomBytes(8).toString('hex');
    logger.error(`${context} [${errorId}]: ${error.message}`, {
      repository: REPOSITORY_URL,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    const customError = new Error(`${context}. Error ID: ${errorId}`);
    customError.statusCode = error.status || 500;
    throw customError;
  }
}

// Singleton instance
module.exports = new GitHubAuth();