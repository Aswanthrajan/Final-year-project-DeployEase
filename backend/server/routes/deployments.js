// backend/server/routes/deployments.js
const express = require("express");
const router = express.Router();
const gitService = require("../services/gitService");
const netlifyService = require("../services/netlifyService");
const logger = require("../utils/logger");
const deploymentController = require("../controllers/deploymentController");

/**
 * @route POST /api/deployments
 * @desc Create a new deployment
 */
router.post("/", async (req, res) => {
    try {
        logger.info("New deployment request received", { body: req.body });
        
        const { branch, files, commitMessage } = req.body;
        
        // Validate input
        if (!branch || !files) {
            logger.warn("Invalid deployment request - missing branch or files");
            return res.status(400).json({ 
                success: false,
                error: "Branch and files are required" 
            });
        }

        // Validate branch
        if (!['blue', 'green'].includes(branch)) {
            logger.warn(`Invalid branch specified: ${branch}`);
            return res.status(400).json({
                success: false,
                error: "Invalid branch specified. Must be 'blue' or 'green'"
            });
        }

        // Validate files
        if (!Array.isArray(files) || files.length === 0) {
            logger.warn("Invalid files array received");
            return res.status(400).json({
                success: false,
                error: "Files must be a non-empty array"
            });
        }

        // Deploy to GitHub branch
        const deployment = await gitService.deployToBranch(
            branch,
            files,
            commitMessage || `DeployEase: ${branch} deployment`
        );

        logger.info("GitHub deployment successful", { deployment });

        // Trigger Netlify build
        const build = await netlifyService.triggerDeploy(branch);
        logger.info("Netlify build triggered", { build });

        res.json({
            success: true,
            github: deployment,
            netlify: build,
            deployId: `${branch}-${Date.now()}`
        });
    } catch (error) {
        logger.error("Deployment failed", {
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

/**
 * @route GET /api/deployments/history/all
 * @desc Get deployment history for all branches
 */
router.get("/history/all", async (req, res) => {
  try {
    // Get history for both blue and green branches
    const blueHistory = await gitService.getDeploymentHistory('blue');
    const greenHistory = await gitService.getDeploymentHistory('green');
    
    res.json({
      success: true,
      blue: blueHistory,
      green: greenHistory,
      repository: process.env.REPOSITORY_URL
    });
  } catch (error) {
    logger.error('Failed to get deployment history', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * @route GET /api/deployments/history/:branch
 * @desc Get deployment history for a branch
 */
router.get("/history/:branch", async (req, res) => {
  try {
    const { branch } = req.params;
    const history = await gitService.getDeploymentHistory(branch);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/deployments/rollback/:branch/:commitSha
 * @desc Rollback to a specific commit
 */
router.post("/rollback/:branch/:commitSha", async (req, res) => {
  try {
    const { branch, commitSha } = req.params;
    const result = await gitService.rollbackToCommit(branch, commitSha);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;