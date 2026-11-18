import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Controller, fanPatch } from '../dist/controller.js';

const profile = { power: false, modes: [], fanSpeeds: [], swingAxes: [], features: [] };

test('verifies a change after a lost response and serializes operations', async () => {
  let writes = 0;
  let active = 0;
  let device = {
    power: 1, mode: 1, temperature: 24, fanSpeed: 5, verticalFixation: 7,
    horizontalFixation: 7, mute: 0, turbo: 0, sleep: 0, health: 0,
    clean: 0, display: 1, mildew: 0, ambientTemp: 0,
  };
  const controller = new Controller({ ip: '192.168.1.100', mac: '02:00:00:00:00:01', profile }, () => ({
    state: { ...device },
    async connect() { assert.equal(++active, 1); return true; },
    async disconnect() { active--; },
    async getState() { this.state = { ...device }; return true; },
    async getInfo() { return false; },
    async setState() { writes++; device = { ...this.state }; throw new Error('response lost'); },
  }));

  const [changed, repeated] = await Promise.all([
    controller.change({ temperature: 23 }),
    controller.change({ temperature: 23 }),
  ]);
  assert.equal(writes, 1);
  assert.equal(changed.changed, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.targetCelsius, 23);
  assert.equal(repeated.swing.horizontal, false);
  assert.equal(repeated.reportedFlags.display, true);
  assert.equal((await controller.status()).ambientCelsius, null);
  assert.deepEqual((await controller.capabilities()).observed.autoFanCodes, [5]);
  assert.deepEqual(fanPatch('auto', 5), { fanSpeed: 5, mute: 0, turbo: 0 });
});

test('the MCP client lists tools and validates the profile without network access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kendal-mcp-'));
  const file = join(dir, 'profile.json');
  await writeFile(file, JSON.stringify({ power: true, temperature: { min: 18, max: 28, step: 1 }, modes: ['cool'] }));
  try {
    for (const configured of [false, true]) {
      const client = new Client({ name: 'test', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath, args: ['dist/index.js'],
        env: { AC_PROFILE_FILE: configured ? file : '', AC_MAC: '', AC_IP: '' },
      });
      try {
        await client.connect(transport);
        const names = (await client.listTools()).tools.map(tool => tool.name);
        assert.deepEqual(names, configured
          ? ['ac_get_status', 'ac_list_capabilities', 'ac_power', 'ac_set_temperature', 'ac_set_mode']
          : ['ac_get_status', 'ac_list_capabilities']);
        const status = await client.callTool({ name: 'ac_get_status' });
        assert.equal(status.isError, true);
        assert.match(status.content[0].text, /Set AC_MAC/);
        if (configured) {
          const invalid = await client.callTool({ name: 'ac_set_mode', arguments: { mode: 'heat' } });
          assert.equal(invalid.isError, true);
          assert.doesNotMatch(invalid.content[0].text, /Set AC_MAC/);
        }
      } finally {
        await client.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AUX Cloud selects the configured unit, decodes state, and verifies writes', async () => {
  const { CloudController } = await import('../dist/cloud.js');
  const endpoint = '00000000000000000000000000000001';
  const product = '111111111111111111111111c0620000';
  let params = { pwr: 1, temp: 240, envtemp: 220, ac_mode: 0, ac_mark: 0, ac_vdir: 0, ecomode: 0, pwrlimitswitch: 1 };
  let writes = 0;
  const env = {
    AC_CLOUD_EMAIL: 'test@example.invalid', AC_CLOUD_PASSWORD: 'test-only',
    AC_CLOUD_ENDPOINT: endpoint, AC_CLOUD_PRODUCT: product, AC_CLOUD_WRITE: '1',
  };
  const controller = new CloudController(env, region => {
    assert.equal(region, 'usa');
    return {
      async ensureLoggedIn() {},
      async listDevices(options) {
        assert.deepEqual([...options.includeIds], [endpoint]);
        return [{ endpointId: endpoint, productId: product, state: 1, cookie: 'test-only', params: { ...params, unrecognized: 93 } }];
      },
      async setDeviceParams(device, patch) {
        assert.equal(device.endpointId, endpoint);
        assert.deepEqual(patch, { temp: 225 });
        writes++;
        params = { ...params, ...patch };
        throw new Error('response lost');
      },
      async refreshDeviceParams() { return params; },
    };
  });
  const reply = await controller.status();
  assert.equal(reply.on, true);
  assert.equal(reply.targetCelsius, 24);
  assert.equal(reply.ambientCelsius, 22);
  assert.equal(reply.mode, 'cool');
  assert.equal(reply.fan, 'auto');
  assert.equal(reply.swing.vertical, false);
  assert.equal(reply.reportedFlags.eco, false);
  assert.equal(reply.reportedFlags.powerLimit, true);
  assert.doesNotMatch(JSON.stringify(reply), /test-only|unrecognized/);
  assert.equal((await controller.capabilities()).writesEnabled, true);
  const changed = await controller.change({ temp: 225 });
  assert.equal(changed.changed, true);
  assert.equal(changed.targetCelsius, 22.5);
  assert.equal((await controller.change({ temp: 225 })).changed, false);
  assert.equal(writes, 1);
  env.AC_CLOUD_PRODUCT = 'another device';
  await assert.rejects(controller.change({ temp: 225 }), /supported profile/);
});


test('setup inventory works without a configured device', async () => {
  const { CloudController } = await import('../dist/cloud.js');
  const controller = new CloudController({
    AC_CLOUD_EMAIL: 'test@example.invalid', AC_CLOUD_PASSWORD: 'test-only',
  }, () => ({
    async ensureLoggedIn() {},
    async listDevices(options) {
      assert.deepEqual(options, {});
      return [{
        endpointId: '00000000000000000000000000000002',
        productId: '111111111111111111111111c0620000',
        friendlyName: 'Bedroom',
        state: 1,
        cookie: 'test-only',
      }];
    },
  }));
  const [device] = await controller.inventory();
  assert.equal(device.name, 'Bedroom');
  assert.equal(device.online, true);
  assert.equal(device.compatibleWriteProfile, true);
  assert.doesNotMatch(JSON.stringify(device), /test-only|cookie/);
});
