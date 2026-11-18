import { AuxCloudClient, type AuxDevice } from 'homebridge-aux-cloud/dist/api/AuxCloudClient.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { AcError } from './config.js';

export const cloudModes = { cool: 0, heat: 1, dry: 2, fan: 3, auto: 4 } as const;
export const cloudFans = { auto: 0, low: 1, medium: 2, high: 3, turbo: 4, quiet: 5 } as const;
export const cloudAxes = { vertical: 'ac_vdir', horizontal: 'ac_hdir' } as const;
export const cloudFeatures = {
  display: 'scrdisp', sleep: 'ac_slp', health: 'ac_health', mildew: 'mldprf',
  eco: 'ecomode', powerLimit: 'pwrlimitswitch',
} as const;

type CloudApi = Pick<AuxCloudClient, 'ensureLoggedIn' | 'invalidateSession' | 'listDevices' | 'setDeviceParams' | 'refreshDeviceParams'>;
type CloudPatch = Partial<Record<'pwr' | 'temp' | 'ac_mode' | 'ac_mark' | typeof cloudAxes[keyof typeof cloudAxes] |
  typeof cloudFeatures[keyof typeof cloudFeatures], number>>;

function flag(value: number | undefined) {
  return value === 1 ? true : value === 0 ? false : null;
}

function decode<T extends string>(codes: Record<T, number>, value: number | undefined) {
  return (Object.keys(codes) as T[]).find(key => codes[key] === value) ?? null;
}

function temperature(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value / 10 : null;
}

function statusFrom(params: Record<string, number>) {
  if (flag(params.pwr) === null) throw new AcError('AUX Cloud found the device but returned no valid state.');
  const target = temperature(params.temp);
  const conversion = Number.isFinite(params.ac_tempconvert) ? params.ac_tempconvert / 10 : 0;
  return {
    transport: 'aux-cloud',
    on: flag(params.pwr),
    targetCelsius: target === null ? null : target + (params.tempunit === 2 ? conversion : 0),
    ambientCelsius: temperature(params.envtemp),
    mode: decode(cloudModes, params.ac_mode),
    fan: decode(cloudFans, params.ac_mark),
    swing: { vertical: flag(params.ac_vdir), horizontal: flag(params.ac_hdir) },
    reportedFlags: {
      display: flag(params.scrdisp), sleep: flag(params.ac_slp),
      health: flag(params.ac_health), mildew: flag(params.mldprf),
      eco: flag(params.ecomode), powerLimit: flag(params.pwrlimitswitch),
    },
  };
}

