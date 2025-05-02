const express = require('express');
const router = express.Router();
const gitController = require('../controllers/gitController');

router.post('/initialize', gitController.initializeRepository);
router.post('/deploy', gitController.deployToEnvironment);
router.post('/switch', gitController.switchEnvironment);
router.get('/status', gitController.getDeploymentStatus);

module.exports = router;