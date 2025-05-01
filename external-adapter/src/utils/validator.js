const Joi = require('joi');

// Define the schema for the request
const requestSchema = Joi.object({
  id: Joi.string().required(),
  data: Joi.object({
    cid: Joi.string().required()
  }).required(),
  meta: Joi.object().optional()
}).unknown(true);

// Define manifest schema
const manifestSchema = Joi.object({
  version: Joi.string().required(),
  name: Joi.string().optional(),
  primary: Joi.object({
    filename: Joi.string().required(),
    hash: Joi.string().optional()
  }).required(),
  bCIDs: Joi.object().pattern(
    Joi.string(),
    Joi.string()
  ).optional(),
  addendum: Joi.string().optional(),
  additional: Joi.array().items(
    Joi.object({
      name: Joi.string().required(),
      type: Joi.string().required(),
      filename: Joi.string().optional(),
      hash: Joi.string().optional(),
      description: Joi.string().optional()
    })
  ).optional(),
  support: Joi.array().items(
    Joi.object({
      hash: Joi.alternatives().try(
        Joi.string(),
        Joi.object({
          cid: Joi.string().required(),
          description: Joi.string().optional(),
          id: Joi.number().optional()
        })
      ).required()
    })
  ).optional(),
  juryParameters: Joi.object({
    NUMBER_OF_OUTCOMES: Joi.number().optional(),
    AI_NODES: Joi.array().items(
      Joi.object({
        AI_MODEL: Joi.string().required(),
        AI_PROVIDER: Joi.string().required(),
        NO_COUNTS: Joi.number().required(),
        WEIGHT: Joi.number().required()
      })
    ).optional(),
    ITERATIONS: Joi.number().optional()
  }).optional()
});

// Validate the request
const validateRequest = async (request) => {
  try {
    await requestSchema.validateAsync(request);
  } catch (error) {
    throw new Error(`Invalid request: ${error.message}`);
  }
};

// Validate the manifest
const validateManifest = async (manifest) => {
  try {
    await manifestSchema.validateAsync(manifest);
  } catch (error) {
    throw new Error(`Invalid manifest: ${error.message}`);
  }
};

module.exports = {
  validateRequest,
  requestSchema,
  validateManifest,
  manifestSchema
};