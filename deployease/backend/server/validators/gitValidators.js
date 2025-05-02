// backend/server/validators/gitValidators.js
const Joi = require('joi');

const deploymentSchema = Joi.object({
  branch: Joi.string().valid('blue', 'green').required(),
  files: Joi.array().min(1).required(),
  commitMessage: Joi.string().optional()
});

module.exports = {
  validateDeploymentPayload: (payload) => deploymentSchema.validate(payload)
};