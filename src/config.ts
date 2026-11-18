import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isPrivateIp } from './discovery.js';

export const modes = ['auto', 'cool', 'heat', 'dry', 'fan'] as const;
export const fans = ['auto', 'low', 'medium', 'high', 'turbo'] as const;
export const axes = ['vertical', 'horizontal'] as const;
export const features = ['display', 'sleep', 'health', 'mildew'] as const;

const profileSchema = z.strictObject({
  power: z.boolean().default(false),
  temperature: z.strictObject({
    min: z.number().min(16).max(32).multipleOf(0.5),
    max: z.number().min(16).max(32).multipleOf(0.5),
    step: z.union([z.literal(0.5), z.literal(1)]),
  }).refine(value => value.min <= value.max && value.min % value.step === 0 && value.max % value.step === 0).optional(),
  modes: z.array(z.enum(modes)).default([]),
  fanSpeeds: z.array(z.enum(fans)).default([]),
  autoFanCode: z.union([z.literal(0), z.literal(5)]).optional(),
  swingAxes: z.array(z.enum(axes)).default([]),
  features: z.array(z.enum(features)).default([]),
}).refine(profile => !profile.fanSpeeds.includes('auto') || profile.autoFanCode !== undefined);
export type Profile = z.infer<typeof profileSchema>;

export class AcError extends Error {}

export function readConfig() {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envPath)) loadEnvFile(envPath);
  const rawMac = process.env.AC_MAC?.trim().toLowerCase();
  const ip = process.env.AC_IP?.trim() || undefined;
  if (rawMac && !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/.test(rawMac)) {
    throw new AcError('AC_MAC must contain six colon-separated hexadecimal pairs.');
  }
  if (ip && !isPrivateIp(ip)) throw new AcError('AC_IP must be a private IPv4 address.');
  const path = process.env.AC_PROFILE_FILE;
  try {
    const profile = profileSchema.parse(path ? JSON.parse(readFileSync(path, 'utf8')) : {});
    return { mac: rawMac, ip, profile };
  } catch {
    throw new AcError('AC_PROFILE_FILE could not be read or contains an invalid profile.');
  }
}