export class CloudController {
  private client?: CloudApi;
  private keychainPassword?: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly createClient: (region: string) => CloudApi =
      region => new AuxCloudClient({ region, requestTimeoutMs: 6000 }),
  ) {}

  private async password(email: string) {
    if (this.env.AC_CLOUD_PASSWORD) return this.env.AC_CLOUD_PASSWORD;
    if (this.keychainPassword) return this.keychainPassword;
    const service = this.env.AC_CLOUD_KEYCHAIN_SERVICE;
    if (!service || process.platform !== 'darwin') return undefined;
    try {
      const { stdout } = await promisify(execFile)('/usr/bin/security',
        ['find-generic-password', '-s', service, '-a', email, '-w'], { timeout: 60000 });
      this.keychainPassword = stdout.replace(/\n$/, '');
      return this.keychainPassword;
    } catch {
      throw new AcError('Could not read the AC Freedom password from the macOS Keychain.');
    }
  }

  private async listDevices(endpoint?: string) {
    const email = this.env.AC_CLOUD_EMAIL?.trim();
    const region = this.env.AC_CLOUD_REGION || 'usa';
    if (!email) throw new AcError('Configure the AC Freedom email and password locally.');
    if (!['usa', 'eu', 'cn'].includes(region)) throw new AcError('The AUX Cloud region must be usa, eu, or cn.');

    const password = await this.password(email);
    if (!password) throw new AcError('Configure the AC Freedom email and password locally.');
    const client = this.client ??= this.createClient(region);
    try {
      await client.ensureLoggedIn(email, password);
    } catch {
      this.keychainPassword = undefined;
      throw new AcError('AUX Cloud sign-in failed. Check the region, network connection, and account access.');
    }

    try {
      const devices = await client.listDevices(endpoint ? { includeIds: new Set([endpoint]) } : {});
      return { client, devices };
    } catch {
      client.invalidateSession();
      throw new AcError('Sign-in succeeded, but AUX Cloud could not list the devices.');
    }
  }

  async inventory() {
    const { devices } = await this.listDevices();
    return devices.map(device => ({
      name: device.friendlyName,
      endpoint: device.endpointId,
      product: device.productId,
      online: device.state === 1,
      compatibleWriteProfile: this.hasWriteProfile(device),
    }));
  }

  private transact<T>(run: (client: CloudApi, device: AuxDevice) => Promise<T>) {
    const task = this.queue.then(async () => {
      const endpoint = this.env.AC_CLOUD_ENDPOINT?.trim().toLowerCase();
      if (!endpoint || !/^[a-f\d]{32}$/.test(endpoint)) {
        throw new AcError('Set AC_CLOUD_ENDPOINT. Run npm run cloud-list to see the devices on your account.');
      }
      const { client, devices } = await this.listDevices(endpoint);
      const device = devices.find(candidate => candidate.endpointId.toLowerCase() === endpoint);
      if (!device) throw new AcError('The account did not return a device with the configured endpoint ID.');
      return run(client, device);
    });
    this.queue = task.catch(() => {});
    return task;
  }

  status() {
    return this.transact(async (_client, device) => statusFrom(device.params));
  }

  capabilities() {
    return this.transact(async (_client, device) => {
      const status = statusFrom(device.params);
      const available = Object.entries({
        power: status.on, targetTemperature: status.targetCelsius, ambientTemperature: status.ambientCelsius,
        mode: status.mode, fan: status.fan, verticalSwing: status.swing.vertical,
        horizontalSwing: status.swing.horizontal, ...status.reportedFlags,
      }).filter(([, value]) => value !== null).map(([key]) => key);
      return { transport: status.transport, observedFields: available, writesEnabled: this.canWrite(device) };
    });
  }

  private hasWriteProfile(device: AuxDevice) {
    return /^[a-f\d]{24}c0620000$/i.test(device.productId ?? '');
  }

  private canWrite(device: AuxDevice) {
    const product = this.env.AC_CLOUD_PRODUCT?.trim().toLowerCase();
    return this.env.AC_CLOUD_WRITE === '1' && this.hasWriteProfile(device) &&
      device.productId.toLowerCase() === product;
  }

  change(patch: CloudPatch) {
    return this.transact(async (client, device) => {
      if (!this.canWrite(device)) throw new AcError('AUX Cloud commands require write access to be enabled and the device to match a supported profile.');
      if (device.state !== 1) throw new AcError('AUX Cloud reports that the air conditioner is offline.');
      const before = statusFrom(device.params);
      if (patch.temp !== undefined && device.params.tempunit === 2) {
        throw new AcError('Set the device to Celsius in AC Freedom before changing its setpoint through this server.');
      }
      const entries = Object.entries(patch);
      if (entries.some(([key]) => !Number.isFinite(device.params[key]))) {
        throw new AcError('The device did not report the setting you tried to change.');
      }
      const matches = (params: Record<string, number>) => entries.every(([key, value]) => params[key] === value);
      if (matches(device.params)) return { changed: false, ...before };
      await client.setDeviceParams(device, patch).catch(() => {});
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await delay(700);
        const params = await client.refreshDeviceParams(device).catch(() => undefined);
        if (params && matches(params) && flag(params.pwr) !== null) {
          return { changed: true, ...statusFrom(params) };
        }
      }
      throw new AcError('Could not verify the change through AUX Cloud. Check the current state before trying again.');
    });
  }
}
