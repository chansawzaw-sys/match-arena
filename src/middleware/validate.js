'use strict';
// Shared request guards: zod validation, and a bot/spam hook.
// The bot hook is deliberately narrow in Part 1: it only rejects a filled
// honeypot field (real users never send one) and otherwise records nothing.
// It is a hook point for captcha/rate rules in later parts, not a claim
// that bots are fully blocked.
const { z } = require('zod');

function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) });
    }
    req.validated = parsed.data;
    return next();
  };
}

function validateParams(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.params || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) });
    }
    req.validatedParams = parsed.data;
    return next();
  };
}

function botGuard(req, res, next) {
  if (req.body && typeof req.body.website === 'string' && req.body.website.trim() !== '') {
    return res.status(400).json({ error: 'Bot check failed' });
  }
  return next();
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Never leak stack traces or internal messages to clients.
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { z, validate, validateParams, botGuard, notFound, errorHandler };
