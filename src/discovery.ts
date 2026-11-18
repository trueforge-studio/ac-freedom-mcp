import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';

export function isPrivateIp(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function findInArp(mac: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)('arp', ['-an'], { timeout: 1000 });
    for (const line of stdout.split('\n')) {
      const entry = /\(([^()]+)\) at ((?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2})\s/i.exec(line);
      if (entry && isPrivateIp(entry[1]) &&
          entry[2].toLowerCase().split(':').map(byte => byte.padStart(2, '0')).join(':') === mac) {
        return entry[1];
      }
    }
  } catch {
    // Some systems do not expose ARP entries to this process.
  }
}

// Discovery frame and MAC offset documented in azadaydinli/ac_freedom.
function hello(address: string, port: number): Buffer {
  const now = new Date();
  const frame = Buffer.alloc(0x30);
  frame.writeInt32LE(Math.trunc(-now.getTimezoneOffset() / 60), 8);
  frame.writeUInt16LE(now.getFullYear(), 12);
  frame.set([now.getMinutes(), now.getHours(), now.getFullYear() % 100,
    (now.getDay() + 6) % 7, now.getDate(), now.getMonth() + 1], 14);
  frame.set(address.split('.').map(Number), 0x18);
  frame.writeUInt16LE(port, 0x1c);
  frame[0x26] = 6;
  frame.writeUInt16LE(frame.reduce((sum, byte) => sum + byte, 0xbeaf) & 0xffff, 0x20);
  return frame;
}

async function broadcast(mac: string, address: string, netmask: string): Promise<string | undefined> {
  const expected = Buffer.from(mac.replaceAll(':', ''), 'hex').reverse();
  const masks = netmask.split('.').map(Number);
  const destination = address.split('.').map((part, i) => Number(part) | (255 ^ masks[i])).join('.');
  const socket = createSocket('udp4');
  return new Promise(resolve => {
    let finished = false;
    const finish = (ip?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* The socket may still be binding. */ }
      resolve(ip);
    };
    const timer = setTimeout(finish, 3000);
    socket.once('error', () => finish());
    socket.on('message', (data, remote) => {
      if (data.length >= 0x40 && isPrivateIp(remote.address) &&
          data.subarray(0x3a, 0x40).equals(expected)) finish(remote.address);
    });
    socket.bind(0, address, () => {
      if (finished) return;
      try {
        socket.setBroadcast(true);
        const packet = hello(address, socket.address().port);
        for (const port of [80, 15001, 2415]) {
          socket.send(packet, port, destination, () => {});
          socket.send(packet, port, '255.255.255.255', () => {});
        }
      } catch {
        finish();
      }
    });
  });
}

export async function findDevice(mac: string): Promise<string | undefined> {
  const cached = await findInArp(mac);
  if (cached) return cached;
  const interfaces = Object.values(networkInterfaces()).flat().filter(
    (item): item is NonNullable<typeof item> => item?.family === 'IPv4' && !item.internal && isPrivateIp(item.address) && item.netmask !== '255.255.255.255',
  );
  const replies = await Promise.all(interfaces.map(item => broadcast(mac, item.address, item.netmask)));
  return replies.find(Boolean);
}
