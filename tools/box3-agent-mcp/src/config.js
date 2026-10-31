/**
 * Configuration for the live-agent MCP.
 *
 * The join code is the only credential a human needs to hand over; the MCP
 * redeems it for an `agx_` token on first use and keeps that token in memory.
 * The base URLs are public origins (e.g. https://box3.cdk.lat/edit), not
 * loopback, which is what lets a deployed editor be driven from another machine.
 */
import process from 'node:process';

function trim(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function int(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function loadConfig(env = process.env) {
  const shared = trim(env.BOX_AGENT_BASE_URL);
  const mapBaseUrl = trim(env.BOX_MAP_AGENT_BASE_URL) || shared || 'http://127.0.0.1:3127';
  const voxaBaseUrl = trim(env.BOX_VOXA_AGENT_BASE_URL) || shared || 'http://127.0.0.1:3123';
  const sharedCode = String(env.BOX_AGENT_JOIN_CODE || '').trim();

  return {
    mapBaseUrl,
    voxaBaseUrl,
    mapCode: String(env.BOX_MAP_AGENT_CODE || '').trim() || sharedCode,
    voxaCode: String(env.BOX_VOXA_AGENT_CODE || '').trim() || sharedCode,
    mapToken: String(env.BOX_MAP_AGENT_TOKEN || env.BOX_AGENT_TOKEN || '').trim(),
    voxaToken: String(env.BOX_VOXA_AGENT_TOKEN || env.BOX_AGENT_TOKEN || '').trim(),
    /** Optional override; otherwise discovered from the join response. */
    mapProject: String(env.BOX_MAP_PROJECT || '').trim(),
    corpusRoot: String(env.BOX_AGENT_CORPUS_ROOT || '').trim(),
    voxaModelId: int(env.BOX_VOXA_MODEL_ID, 0),
    agentName: String(env.BOX_AGENT_NAME || 'zcode').trim().slice(0, 60) || 'zcode',
    waitMs: int(env.BOX_AGENT_WAIT_MS, 30_000),
    requestTimeoutMs: int(env.BOX_AGENT_TIMEOUT_MS, 180_000),
    /** Floor between two edit commands, so a human can follow the work. */
    minActionMs: int(env.BOX_AGENT_MIN_ACTION_MS, 250),
    allowWrite: !['0', 'false', 'no', 'off'].includes(String(env.BOX_AGENT_ALLOW_WRITE || '').toLowerCase()),
  };
}
