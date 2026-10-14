#!/usr/bin/env node

/**
 * Small, dependency-free command-line controller for a ZWO SeeStar on the
 * local network. It keeps all network access local and uses the official
 * companion application's interoperability credential supplied by the owner.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const DEFAULT_HOST = process.env.SEESTAR_HOST || '192.168.8.24';
const DEFAULT_KEY = process.env.SEESTAR_KEY_PATH || path.join(__dirname, 'seestar.pem');

function usage(exitCode = 0) {
  console.log(`
SeeStar local controller

Usage:
  node seestar.js status [host]
  node seestar.js state [host]
  node seestar.js summary [host]
  node seestar.js goto <name> <ra-hours> <dec-deg> [host]
  node seestar.js mosaic <name> <ra-hours> <dec-deg> <scale> <angle-deg> [host]
  node seestar.js exposure <seconds> [host]
  node seestar.js stack [host]
  node seestar.js stop [host]
  node seestar.js park [host]

Environment:
  SEESTAR_HOST       Telescope address (default: ${DEFAULT_HOST})
  SEESTAR_KEY_PATH   Official app interoperability PEM (default: ./seestar.pem)

Coordinates use decimal RA hours and declination degrees. Example:
  node seestar.js goto "M33 Triangulum Galaxy" 1.5639 30.6603
`);
  process.exit(exitCode);
}

function cleanResult(result) {
  if (result === undefined) return null;
  return result;
}

class SeeStarClient {
  constructor(host, keyPath) {
    this.host = host;
    this.key = fs.readFileSync(keyPath);
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: 4700 });
      this.socket.setTimeout(20_000);
      this.socket.on('timeout', () => reject(new Error('Connection timed out.')));
      this.socket.on('error', reject);
      this.socket.on('data', chunk => this.onData(chunk));
      this.socket.on('connect', resolve);
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let marker;
    while ((marker = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, marker).trim();
      this.buffer = this.buffer.slice(marker + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  }

  send(method, params, verify = true) {
    const id = this.nextId++;
    const payload = { id, method };
    if (verify) payload.verify = true;
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No response for ${method}.`));
      }, 20_000);
      this.pending.set(id, {
        resolve: message => { clearTimeout(timer); resolve(message); },
      });
      this.socket.write(`${JSON.stringify(payload)}\r\n`);
    });
  }

  async authenticate() {
    const challenge = await this.send('get_verify_str', undefined, false);
    if (challenge.code !== 0 || !challenge.result?.str) throw new Error('The telescope did not supply an authentication challenge.');
    const signer = crypto.createSign('RSA-SHA1');
    signer.update(challenge.result.str);
    signer.end();
    const verify = await this.send('verify_client', {
      sign: signer.sign(this.key, 'base64'),
      data: challenge.result.str,
    }, false);
    if (verify.code !== 0) throw new Error(`Authentication was refused (${verify.error || verify.code}).`);
    const confirmation = await this.send('pi_is_verified', undefined, false);
    if (confirmation.code !== 0) throw new Error('The telescope did not confirm authentication.');
  }

  close() {
    if (this.socket) this.socket.end();
  }
}

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['-h', '--help', 'help'].includes(command)) usage();
  if (!fs.existsSync(DEFAULT_KEY)) {
    throw new Error(`No interoperability key found at ${DEFAULT_KEY}. Put the PEM extracted from your official SeeStar app there, or set SEESTAR_KEY_PATH.`);
  }

  let host = DEFAULT_HOST;
  let method;
  let params;
  switch (command) {
    case 'status':
      host = args[0] || host;
      method = 'get_device_state';
      break;
    case 'state':
      host = args[0] || host;
      method = 'iscope_get_app_state';
      break;
    case 'summary':
      host = args[0] || host;
      method = 'iscope_get_app_state';
      break;
    case 'goto': {
      const [name, ra, dec, suppliedHost] = args;
      if (!name || Number.isNaN(Number(ra)) || Number.isNaN(Number(dec))) usage(1);
      host = suppliedHost || host;
      method = 'iscope_start_view';
      params = { mode: 'star', target_name: name, target_ra_dec: [Number(ra), Number(dec)], lp_filter: false };
      break;
    }
    case 'mosaic': {
      const [name, ra, dec, scale, angle, suppliedHost] = args;
      const numeric = [ra, dec, scale, angle].map(Number);
      if (!name || numeric.some(Number.isNaN)) usage(1);
      host = suppliedHost || host;
      const [targetRa, targetDec, mosaicScale, mosaicAngle] = numeric;
      if (targetRa < 0 || targetRa >= 24 || targetDec < -90 || targetDec > 90 || mosaicScale <= 1) usage(1);
      method = 'iscope_start_view';
      params = {
        mode: 'star', target_name: name, target_ra_dec: [targetRa, targetDec], lp_filter: false,
        mosaic: { scale: mosaicScale, angle: mosaicAngle, star_map_angle: (361 + mosaicAngle) % 360, star_map_ratio: 1 },
      };
      break;
    }
    case 'exposure': {
      const [seconds, suppliedHost] = args;
      const milliseconds = Math.round(Number(seconds) * 1000);
      if (!Number.isFinite(milliseconds) || milliseconds < 1000 || milliseconds > 60000) usage(1);
      host = suppliedHost || host;
      method = 'set_setting';
      params = { expert_mode: true, exp_ms: { stack_l: milliseconds, continuous: 500 } };
      break;
    }
    case 'stack':
      host = args[0] || host;
      method = 'iscope_start_stack';
      params = { restart: false };
      break;
    case 'stop':
      host = args[0] || host;
      method = 'iscope_stop_view';
      params = { stage: 'Stack' };
      break;
    case 'park':
      host = args[0] || host;
      method = 'scope_park';
      break;
    default:
      usage(1);
  }

  const client = new SeeStarClient(host, DEFAULT_KEY);
  try {
    await client.connect();
    await client.authenticate();
    const reply = await client.send(method, params);
    if (reply.code !== 0) throw new Error(reply.error || `Telescope returned code ${reply.code}.`);
    if (command === 'summary') {
      const view = reply.result?.View || {};
      console.log(JSON.stringify({
        state: view.state, stage: view.stage, target: view.target_name, coordinates: view.target_ra_dec,
        stack: view.Stack ? { state: view.Stack.state, accepted: view.Stack.stacked_frame, dropped: view.Stack.dropped_frame, exposureMs: view.Stack.Exposure?.exp_ms } : null,
      }, null, 2));
    } else console.log(JSON.stringify(cleanResult(reply.result), null, 2));
  } finally {
    client.close();
  }
}

run().catch(error => {
  console.error(`SeeStar: ${error.message}`);
  process.exitCode = 1;
});
