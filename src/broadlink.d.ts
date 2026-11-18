// Private API from homebridge-ac-freedom 2.3.8.
declare module 'homebridge-ac-freedom/src/broadlink-api.js' {
  export interface RawState {
    power: number;
    mode: number;
    temperature: number;
    fanSpeed: number;
    verticalFixation: number;
    horizontalFixation: number;
    mute: number;
    turbo: number;
    sleep: number;
    health: number;
    clean: number;
    display: number;
    mildew: number;
    ambientTemp: number;
  }

  export class BroadlinkAcApi {
    constructor(ip: string, mac: string);
    state: RawState;
    connect(): Promise<boolean>;
    disconnect(): Promise<void>;
    getState(): Promise<boolean>;
    getInfo(): Promise<boolean>;
    setState(): Promise<boolean>;
    protected _parseState(data: Buffer): void;
    protected _parseInfo(data: Buffer): void;
  }
}
