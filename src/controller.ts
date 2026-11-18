import { BroadlinkAcApi, type RawState } from 'homebridge-ac-freedom/src/broadlink-api.js';
import { AcError, type Profile } from './config.js';
import { findDevice } from './discovery.js';

type LocalApi = Pick<BroadlinkAcApi, 'state' | 'connect' | 'disconnect' | 'getState' | 'getInfo' | 'setState'>;
type Connection = { ip?: string; mac?: string; profile: Profile };

class KendalLocalApi extends BroadlinkAcApi {
  protected override _parseState(data: Buffer) {
    if (data.length < 24 || data[2] !== 0xbb) throw new AcError('The LAN response does not contain valid AC Freedom state.');
    super._parseState(data);
  }

  protected override _parseInfo(data: Buffer) {
    if (data.length >= 34 && data[2] === 0xbb && data[33] <= 9) super._parseInfo(data);
  }
}

export const modeCodes = { auto: 0, cool: 1, dry: 2, heat: 4, fan: 6 } as const;
const fanCodes = { auto: 0, low: 3, medium: 2, high: 1, turbo: 4 } as const;

export function fanPatch(speed: keyof typeof fanCodes, autoCode?: 0 | 5): Partial<RawState> {
  return { fanSpeed: speed === 'auto' ? autoCode : fanCodes[speed],
    turbo: Number(speed === 'turbo'), mute: 0 };
}

function decode<T extends string>(codes: Record<T, number>, code: number) {
  return (Object.keys(codes) as T[]).find(key => codes[key] === code) ?? null;
}

function normalize(state: RawState) {
  return {
    on: state.power === 1,
    mode: decode(modeCodes, state.mode),
    targetCelsius: state.temperature,
    ambientCelsius: Number.isFinite(state.ambientTemp) ? state.ambientTemp : null,
    fan: state.turbo ? 'turbo' : state.mute ? 'quiet' : decode(fanCodes, state.fanSpeed === 5 ? 0 : state.fanSpeed),
    swing: { vertical: state.verticalFixation === 0, horizontal: state.horizontalFixation === 0 },
    reportedFlags: {
      display: state.display === 1, sleep: state.sleep === 1, health: state.health === 1,
      mildew: state.mildew === 1, cleaning: state.clean === 1,
    },
  };
}

export class Controller {
  private queue: Promise<unknown> = Promise.resolve();
  private discoveredIp?: string;
  private readonly observedModes = new Set<string>();
  private readonly observedFans = new Set<string>();
  private observedHalfDegree = false;
  private observedAmbient = false;
  private readonly observedAutoFanCodes = new Set<number>();

  constructor(
    readonly config: Connection,
    private readonly createApi: (ip: string, mac: string) => LocalApi = (ip, mac) => new KendalLocalApi(ip, mac),
  ) {}

  private async transact<T>(run: (api: LocalApi) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const { mac, ip } = this.config;
      if (!mac) throw new AcError('Set AC_MAC to identify the air conditioner on your local network.');
      const address = ip ?? this.discoveredIp ?? await findDevice(mac);
      if (!address) throw new AcError('The device could not be found by MAC address. Check the network or set AC_IP to the IPv4 address shown by your router.');
      this.discoveredIp = address;
      const api = this.createApi(address, mac);
      try {
        if (!await api.connect()) throw new AcError('The air conditioner did not respond to the local BroadLink connection.');
        return await run(api);
      } catch (error) {
        this.discoveredIp = undefined;
        throw error;
      } finally {
        await api.disconnect();
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  private async read(api: LocalApi, ambient: boolean) {
    if (!await api.getState() || api.state.temperature < 8 || api.state.temperature > 39.5) {
      throw new AcError('Could not read the air conditioner state over LAN.');
    }
    api.state.ambientTemp = NaN;
    if (ambient) await api.getInfo();
    const result = normalize(api.state);
    this.observedHalfDegree ||= result.targetCelsius % 1 === 0.5;
    this.observedAmbient ||= result.ambientCelsius !== null;
    if (result.mode) this.observedModes.add(result.mode);
    if (result.fan) this.observedFans.add(result.fan);
    if (result.fan === 'auto') this.observedAutoFanCodes.add(api.state.fanSpeed);
    return { transport: 'broadlink-lan', ...result };
  }

  status() {
    return this.transact(api => this.read(api, true));
  }

  async capabilities() {
    const state = await this.status();
    const { autoFanCode, ...controls } = this.config.profile;
    return {
      transport: state.transport,
      observed: {
        stateRead: true,
        ambientTemperature: this.observedAmbient,
        modes: [...this.observedModes],
        fanSpeeds: [...this.observedFans],
        autoFanCodes: [...this.observedAutoFanCodes],
        halfDegreeSetpoint: this.observedHalfDegree,
      },
      enabledByOwner: controls,
      note: 'The observed values come from device readings. The LAN protocol does not advertise a complete feature list.',
    };
  }

  change(patch: Partial<RawState>) {
    return this.transact(async api => {
      const before = await this.read(api, false);
      const desired = Object.entries(patch) as [keyof RawState, number][];
      if (desired.every(([field, value]) => api.state[field] === value)) {
        return { changed: false, ...before };
      }
      Object.assign(api.state, patch);
      // Always read back after attempting a write, including when its reply was lost.
      await api.setState().catch(() => false);
      let after;
      try {
        after = await this.read(api, false);
      } catch {
        throw new AcError('The command was attempted, but the final state could not be verified.');
      }
      if (desired.some(([field, value]) => api.state[field] !== value)) {
        throw new AcError('The device responded, but its state does not match the requested change.');
      }
      return { changed: true, ...after };
    });
  }
}
