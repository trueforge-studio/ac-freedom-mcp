import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AcError, readConfig } from './config.js';
import { Controller, fanPatch, modeCodes } from './controller.js';
import { CloudController, cloudAxes, cloudFans, cloudFeatures, cloudModes } from './cloud.js';

function errorMessage(error: unknown) {
  return error instanceof AcError ? error.message : 'Communication with the air conditioner failed.';
}

async function result(run: () => Promise<Record<string, unknown>>) {
  try {
    const data = await run();
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: errorMessage(error) }], isError: true };
  }
}

function registerCloudTools(server: McpServer, cloud: CloudController) {
  const readOnly = { readOnlyHint: true };
  server.registerTool('ac_get_status',
    { description: 'Read the current state of the air conditioner through AUX Cloud.', annotations: readOnly },
    () => result(() => cloud.status()));
  server.registerTool('ac_list_capabilities',
    { description: 'List the state fields reported by AUX Cloud and check whether writes are enabled.', annotations: readOnly },
    () => result(() => cloud.capabilities()));

  if (process.env.AC_CLOUD_WRITE !== '1') return;
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
  server.registerTool('ac_power',
    { description: 'Turn the air conditioner on or off.', inputSchema: { on: z.boolean() }, annotations },
    ({ on }) => result(() => cloud.change({ pwr: Number(on) })));
  server.registerTool('ac_set_temperature',
    { description: 'Set the target temperature from 16 to 32 °C in 0.5 °C increments.', inputSchema: { celsius: z.number().min(16).max(32).multipleOf(0.5) }, annotations },
    ({ celsius }) => result(() => cloud.change({ temp: Math.round(celsius * 10) })));
  server.registerTool('ac_set_mode',
    { description: 'Set the operating mode.', inputSchema: { mode: z.enum(Object.keys(cloudModes) as (keyof typeof cloudModes)[]) }, annotations },
    ({ mode }) => result(() => cloud.change({ ac_mode: cloudModes[mode] })));
  server.registerTool('ac_set_fan_speed',
    { description: 'Set the fan speed.', inputSchema: { speed: z.enum(Object.keys(cloudFans) as (keyof typeof cloudFans)[]) }, annotations },
    ({ speed }) => result(() => cloud.change({ ac_mark: cloudFans[speed] })));
  server.registerTool('ac_set_swing',
    { description: 'Turn swing on or off for one axis.', inputSchema: { axis: z.enum(['vertical', 'horizontal']), on: z.boolean() }, annotations },
    ({ axis, on }) => result(() => cloud.change({ [cloudAxes[axis]]: Number(on) })));
  server.registerTool('ac_set_feature',
    { description: 'Toggle the display, Sleep, Health, mildew prevention, Eco, or Power Limit.',
      inputSchema: { feature: z.enum(Object.keys(cloudFeatures) as (keyof typeof cloudFeatures)[]), on: z.boolean() }, annotations },
    ({ feature, on }) => result(() => cloud.change({ [cloudFeatures[feature]]: Number(on) })));
}

async function main() {
  const config = readConfig();
  if (process.argv.includes('--cloud-list')) {
    console.log(JSON.stringify(await new CloudController().inventory(), null, 2));
    return;
  }
  if (process.argv.includes('--cloud-probe')) {
    console.log(JSON.stringify(await new CloudController().status(), null, 2));
    return;
  }
  const controller = new Controller(config);
  if (process.argv.includes('--probe')) {
    console.log(JSON.stringify(await controller.capabilities(), null, 2));
    return;
  }

  const server = new McpServer({ name: 'kendal-mcp', version: '0.1.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  if (process.env.AC_TRANSPORT === 'cloud') {
    registerCloudTools(server, new CloudController());
    await server.connect(new StdioServerTransport());
    return;
  }

  const control = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool('ac_get_status',
    { description: 'Read the current state of the air conditioner over the local network.', annotations: readOnly },
    () => result(() => controller.status()));
  server.registerTool('ac_list_capabilities',
    { description: 'Read the device and list observed values and enabled controls.', annotations: readOnly },
    () => result(() => controller.capabilities()));

  const { profile } = config;
  if (profile.power) {
    server.registerTool('ac_power',
      { description: 'Turn the air conditioner on or off.', inputSchema: { on: z.boolean() }, annotations: control },
      ({ on }) => result(() => controller.change({ power: Number(on) })));
  }

  const range = profile.temperature;
  if (range) {
    server.registerTool('ac_set_temperature',
      { description: 'Set the target temperature in degrees Celsius.',
        inputSchema: { celsius: z.number().min(range.min).max(range.max).multipleOf(range.step) }, annotations: control },
      ({ celsius }) => result(() => controller.change({ temperature: celsius })));
  }

  if (profile.modes.length) {
    server.registerTool('ac_set_mode',
      { description: `Set the operating mode. Enabled modes: ${profile.modes.join(', ')}.`,
        inputSchema: { mode: z.enum(profile.modes) }, annotations: control },
      ({ mode }) => result(() => controller.change({ mode: modeCodes[mode] })));
  }

  if (profile.fanSpeeds.length) {
    server.registerTool('ac_set_fan_speed',
      { description: `Set the fan speed. Enabled speeds: ${profile.fanSpeeds.join(', ')}.`,
        inputSchema: { speed: z.enum(profile.fanSpeeds) }, annotations: control },
      ({ speed }) => result(() => controller.change(fanPatch(speed, profile.autoFanCode))));
  }

  if (profile.swingAxes.length) {
    server.registerTool('ac_set_swing',
      { description: `Set swing. Enabled axes: ${profile.swingAxes.join(', ')}.`,
        inputSchema: { axis: z.enum(profile.swingAxes), on: z.boolean() }, annotations: control },
      ({ axis, on }) => result(() => controller.change({ [axis === 'vertical' ? 'verticalFixation' : 'horizontalFixation']: on ? 0 : 7 })));
  }

  if (profile.features.length) {
    server.registerTool('ac_set_feature',
      { description: `Toggle an enabled feature: ${profile.features.join(', ')}.`,
        inputSchema: { feature: z.enum(profile.features), on: z.boolean() }, annotations: control },
      ({ feature, on }) => result(() => controller.change({ [feature]: Number(on) })));
  }

  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
