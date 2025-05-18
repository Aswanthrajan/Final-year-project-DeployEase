const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const logger = require('../utils/logger');
const path = require('path');

// Configuration constants
const REPOSITORY_URL = process.env.REPOSITORY_URL || 'https://github.com/Aswanthrajan/blue';
const DEFAULT_BRANCHES = {
  MAIN: 'main',
  BLUE: 'blue',
  GREEN: 'green'
};
const REDIRECTS_FILE = '_redirects';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const VALID_FILE_EXTENSIONS = ['.html', '.css', '.js', '.json', '.txt', '.md'];
const CACHE_TTL = 300000; // 5 minutes

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
        timeout: 10000 // 10 seconds
      }
    });

    this.cache = new Map();
    this.rateLimit = {
      remaining: 5000,
      reset: 0
    };
  }

  /**
   * Initialize repository with blue-green branches
   * @returns {Promise<{status: string, branches: object}>}
   */
  async initializeRepository() {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      
      // Verify repository exists and we have access
      await this.verifyRepositoryAccess(owner, repo);

      const branches = await this.listBranches(owner, repo);

      const results = {
        [DEFAULT_BRANCHES.MAIN]: await this.ensureBranch(owner, repo, DEFAULT_BRANCHES.MAIN, branches),
        [DEFAULT_BRANCHES.BLUE]: await this.ensureBranch(owner, repo, DEFAULT_BRANCHES.BLUE, branches),
        [DEFAULT_BRANCHES.GREEN]: await this.ensureBranch(owner, repo, DEFAULT_BRANCHES.GREEN, branches)
      };

      // Initialize redirects file if not exists
      if (!(await this.fileExists(owner, repo, REDIRECTS_FILE, DEFAULT_BRANCHES.MAIN))) {
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
    if (![DEFAULT_BRANCHES.BLUE, DEFAULT_BRANCHES.GREEN].includes(branch)) {
      throw new Error(`Invalid deployment branch: ${branch}. Must be 'blue' or 'green'`);
    }

    try {
      const { owner, repo } = this.parseRepositoryUrl();
      
      // Validate files before deployment
      this.validateFiles(files);

      // Check rate limits
      await this.checkRateLimit();

      const commitHash = crypto.createHash('sha256')
        .update(JSON.stringify(files) + Date.now())
        .digest('hex');

      // Check cache to avoid duplicate deployments
      const cacheKey = `${branch}-${commitHash}`;
      if (this.cache.has(cacheKey)) {
        return this.cache.get(cacheKey);
      }

      // Create commit with all files
      const commitResult = await this.createCommit(
        owner,
        repo,
        branch,
        files,
        `${commitMessage} [${commitHash.slice(0, 7)}]`
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
      this.cache.set(cacheKey, result);
      setTimeout(() => this.cache.delete(cacheKey), CACHE_TTL);

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
   * @private
   */
  async checkRateLimit() {
    if (this.rateLimit.remaining < 10 && Date.now() < this.rateLimit.reset * 1000) {
      const waitTime = Math.ceil((this.rateLimit.reset * 1000 - Date.now()) / 1000);
      throw new Error(`GitHub rate limit exceeded. Try again in ${waitTime} seconds`);
    }

    const { data } = await this.octokit.rateLimit.get();
    this.rateLimit = {
      remaining: data.resources.core.remaining,
      reset: data.resources.core.reset
    };
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
      if (!file.path || !file.content) {
        throw new Error('Each file must have path and content properties');
      }

      if (seenPaths.has(file.path)) {
        throw new Error(`Duplicate file path: ${file.path}`);
      }
      seenPaths.add(file.path);

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

      const currentBranch = await this.getActiveBranch();
      if (currentBranch === targetBranch) {
        return {
          redirectsUrl: `https://github.com/${owner}/${repo}/blob/${DEFAULT_BRANCHES.MAIN}/${REDIRECTS_FILE}`,
          activeBranch: targetBranch,
          status: 'no_change',
          timestamp: new Date().toISOString()
        };
      }

      const result = await this.updateRedirectsFile(targetBranch);
      
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
   * Get deployment history for a branch
   * @param {string} branch - Target branch
   * @param {number} limit - Number of commits to return
   * @returns {Promise<Array<{id: string, message: string, timestamp: string, author: string, url: string, branch: string, status: string}>>}
   */
  async getDeploymentHistory(branch, limit = 10) {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      
      await this.checkRateLimit();

      const { data: commits } = await this.octokit.repos.listCommits({
        owner,
        repo,
        sha: branch,
        per_page: Math.min(limit, 100) // GitHub max is 100 per page
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
    } catch (error) {
      this.handleError('Failed to get deployment history', error);
    }
  }

  /**
   * Get currently active branch from redirects file
   * @returns {Promise<string>} - Active branch name (blue/green)
   */
  async getActiveBranch() {
    try {
      const { owner, repo } = this.parseRepositoryUrl();
      const content = await this.getFileContent(
        owner,
        repo,
        REDIRECTS_FILE,
        DEFAULT_BRANCHES.MAIN
      );

      if (content.includes(`/${DEFAULT_BRANCHES.BLUE}/`)) {
        return DEFAULT_BRANCHES.BLUE;
      }
      if (content.includes(`/${DEFAULT_BRANCHES.GREEN}/`)) {
        return DEFAULT_BRANCHES.GREEN;
      }
      return DEFAULT_BRANCHES.BLUE; // Default fallback
    } catch (error) {
      if (error.status === 404) {
        // Redirects file doesn't exist yet
        return DEFAULT_BRANCHES.BLUE;
      }
      this.handleError('Failed to detect active branch', error);
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
    const { data } = await this.octokit.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch
    });
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  /** List all branches in repository */
  async listBranches(owner, repo) {
    const { data } = await this.octokit.repos.listBranches({
      owner,
      repo,
      per_page: 100
    });
    return data.map(b => b.name);
  }

  /** Ensure branch exists or create from main */
  async ensureBranch(owner, repo, branch, existingBranches = []) {
    if (existingBranches.includes(branch)) {
      return 'exists';
    }

    const mainSha = await this.getBranchSha(owner, repo, DEFAULT_BRANCHES.MAIN);
    await this.octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: mainSha
    });

    return 'created';
  }

  /** Get SHA of the latest commit in a branch */
  async getBranchSha(owner, repo, branch) {
    const { data } = await this.octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`
    });
    return data.object.sha;
  }

  /** Get tree SHA for a commit */
  async getCommitTree(owner, repo, commitSha) {
    const { data } = await this.octokit.git.getCommit({
      owner,
      repo,
      commit_sha: commitSha
    });
    return data.tree.sha;
  }

  /** Create a new commit with files */
  async createCommit(owner, repo, branch, files, message) {
    const branchSha = await this.getBranchSha(owner, repo, branch);
    const baseTree = await this.getCommitTree(owner, repo, branchSha);

    // Create blobs for all files
    const blobs = await Promise.all(
      files.map(file => 
        this.octokit.git.createBlob({
          owner,
          repo,
          content: file.content,
          encoding: 'utf-8'
        })
      )
    );

    // Create new tree
    const newTree = await this.octokit.git.createTree({
      owner,
      repo,
      tree: files.map((file, i) => ({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blobs[i].data.sha
      })),
      base_tree: baseTree
    });

    // Create commit
    const newCommit = await this.octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: newTree.data.sha,
      parents: [branchSha]
    });

    // Update branch reference
    await this.octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.data.sha,
      force: false
    });

    return newCommit.data;
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

  /** Generate proper redirects content */
  generateRedirectsContent(activeBranch) {
    return `# DeployEase Traffic Routing
/*  /${activeBranch}/:splat  200
/   /${activeBranch}/index.html  200

# Additional redirect rules can be added below
# /old-path /new-path 301
`;
  }

  /** Standardized error handling */
  handleError(context, error) {
    const errorId = crypto.randomBytes(4).toString('hex');
    const errorMessage = error.response?.data?.message || error.message;
    
    logger.error(`${context} [${errorId}]: ${errorMessage}`, {
      repository: REPOSITORY_URL,
      stack: error.stack,
      status: error.status,
      timestamp: new Date().toISOString()
    });

    const customError = new Error(`${context}. Error ID: ${errorId}`);
    customError.statusCode = error.status || 500;
    throw customError;
  }
}

// Singleton instance
module.exports = new GitService();