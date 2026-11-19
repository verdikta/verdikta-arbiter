const { createHash, timingSafeEqual } = require('crypto');

// Separate credentials for the two trust boundaries. Never allow an unset key
// to turn authentication off, including in development or test deployments.
function validServiceToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token);
}

function authenticateService(header, expected) {
  if (!validServiceToken(expected)) return 503;
  const match = typeof header === 'string' && /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(header);
  if (!match) return 401;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(expected)) ? 200 : 401;
}

function requireServiceAuth(req, res, next) {
  const status = authenticateService(req.headers.authorization, process.env.EA_API_TOKEN);
  if (status === 200) return next();
  res.set('Cache-Control', 'no-store');
  if (status === 401) res.set('WWW-Authenticate', 'Bearer');
  return res.status(status).json({ status: 'errored', statusCode: status,
    error: status === 503 ? 'Service authentication is not configured' : 'Unauthorized' });
}

module.exports = { validServiceToken, authenticateService, requireServiceAuth };
