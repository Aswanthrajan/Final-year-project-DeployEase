// backend/server/routes/deployments.js
const express = require("express");
const router = express.Router();
const deploymentController = require("../controllers/deploymentController");
const logger = require("../utils/logger");

/**
 * @swagger
 * /api/deployments:
 *   post:
 *     summary: Create a new deployment
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               branch:
 *                 type: string
 *                 enum: [blue, green]
 *               files:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     path:
 *                       type: string
 *                     content:
 *                       type: string
 *               commitMessage:
 *                 type: string
 *     responses:
 *       200:
 *         description: Deployment started successfully
 *       400:
 *         description: Invalid input
 *       500:
 *         description: Deployment failed
 */
router.post("/", async (req, res) => {
    try {
        logger.info("New deployment request received", { 
            branch: req.body.branch,
            fileCount: req.body.files?.length || 0
        });

        // Validate input
        if (!req.body.branch || !req.body.files) {
            logger.warn("Invalid deployment request - missing branch or files");
            return res.status(400).json({ 
                success: false,
                error: "Branch and files are required" 
            });
        }

        // Validate branch
        if (!['blue', 'green'].includes(req.body.branch)) {
            logger.warn(`Invalid branch specified: ${req.body.branch}`);
            return res.status(400).json({
                success: false,
                error: "Invalid branch specified. Must be 'blue' or 'green'"
            });
        }

        // Validate files
        if (!Array.isArray(req.body.files) || req.body.files.length === 0) {
            logger.warn("Invalid files array received");
            return res.status(400).json({
                success: false,
                error: "Files must be a non-empty array"
            });
        }

        await deploymentController.createDeployment(req, res);
    } catch (error) {
        logger.error("Deployment route error", {
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
 * @swagger
 * /api/deployments/history/all:
 *   get:
 *     summary: Get deployment history for all branches
 *     responses:
 *       200:
 *         description: Successful operation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 blue:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Deployment'
 *                 green:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Deployment'
 *                 repository:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *       500:
 *         description: Failed to get history
 */
router.get("/history/all", async (req, res) => {
    try {
        logger.debug("Fetching all deployment history");
        await deploymentController.getAllDeploymentHistory(req, res);
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
 * @swagger
 * /api/deployments/history/{branch}:
 *   get:
 *     summary: Get deployment history for a specific branch
 *     parameters:
 *       - in: path
 *         name: branch
 *         schema:
 *           type: string
 *           enum: [blue, green]
 *         required: true
 *     responses:
 *       200:
 *         description: Successful operation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 branch:
 *                   type: string
 *                 deployments:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Deployment'
 *                 repository:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *       400:
 *         description: Invalid branch specified
 *       500:
 *         description: Failed to get history
 */
router.get("/history/:branch", async (req, res) => {
    try {
        const { branch } = req.params;
        logger.debug(`Fetching deployment history for branch: ${branch}`);

        if (!['blue', 'green'].includes(branch)) {
            logger.warn(`Invalid branch specified in history request: ${branch}`);
            return res.status(400).json({
                success: false,
                message: "Invalid branch specified"
            });
        }

        await deploymentController.getDeploymentHistory(req, res);
    } catch (error) {
        logger.error(`Failed to get history for branch ${req.params.branch}`, {
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
 * @swagger
 * /api/deployments/rollback/{branch}/{commitSha}:
 *   post:
 *     summary: Rollback to a specific commit
 *     parameters:
 *       - in: path
 *         name: branch
 *         schema:
 *           type: string
 *           enum: [blue, green]
 *         required: true
 *       - in: path
 *         name: commitSha
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       200:
 *         description: Rollback successful
 *       400:
 *         description: Invalid branch specified
 *       500:
 *         description: Rollback failed
 */
router.post("/rollback/:branch/:commitSha", async (req, res) => {
    try {
        const { branch, commitSha } = req.params;
        logger.info(`Rollback request received for ${branch} to commit ${commitSha}`);

        if (!['blue', 'green'].includes(branch)) {
            logger.warn(`Invalid branch specified in rollback: ${branch}`);
            return res.status(400).json({
                success: false,
                message: "Invalid branch specified"
            });
        }

        if (!commitSha || commitSha.length < 7) {
            logger.warn(`Invalid commit SHA in rollback: ${commitSha}`);
            return res.status(400).json({
                success: false,
                message: "Invalid commit SHA"
            });
        }

        await deploymentController.rollbackToRevision(req, res);
    } catch (error) {
        logger.error('Rollback failed', {
            error: error.message,
            stack: error.stack,
            params: req.params
        });
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

/**
 * @swagger
 * components:
 *   schemas:
 *     Deployment:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         branch:
 *           type: string
 *           enum: [blue, green]
 *         status:
 *           type: string
 *         timestamp:
 *           type: string
 *         commitSha:
 *           type: string
 *         commitUrl:
 *           type: string
 *         commitMessage:
 *           type: string
 *         committer:
 *           type: string
 */

module.exports = router;