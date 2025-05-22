const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const logger = require('../utils/logger');
const path = require('path');

// Configuration constants
const REPOSITORY_URL = process.env.REPOSITORY_URL || 'https://github.com/Aswanthrajan/blue';
const NETLIFY_SITE_NAME = process.env.NETLIFY_SITE_NAME || 'deployeaselive';
const DEFAULT_BRANCHES = {
  MAIN: 'main',
  BLUE: 'blue',
  GREEN: 'green'
};
const REDIRECTS_FILE = '_redirects';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const VALID_FILE_EXTENSIONS = ['.html', '.css', '.js', '.json', '.txt', '.md'];
const CACHE_TTL = 300000; // 5 minutes
const CACHE_TTL_EXTENDED = 1800000; // 30 minutes for rate limited scenarios
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_BASE = 2000; // Base delay in ms before exponential backoff
const NETLIFY_SPECIAL_FILES = ['_redirects', '_headers', 'netlify.toml'];

class GitService {
  constructor() {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GitHub token is required');
    }

    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
      userAgent: 'DeployEase v2.0',
      baseUrl: 'https://api.github.com',
      log: logger,
      request: {
        timeout: 15000 // 15 seconds
      }
    });

    this.cache = new Map();
    this.historyCache = new Map();
    this.rateLimit = {
      remaining: 5000, 
      reset: 0,
      lastChecked: 0
    };
    
    // Initialize rate limit
    this.updateRateLimit().catch(err => {
      logger.warn(`Failed to initialize rate limit check: ${err.message}`);
    });
    
    // Set up cache cleanup interval
    setInterval(() => this.cleanupCache(), 600000); // Clean every 10 minutes
  }

  /**
   * Execute GitHub API call with retry logic for rate limits
   * @param {Function} apiCall - Function that returns a promise for API call
   * @param {string} operationName - Name of operation for logging
   * @param {Object} options - Options for retry behavior
   * @returns {Promise<any>} - Result of the API call
   */
  async executeWithRetry(apiCall, operationName, options = {}) {
    const {
      maxRetries = MAX_RETRY_ATTEMPTS,
      retryDelay = RETRY_DELAY_BASE,
      checkRateLimit = true,
      cacheKey = null,
      cacheResult = false,
      cacheTTL = CACHE_TTL,
      fallbackValue = undefined
    } = options;
    
    // Check cache if provided
    if (cacheKey && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (cached.expires > Date.now()) {
        logger.debug(`Cache hit for ${operationName} [${cacheKey}]`);
        return cached.data;
      }
    }
    
    // Check rate limits if needed
    if (checkRateLimit) {
      try {
        await this.checkRateLimit(true);
      } catch (error) {
        // If rate limited and we have cached data, return it even if expired
        if (cacheKey && this.cache.has(cacheKey)) {
          logger.warn(`Rate limited - using expired cache for ${operationName}`);
          return this.cache.get(cacheKey).data;
        }
        // If we have a fallback value, return it
        if (fallbackValue !== undefined) {
          return fallbackValue;
        }
        throw error;
      }
    }
    
    let attempts = 0;
    let lastError;
    
    while (attempts < maxRetries) {
      try {
        const result = await apiCall();
        
        // Cache result if requested
        if (cacheKey && cacheResult && result) {
          this.cache.set(cacheKey, {
            data: result,
            expires: Date.now() + cacheTTL
          });
        }
        
        // Update rate limit info after successful call
        if (checkRateLimit) {
          this.updateRateLimit().catch(err => {
            logger.debug(`Rate limit update after ${operationName} failed: ${err.message}`);
          });
        }
        
        return result;
      } catch (error) {
        lastError = error;
        
        // Handle rate limit errors specifically
        if (error.status === 403 && error.message.includes('rate limit')) {
          const resetTime = error.response?.headers?.['x-ratelimit-reset'];
          if (resetTime) {
            const waitTime = Math.ceil((resetTime * 1000 - Date.now()) / 1000);
            logger.warn(`Rate limit hit during ${operationName}. Reset in ${waitTime}s`);
            
            // Update our internal rate limit tracking
            this.rateLimit = {
              remaining: 0,
              reset: resetTime,
              lastChecked: Date.now()
            };
            
            // If this is the last retry attempt, throw a more specific error
            if (attempts === maxRetries - 1) {
              throw new Error(`GitHub rate limit exceeded. Try again in ${waitTime} seconds`);
            }
          }
        } else if (error.status >= 500) {
          // Server errors might be temporary, worth retrying
          logger.warn(`Server error during ${operationName}: ${error.message}. Retrying...`);
        } else if (error.status !== 429) {
          // Don't retry client errors except 429 (too many requests)
          throw error;
        }
        
        attempts++;
        
        // Exponential backoff with jitter
        if (attempts < maxRetries) {
          const delay = retryDelay * Math.pow(2, attempts) * (0.8 + Math.random() * 0.4);
          logger.debug(`Retrying ${operationName} in ${Math.round(delay)}ms (attempt ${attempts})`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // If we got here, all retries failed
    if (fallbackValue !== undefined) {
      return fallbackValue;
    }
    throw lastError;
  }

  /**
   * Initialize repository with blue-green branches
   * @returns {Promise<{status: string, branches: object}>}
   */
  async initializeRepository() {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      
      // Verify repository exists and we have access
      await this.executeWithRetry(
        async () => this.verifyRepositoryAccess(owner, repo),
        'repository access check'
      );

      const branches = await this.executeWithRetry(
        async () => this.listBranches(owner, repo),
        'listing branches',
        { cacheKey: `branches-${owner}-${repo}`, cacheResult: true }
      );

      const results = {
        [DEFAULT_BRANCHES.MAIN]: await this.ensureBranch(owner, repo, DEFAULT_BRANCHES.MAIN, branches),
        [DEFAULT_BRANCHES.BLUE]: await this.ensureBranch(owner, repo, DEFAULT_BRANCHES.BLUE, branches),
        [DEFAULT_BRANCHES.GREEN]: await this.ensureBranch(owner, repo, DEFAULT_BRANCHES.GREEN, branches)
      };

      // Initialize redirects file if not exists
      const redirectsExists = await this.executeWithRetry(
        async () => this.fileExists(owner, repo, REDIRECTS_FILE, DEFAULT_BRANCHES.MAIN),
        'checking redirects file',
        { cacheKey: `redirects-exists-${owner}-${repo}`, cacheResult: true }
      );
      
      if (!redirectsExists) {
        await this.updateRedirectsFile(DEFAULT_BRANCHES.BLUE);
      }

      return {
        status: 'success',
        branches: results,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.handleError('Repository initialization failed', error);
    }
  }

  /**
   * Deploy files to specified branch
   * @param {string} branch - Target branch (blue/green)
   * @param {Array<{path: string, content: string}>} files - Files to deploy
   * @param {string} commitMessage - Custom commit message
   * @returns {Promise<{commitUrl: string, branch: string, deployId: string, timestamp: string}>}
   */
  async deployToBranch(branch, files, commitMessage = 'DeployEase automated deployment') {
    if (!branch) {
      throw new Error('Branch is required for deployment');
    }
    
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new Error('Files are required for deployment');
    }

    if (![DEFAULT_BRANCHES.BLUE, DEFAULT_BRANCHES.GREEN, DEFAULT_BRANCHES.MAIN].includes(branch)) {
      throw new Error(`Invalid deployment branch: ${branch}. Must be 'blue', 'green', or 'main'`);
    }

    try {
      const { owner, repo } = this.parseRepositoryUrl();
      
      // Validate files before deployment
      this.validateFiles(files);

      const commitHash = crypto.createHash('sha256')
        .update(JSON.stringify(files) + Date.now())
        .digest('hex');

      // Check cache to avoid duplicate deployments
      const cacheKey = `${branch}-${commitHash}`;
      if (this.cache.has(cacheKey)) {
        return this.cache.get(cacheKey).data;
      }

      // Create commit with all files
      const commitResult = await this.executeWithRetry(
        async () => this.createCommit(
          owner,
          repo,
          branch,
          files,
          `${commitMessage} [${commitHash.slice(0, 7)}]`
        ),
        'creating commit',
        { maxRetries: MAX_RETRY_ATTEMPTS + 1 } // More retries for critical operations
      );

      // Generate deploy ID for tracking
      const deployId = `deploy-${branch}-${Date.now()}-${commitHash.slice(0, 4)}`;
      const commitUrl = `https://github.com/${owner}/${repo}/commit/${commitResult.sha}`;

      const result = {
        commitUrl,
        branch,
        deployId,
        timestamp: new Date().toISOString()
      };

      // Cache result
      this.cache.set(cacheKey, {
        data: result,
        expires: Date.now() + CACHE_TTL
      });

      logger.info(`Deployment successful to ${branch} branch`, {
        repository: REPOSITORY_URL,
        commitUrl,
        deployId,
        fileCount: files.length
      });

      return result;
    } catch (error) {
      this.handleError('Deployment failed', error);
    }
  }

  /**
   * Verify repository access
   * @private
   */
  async verifyRepositoryAccess(owner, repo) {
    try {
      await this.octokit.repos.get({
        owner,
        repo
      });
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`Repository not found: ${owner}/${repo}`);
      }
      throw error;
    }
  }

  /**
   * Check and handle GitHub rate limits
   * @param {boolean} useCached - Whether to use cached rate limit values
   * @private
   */
  async checkRateLimit(useCached = false) {
    const now = Date.now();
    
    // If we have a cached rate limit value and it's requested, use it if not too old
    if (useCached && this.rateLimit.remaining !== undefined && now - this.rateLimit.lastChecked < 60000) {
      if (this.rateLimit.remaining < 10) {
        const resetTime = this.rateLimit.reset * 1000;
        
        if (now < resetTime) {
          const waitTime = Math.ceil((resetTime - now) / 1000);
          throw new Error(`GitHub rate limit exceeded. Try again in ${waitTime} seconds`);
        }
      }
      return;
    }

    try {
      await this.updateRateLimit();
    } catch (error) {
      // If this is a rate limit error itself, handle it gracefully
      if (error.status === 403 && error.message.includes('rate limit')) {
        // Get reset time from headers if available
        const resetTime = error.response?.headers?.['x-ratelimit-reset'];
        if (resetTime) {
          const waitTime = Math.ceil((resetTime * 1000 - now) / 1000);
          throw new Error(`GitHub rate limit exceeded. Try again in ${waitTime} seconds`);
        } else {
          // Default fallback of 1 hour
          throw new Error(`GitHub rate limit exceeded. Try again in 3600 seconds`);
        }
      }
      
      // For other errors, throw a general message
      throw new Error(`GitHub rate limit checking failed: ${error.message}`);
    }
    
    if (this.rateLimit.remaining < 10) {
      const waitTime = Math.ceil((this.rateLimit.reset * 1000 - now) / 1000);
      throw new Error(`GitHub rate limit exceeded. Try again in ${waitTime} seconds`);
    }
  }
  
  /**
   * Update rate limit data from GitHub API
   */
  async updateRateLimit() {
    try {
      const { data } = await this.octokit.rateLimit.get();
      this.rateLimit = {
        remaining: data.resources.core.remaining,
        reset: data.resources.core.reset,
        lastChecked: Date.now()
      };
      logger.debug(`GitHub API rate limit: ${this.rateLimit.remaining} remaining, resets in ${Math.round((this.rateLimit.reset * 1000 - Date.now()) / 1000)}s`);
    } catch (error) {
      // Handle rate limit errors during rate limit check
      if (error.status === 403 && error.message.includes('rate limit')) {
        const resetTime = error.response?.headers?.['x-ratelimit-reset'];
        if (resetTime) {
          this.rateLimit.remaining = 0;
          this.rateLimit.reset = resetTime;
          this.rateLimit.lastChecked = Date.now();
        }
      }
      logger.error(`Failed to update rate limit: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Clean up expired cache entries with smarter logic
   * In case of rate limiting, extend cache expiration times
   */
  cleanupCache() {
    const now = Date.now();
    const isRateLimited = this.rateLimit.remaining < 10 && now < this.rateLimit.reset * 1000;
    
    // If we're rate limited, extend cache lifetimes instead of purging
    if (isRateLimited) {
      logger.info(`Rate limited - extending cache lifetimes`);
      
      // Extend main cache entries that would expire soon
      for (const [key, value] of this.cache.entries()) {
        if (value.expires && value.expires < now + CACHE_TTL_EXTENDED) {
          this.cache.set(key, {
            data: value.data,
            expires: now + CACHE_TTL_EXTENDED
          });
        }
      }
      
      // Extend history cache entries that would expire soon
      for (const [key, value] of this.historyCache.entries()) {
        if (value.expires && value.expires < now + CACHE_TTL_EXTENDED) {
          this.historyCache.set(key, {
            data: value.data,
            expires: now + CACHE_TTL_EXTENDED
          });
        }
      }
    } else {
      // Standard cache cleanup when not rate limited
      for (const [key, value] of this.cache.entries()) {
        if (value.expires && value.expires < now) {
          this.cache.delete(key);
        }
      }
      
      for (const [key, value] of this.historyCache.entries()) {
        if (value.expires && value.expires < now) {
          this.historyCache.delete(key);
        }
      }
    }
    
    logger.debug(`Cache cleanup complete. Main cache: ${this.cache.size} entries, History cache: ${this.historyCache.size} entries`);
  }

  /**
   * Validate files before deployment
   * @param {Array} files - Files to validate
   * @throws {Error} If validation fails
   */
  validateFiles(files) {
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new Error('No files provided for deployment');
    }

    if (files.length > 100) {
      throw new Error('Cannot deploy more than 100 files at once');
    }

    const seenPaths = new Set();
    files.forEach(file => {
      if (!file.path || typeof file.content === 'undefined') {
        throw new Error('Each file must have path and content properties');
      }

      if (seenPaths.has(file.path)) {
        throw new Error(`Duplicate file path: ${file.path}`);
      }
      seenPaths.add(file.path);

      // Special case for Netlify special files
      if (NETLIFY_SPECIAL_FILES.includes(file.path)) {
        return; // Skip extension validation for Netlify special files
      }

      const ext = path.extname(file.path).toLowerCase();
      if (!VALID_FILE_EXTENSIONS.includes(ext)) {
        throw new Error(`Invalid file extension for ${file.path}. Allowed: ${VALID_FILE_EXTENSIONS.join(', ')}`);
      }

      if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_SIZE) {
        throw new Error(`File ${file.path} exceeds maximum size of 5MB`);
      }
    });
  }

  /**
   * Switch active environment by updating redirects
   * @param {string} targetBranch - Branch to switch to (blue/green)
   * @returns {Promise<{redirectsUrl: string, activeBranch: string, commitUrl: string, timestamp: string}>}
   */
  async switchEnvironment(targetBranch) {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      
      if (![DEFAULT_BRANCHES.BLUE, DEFAULT_BRANCHES.GREEN].includes(targetBranch)) {
        throw new Error(`Invalid target branch: ${targetBranch}. Must be 'blue' or 'green'`);
      }

      // Get current branch with better caching
      let currentBranch = await this.executeWithRetry(
        async () => this.getActiveBranch(), 
        'getting active branch',
        { 
          cacheKey: 'active-branch',
          cacheResult: true,
          cacheTTL: 600000 // 10 min cache
        }
      );
      
      if (currentBranch === targetBranch) {
        return {
          redirectsUrl: `https://github.com/${owner}/${repo}/blob/${DEFAULT_BRANCHES.MAIN}/${REDIRECTS_FILE}`,
          activeBranch: targetBranch,
          status: 'no_change',
          timestamp: new Date().toISOString()
        };
      }

      const result = await this.updateRedirectsFile(targetBranch);
      
      // Clear cache for active branch since we just changed it
      this.cache.delete('active-branch');
      
      logger.info(`Environment switched to ${targetBranch}`, {
        repository: REPOSITORY_URL,
        commitUrl: result.commitUrl
      });

      return {
        redirectsUrl: `https://github.com/${owner}/${repo}/blob/${DEFAULT_BRANCHES.MAIN}/${REDIRECTS_FILE}`,
        activeBranch: targetBranch,
        commitUrl: result.commitUrl,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.handleError('Environment switch failed', error);
    }
  }

  /**
   * Get deployment history for a branch with improved caching and rate limit handling
   * @param {string} branch - Target branch
   * @param {number} limit - Number of commits to return
   * @returns {Promise<Array<{id: string, message: string, timestamp: string, author: string, url: string, branch: string, status: string}>>}
   */
  async getDeploymentHistory(branch, limit = 10) {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      const cacheKey = `history-${branch}-${limit}`;
      
      return await this.executeWithRetry(
        async () => {
          const { data: commits } = await this.octokit.repos.listCommits({
            owner,
            repo,
            sha: branch,
            per_page: Math.min(limit, 30) // Limit to 30 commits
          });
          
          return commits.map(commit => ({
            id: commit.sha,
            message: commit.commit.message,
            timestamp: commit.commit.committer.date,
            author: commit.commit.author.name,
            url: commit.html_url,
            branch: branch,
            status: 'success'
          }));
        },
        `getting deployment history for ${branch}`,
        {
          cacheKey,
          cacheResult: true,
          cacheTTL: 300000, // 5 minutes
          fallbackValue: [] // Return empty array on error
        }
      );
    } catch (error) {
      logger.warn(`Failed to get deployment history for ${branch}: ${error.message}`);
      return []; // Return empty array instead of throwing
    }
  }

  /**
   * Get all deployment history for both branches with better error handling
   * @param {number} limit - Number of commits per branch
   * @returns {Promise<{blue: Array, green: Array}>}
   */
  async getAllDeploymentHistory(limit = 10) {
    try {
      // Get history for both branches, handling failures individually
      const [blue, green] = await Promise.allSettled([
        this.getDeploymentHistory(DEFAULT_BRANCHES.BLUE, limit),
        this.getDeploymentHistory(DEFAULT_BRANCHES.GREEN, limit)
      ]);
      
      return {
        blue: blue.status === 'fulfilled' ? blue.value : [],
        green: green.status === 'fulfilled' ? green.value : [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error(`Failed to get all deployment history: ${error.message}`);
      return { 
        blue: [], 
        green: [], 
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get currently active branch from redirects file with better caching and parsing
   * @returns {Promise<string>} - Active branch name (blue/green)
   */
  async getActiveBranch() {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      const cacheKey = 'active-branch';
      
      // Try from cache with extended retry
      return await this.executeWithRetry(
        async () => {
          const content = await this.getFileContent(
            owner,
            repo,
            REDIRECTS_FILE,
            DEFAULT_BRANCHES.MAIN
          );

          // First try to parse from the configuration marker
          const markerMatch = content.match(/# ACTIVE_BRANCH:\s*(blue|green)/i);
          if (markerMatch) {
            return markerMatch[1].toLowerCase();
          }

          // Fallback to parsing redirect URLs for branch deploys and Netlify URLs
          if (content.includes(`https://blue--${NETLIFY_SITE_NAME}.netlify.app`) || 
              content.includes(`/${DEFAULT_BRANCHES.BLUE}/`) || 
              content.includes('/blue/')) {
            return DEFAULT_BRANCHES.BLUE;
          } else if (content.includes(`https://green--${NETLIFY_SITE_NAME}.netlify.app`) || 
                     content.includes(`/${DEFAULT_BRANCHES.GREEN}/`) || 
                     content.includes('/green/')) {
            return DEFAULT_BRANCHES.GREEN;
          } else {
            return DEFAULT_BRANCHES.BLUE; // Default fallback
          }
        },
        'getting active branch',
        {
          cacheKey,
          cacheResult: true,
          cacheTTL: 600000, // 10 minutes
          fallbackValue: DEFAULT_BRANCHES.BLUE // Default to blue on error
        }
      );
    } catch (error) {
      logger.error(`Failed to detect active branch: ${error.message}`);
      return DEFAULT_BRANCHES.BLUE; // Default fallback
    }
  }
  
  /**
   * Roll back to a specific commit
   * @param {string} branch - Branch to roll back
   * @param {string} commitSha - Commit SHA to roll back to
   * @returns {Promise<{commitUrl: string}>} Result of rollback
   */
  async rollbackToCommit(branch, commitSha) {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      
      if (![DEFAULT_BRANCHES.BLUE, DEFAULT_BRANCHES.GREEN].includes(branch)) {
        throw new Error(`Invalid branch for rollback: ${branch}. Must be 'blue' or 'green'`);
      }
      
      // Verify commit exists and is valid
      await this.executeWithRetry(
        async () => {
          await this.octokit.git.getCommit({
            owner,
            repo,
            commit_sha: commitSha
          });
        },
        `verifying commit ${commitSha.slice(0, 7)}`,
        { maxRetries: 2 }
      );
      
      // Force update branch reference to point to commit
      await this.executeWithRetry(
        async () => {
          await this.octokit.git.updateRef({
            owner,
            repo,
            ref: `heads/${branch}`,
            sha: commitSha,
            force: true
          });
        },
        `rolling back to commit ${commitSha.slice(0, 7)}`,
        { maxRetries: 3 }
      );
      
      return {
        commitUrl: `https://github.com/${owner}/${repo}/commit/${commitSha}`,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.handleError(`Rollback to commit ${commitSha.slice(0, 7)} failed`, error);
    }
  }

  // ==================== PRIVATE METHODS ====================

  /** Parse repository URL into owner and repo */
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

  /** Check if file exists in repository */
  async fileExists(owner, repo, filePath, branch) {
    try {
      await this.octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branch
      });
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  /** Get content of a file from repository */
  async getFileContent(owner, repo, filePath, branch) {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branch
      });
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
      if (error.status === 404) {
        throw Object.assign(new Error(`File not found: ${filePath}`), { status: 404 });
      }
      throw error;
    }
  }

  /** List all branches in repository */
  async listBranches(owner, repo) {
    try {
      const { data } = await this.octokit.repos.listBranches({
        owner,
        repo,
        per_page: 100
      });
      return data.map(b => b.name);
    } catch (error) {
      this.handleError('Failed to list branches', error);
    }
  }

  /** Ensure branch exists or create from main */
  async ensureBranch(owner, repo, branch, existingBranches = []) {
    if (existingBranches.includes(branch)) {
      return 'exists';
    }

    try {
      // Check if main branch exists
      if (branch !== DEFAULT_BRANCHES.MAIN) {
        try {
          const mainSha = await this.executeWithRetry(
            async () => this.getBranchSha(owner, repo, DEFAULT_BRANCHES.MAIN),
            `getting main branch SHA`
          );
          
          await this.executeWithRetry(
            async () => {
              await this.octokit.git.createRef({
                owner,
                repo,
                ref: `refs/heads/${branch}`,
                sha: mainSha
              });
            },
            `creating branch ${branch}`
          );
          
          return 'created';
        } catch (error) {
          logger.error(`Failed to create branch ${branch} from main: ${error.message}`);
          throw error;
        }
      } else {
        // If no branches exist yet, we can't do anything
        throw new Error('Main branch does not exist and must be created manually in the repository');
      }
    } catch (error) {
      this.handleError(`Failed to ensure branch ${branch}`, error);
    }
  }

  /** Get SHA of the latest commit in a branch */
  async getBranchSha(owner, repo, branch) {
    try {
      const { data } = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`
      });
      return data.object.sha;
    } catch (error) {
      if (error.status === 404) {
        throw Object.assign(new Error(`Branch not found: ${branch}`), { status: 404 });
      }
      throw error;
    }
  }

  /** Get tree SHA for a commit */
  async getCommitTree(owner, repo, commitSha) {
    try {
      const { data } = await this.octokit.git.getCommit({
        owner,
        repo,
        commit_sha: commitSha
      });
      return data.tree.sha;
    } catch (error) {
      this.handleError(`Failed to get commit tree for ${commitSha}`, error);
    }
  }

  /** Create a new commit with files */
  async createCommit(owner, repo, branch, files, message) {
    try {
      // Ensure branch exists
      const branches = await this.executeWithRetry(
        async () => this.listBranches(owner, repo),
        'listing branches',
        { cacheKey: `branches-${owner}-${repo}`, cacheResult: true }
      );
      
      if (!branches.includes(branch)) {
        if (branch === DEFAULT_BRANCHES.MAIN) {
          throw new Error('Main branch does not exist in the repository');
        }
        await this.ensureBranch(owner, repo, branch, branches);
      }

      const branchSha = await this.executeWithRetry(
        async () => this.getBranchSha(owner, repo, branch),
        `getting branch SHA for ${branch}`
      );
      
      const baseTree = await this.executeWithRetry(
        async () => this.getCommitTree(owner, repo, branchSha),
        `getting commit tree for ${branchSha.slice(0, 7)}`
      );

      // Create blobs for all files
      const blobs = await Promise.all(
        files.map(async file => {
          // Determine the file type based on extension
          const isTextFile = VALID_FILE_EXTENSIONS.includes(path.extname(file.path).toLowerCase());
          
          // Only use base64 encoding for binary files - text files should use utf-8
          const content = file.content;
          const encoding = isTextFile ? 'utf-8' : 'base64';
          
          return this.executeWithRetry(
            async () => this.octokit.git.createBlob({
              owner,
              repo,
              content: content,
              encoding: encoding
            }),
            `creating blob for ${file.path}`
          );
        })
      );

      // Create new tree
      const newTree = await this.executeWithRetry(
        async () => this.octokit.git.createTree({
          owner,
          repo,
          tree: files.map((file, i) => ({
            path: file.path,
            mode: '100644',
            type: 'blob',
            sha: blobs[i].data.sha
          })),
          base_tree: baseTree
        }),
        'creating tree'
      );

      // Create commit
      const newCommit = await this.executeWithRetry(
        async () => this.octokit.git.createCommit({
          owner,
          repo,
          message,
          tree: newTree.data.sha,
          parents: [branchSha]
        }),
        'creating commit'
      );

      // Update branch reference
      await this.executeWithRetry(
        async () => this.octokit.git.updateRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          sha: newCommit.data.sha,
          force: false
        }),
        'updating branch reference'
      );

      return newCommit.data;
    } catch (error) {
      this.handleError(`Failed to create commit on branch ${branch}`, error);
    }
  }

  /** Update redirects file to point to target branch */
  async updateRedirectsFile(targetBranch) {
    const { owner, repo } = this.parseRepositoryUrl();
    const content = this.generateRedirectsContent(targetBranch);
    
    return this.deployToBranch(
      DEFAULT_BRANCHES.MAIN,
      [{
        path: REDIRECTS_FILE,
        content: content
      }],
      `DeployEase: Switch traffic to ${targetBranch} branch`
    );
  }

  /** Generate proper redirects content matching your project format */
  generateRedirectsContent(activeBranch) {
    return `# DeployEase Blue-Green Traffic Routing
/*  /${activeBranch}/:splat  200!
/   /${activeBranch}/index.html  200!

# API and static assets (no redirection)
/.netlify/*  /.netlify/:splat  200
/api/*  /api/:splat  200
/assets/*  /assets/:splat  200

# Explicitly prevent redirects for certain paths
/favicon.ico /favicon.ico 200
/robots.txt /robots.txt 200

# Configuration marker - DO NOT REMOVE
# ACTIVE_BRANCH: ${activeBranch}
`;
  }

  /** Standardized error handling */
  handleError(context, error) {
    const errorId = crypto.randomBytes(4).toString('hex');
    let errorMessage = error.response?.data?.message || error.message;
    
    // Special handling for rate limit errors
    if (error.status === 403 && errorMessage.includes('API rate limit exceeded')) {
      const resetTime = error.response?.headers?.['x-ratelimit-reset'];
      if (resetTime) {
        const waitTime = Math.ceil((resetTime * 1000 - Date.now()) / 1000);
        errorMessage = `GitHub API rate limit exceeded. Try again in ${waitTime} seconds`;
        
        // Update our internal rate limit tracking
        this.rateLimit = {
          remaining: 0,
          reset: resetTime,
          lastChecked: Date.now()
        };
      }
    }
    
    logger.error(`${context} [${errorId}]: ${errorMessage}`, {
      repository: REPOSITORY_URL,
      stack: error.stack,
      status: error.status || error.response?.status,
      timestamp: new Date().toISOString()
    });

    const customError = new Error(`${context}. Error ID: ${errorId}`);
    customError.statusCode = error.status || error.response?.status || 500;
    customError.originalError = errorMessage;
    throw customError;
  }
}

// Singleton instance
module.exports = new GitService();