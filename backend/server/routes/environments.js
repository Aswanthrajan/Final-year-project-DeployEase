// backend/server/routes/environments.js
const express = require("express");
const router = express.Router();
const environmentController = require("../controllers/environmentController");
const { validateSwitchRequest } = require("../validators/environmentValidators.js");

// Get current environment status
router.get("/status", environmentController.getEnvironmentStatus);

// Switch traffic between blue and green environments
router.post("/switch", validateSwitchRequest, environmentController.switchTraffic);

// Rollback to original environment configuration
router.post("/rollback", environmentController.rollbackEnvironment);

// Legacy routes for backward compatibility
router.get("/environments-status", environmentController.getEnvironmentsStatus);
router.post("/legacy-switch", environmentController.legacySwitchTraffic);

module.exports = router;