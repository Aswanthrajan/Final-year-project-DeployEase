// backend/server/routes/environments.js
const express = require("express");
const router = express.Router();
const environmentController = require("../controllers/environmentController");
const { validateSwitchRequest } = require("../validators/environmentValidators.js");

router.get("/status", environmentController.getEnvironmentStatus);
router.post("/switch", validateSwitchRequest, environmentController.switchTraffic);

module.exports = router;