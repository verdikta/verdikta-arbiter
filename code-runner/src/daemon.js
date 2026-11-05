'use strict';

/** What the runner needs to know about its Docker daemon, from `docker info`. */

const { runText, isUnreachableText } = require('./docker');

const INFO_TIMEOUT_MS = 10000;

/**
 * @returns {Promise<{reachable:boolean, error:string|null, serverVersion:string|null,
 *   runtimes:Object<string,{path:string|null, runtimeArgs:string[]}>, dockerRootDir:string|null,
 *   osType:string|null, architecture:string|null}>}
 */
async function dockerInfo(docker, { timeoutMs = INFO_TIMEOUT_MS, signal } = {}) {
  const down = (error) => ({ reachable: false, error, serverVersion: null, runtimes: {}, dockerRootDir: null, osType: null, architecture: null });
  const r = await runText(docker, ['info', '--format', '{{json .}}'], { timeoutMs, signal });
  if (r.spawnError) return down(`the docker CLI could not be started: ${r.spawnError}`);
  if (r.timedOut) return down('docker info did not answer in time');
  if (r.exitCode !== 0 || isUnreachableText(r.stderr)) {
    return down((r.stderr || `docker info exited ${r.exitCode}`).split('\n')[0].slice(0, 300));
  }
  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch (_) {
    return down('docker info returned something that is not JSON');
  }
  if (!info || !info.ServerVersion) {
    const err = info && Array.isArray(info.ServerErrors) && info.ServerErrors[0];
    return down(err ? String(err).slice(0, 300) : 'docker info has no server section');
  }
  const runtimes = {};
  for (const [name, rt] of Object.entries(info.Runtimes || {})) {
    runtimes[name] = {
      path: rt && typeof rt.path === 'string' ? rt.path : null,
      runtimeArgs: rt && Array.isArray(rt.runtimeArgs) ? rt.runtimeArgs.map(String) : []
    };
  }
  return {
    reachable: true,
    error: null,
    serverVersion: String(info.ServerVersion),
    runtimes,
    dockerRootDir: typeof info.DockerRootDir === 'string' ? info.DockerRootDir : null,
    osType: info.OSType || null,
    architecture: info.Architecture || null
  };
}

module.exports = { dockerInfo };
