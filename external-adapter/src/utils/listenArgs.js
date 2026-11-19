/**
 * Arguments for `server.listen()`: the port, plus the HOST address when it names
 * a SPECIFIC interface.
 *
 * Every wildcard value means "as before": HOST unset or blank, and also `0.0.0.0`,
 * `::` and `*`. That matters: installer/bin/install-adapter.sh has written
 * `HOST=0.0.0.0` into external-adapter/.env on every install, a value nothing
 * read until now. Passing it to listen() would silently turn the adapter's
 * dual-stack listener (Node's default, `::`) into an IPv4-only one on the next
 * restart, so a wildcard keeps the plain `listen(port)`.
 *
 * Do NOT make a specific address the default: the Chainlink container calls the
 * adapter through the host's own address (the bridge URL is
 * http://<host ip>:8080/evaluate), so a loopback-only adapter would cut Chainlink
 * off from it.
 *
 * Port 8080 has no authentication of its own. What keeps it away from the
 * internet is the firewall rule installed by arbiter-firewall.sh, scoped to the
 * public network interface (installer/util/arbiter-firewall.sh). A specific HOST
 * exists for operators who run Chainlink and the adapter differently (for
 * example HOST set to the docker0 gateway after re-pointing the bridge to
 * host.docker.internal).
 *
 * @param {Object} [env] - environment to read (default process.env)
 * @returns {Array} [port] or [port, host]
 */
const WILDCARDS = new Set(['', '0.0.0.0', '::', '[::]', '*']);

function listenArgs(env = process.env) {
  const port = env.PORT || 8080;
  const host = (env.HOST || '').trim();
  return WILDCARDS.has(host) ? [port] : [port, host];
}

module.exports = { listenArgs };
