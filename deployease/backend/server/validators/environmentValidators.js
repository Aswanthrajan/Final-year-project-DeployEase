const Joi = require('joi');

// Validation schema for environment switching
const switchSchema = Joi.object({
  targetBranch: Joi.string()
    .valid('blue', 'green')
    .required()
    .messages({
      'any.required': 'Target branch is required',
      'string.base': 'Target branch must be a string',
      'any.only': 'Target branch must be either "blue" or "green"'
    }),
  // Optional: Add force flag for emergency overrides
  force: Joi.boolean()
    .default(false)
});

// Middleware function
const validateSwitchRequest = (req, res, next) => {
  const { error } = switchSchema.validate(req.body, { abortEarly: false });
  
  if (error) {
    const errors = error.details.map(detail => ({
      field: detail.context.key,
      message: detail.message
    }));
    
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors
    });
  }
  
  next();
};

module.exports = { validateSwitchRequest };