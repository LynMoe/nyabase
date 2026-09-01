#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isLeftoverInstanceName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return name.startsWith('e2e-')
    || name.startsWith('nyc-')
    || name.startsWith('nyv-')
    || name.startsWith('nyabase-preflight-');
}

export function isLeftoverCustomVolumeName(name, type) {
  if (type && type !== 'custom') return false;
  if (typeof name !== 'string' || name.length === 0) return false;
  const base = name.split('/')[0];
  return base.startsWith('e2e-') || base.startsWith('nyv-');
}

export function isLeftoverApiName(value) {
  return isLeftoverInstanceName(value) || isLeftoverCustomVolumeName(value, 'custom');
}

function incusJson(ssh, args) {
  const label = ssh ?? 'local';
  try {
    const output = ssh
      ? execFileSync('ssh', [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=15',
        ssh,
        'incus',
        ...args,
      ], { encoding: 'utf8' })
      : execFileSync('incus', args, { encoding: 'utf8' });
    return JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`incus ${args.join(' ')} failed on ${label}: ${detail}`);
  }
}

export function labSshTargets(env = process.env) {
  const path = env.E2E_LAB_SERVERS_FILE?.trim();
  if (!path) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return (Array.isArray(data) ? data : [])
      .map((entry) => (typeof entry?.ssh === 'string' ? entry.ssh.trim() : ''))
      .filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`E2E_LAB_SERVERS_FILE is unreadable: ${detail}`);
  }
}

export function collectIncusLeftovers({ extraSsh = [], env = process.env } = {}) {
  const leftovers = [];
  const targets = [null, ...new Set([...labSshTargets(env), ...extraSsh.filter(Boolean)])];
  for (const ssh of targets) {
    const label = ssh ?? 'local';
    const instances = incusJson(ssh, ['list', '--format', 'json']);
    if (!Array.isArray(instances)) {
      throw new Error(`incus list on ${label} did not return an array`);
    }
    for (const entry of instances) {
      if (isLeftoverInstanceName(entry?.name)) {
        leftovers.push(`${label}:instance:${entry.name}`);
      }
    }
    const pools = incusJson(ssh, ['storage', 'list', '--format', 'json']);
    if (!Array.isArray(pools)) {
      throw new Error(`incus storage list on ${label} did not return an array`);
    }
    for (const pool of pools) {
      const poolName = pool?.name;
      if (typeof poolName !== 'string' || !poolName) continue;
      const volumes = incusJson(ssh, ['storage', 'volume', 'list', poolName, '--format', 'json']);
      if (!Array.isArray(volumes)) {
        throw new Error(`incus storage volume list ${poolName} on ${label} did not return an array`);
      }
      for (const volume of volumes) {
        if (isLeftoverCustomVolumeName(volume?.name, volume?.type)) {
          leftovers.push(`${label}:volume:${poolName}/${volume.name}`);
        }
      }
    }
  }
  return leftovers;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const leftovers = collectIncusLeftovers({ extraSsh: process.argv.slice(2) });
  for (const line of leftovers) {
    console.log(line);
  }
  if (leftovers.length > 0) {
    console.error(`Incus leftover inventory failed: ${leftovers.join(', ')}`);
    process.exit(1);
  }
}
