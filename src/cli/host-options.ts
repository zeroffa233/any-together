import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';

const DEFAULT_PORT = 8765;
const CONFIG_EXTENSION = '.yml';
const CONFIG_KEYS: Record<string, true> = {
  port: true,
  name: true,
  sessionId: true,
  autoAccept: true,
  resource: true,
  share: true,
  mediaPort: true,
};

type HostOptionValues = {
  port?: number;
  sessionName?: string;
  fixedSessionId?: string;
  autoAccept?: boolean;
  resourceUrl?: string;
  sharePath?: string;
  mediaPort?: number;
};

export type ResolvedHostOptions = {
  port: number;
  autoAccept: boolean;
  sessionName?: string;
  fixedSessionId?: string;
  resourceUrl?: string;
  sharePath?: string;
  mediaPort?: number;
  configPath?: string;
};

type ParsedCommandLine = {
  values: HostOptionValues;
  configPath?: string;
};

export class HostOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostOptionsError';
  }
}

function parsePort(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new HostOptionsError(`${label} must be an integer in 0-65535`);
  }
  return parsed;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HostOptionsError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseSessionName(value: unknown, label: string): string {
  const name = parseNonEmptyString(value, label);
  if (/\s/.test(name)) {
    throw new HostOptionsError(`${label} must not contain whitespace`);
  }
  return name;
}

function commandValue(args: string[], index: number, name: string): { value: string; consumed: number } | undefined {
  const arg = args[index];
  if (arg === name) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new HostOptionsError(`${name} requires a value`);
    }
    return { value, consumed: 1 };
  }
  if (arg?.startsWith(`${name}=`)) {
    const value = arg.slice(name.length + 1);
    if (value.length === 0) throw new HostOptionsError(`${name}= requires a value`);
    return { value, consumed: 0 };
  }
  return undefined;
}

function parseCommandLine(args: string[]): ParsedCommandLine {
  const values: HostOptionValues = {};
  const positional: string[] = [];
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    const config = commandValue(args, index, '--config');
    if (config !== undefined) {
      configPath = config.value;
      index += config.consumed;
      continue;
    }
    const port = commandValue(args, index, '--port');
    if (port !== undefined) {
      values.port = parsePort(port.value, '--port');
      index += port.consumed;
      continue;
    }
    const name = commandValue(args, index, '--name');
    if (name !== undefined) {
      values.sessionName = parseSessionName(name.value, '--name');
      index += name.consumed;
      continue;
    }
    const sessionId = commandValue(args, index, '--session-id');
    if (sessionId !== undefined) {
      values.fixedSessionId = parseNonEmptyString(sessionId.value, '--session-id');
      index += sessionId.consumed;
      continue;
    }
    const resource = commandValue(args, index, '--resource');
    if (resource !== undefined) {
      values.resourceUrl = parseNonEmptyString(resource.value, '--resource');
      index += resource.consumed;
      continue;
    }
    const share = commandValue(args, index, '--share');
    if (share !== undefined) {
      values.sharePath = parseNonEmptyString(share.value, '--share');
      index += share.consumed;
      continue;
    }
    const mediaPort = commandValue(args, index, '--media-port');
    if (mediaPort !== undefined) {
      values.mediaPort = parsePort(mediaPort.value, '--media-port');
      index += mediaPort.consumed;
      continue;
    }
    if (arg === '--auto-accept') {
      values.autoAccept = true;
      continue;
    }
    if (arg === '--no-auto-accept') {
      values.autoAccept = false;
      continue;
    }
    if (arg.startsWith('-')) throw new HostOptionsError(`unknown option ${JSON.stringify(arg)}`);
    positional.push(arg);
  }

  if (positional.length > 2) {
    throw new HostOptionsError('expected at most two positional arguments: [port] [resource]');
  }
  if (positional[0] !== undefined) {
    if (values.port !== undefined) throw new HostOptionsError('port was provided both positionally and with --port');
    values.port = parsePort(positional[0], 'port');
  }
  if (positional[1] !== undefined) {
    if (values.resourceUrl !== undefined) {
      throw new HostOptionsError('resource was provided both positionally and with --resource');
    }
    values.resourceUrl = parseNonEmptyString(positional[1], 'resource');
  }

  return {
    values,
    ...(configPath === undefined ? {} : { configPath }),
  };
}

async function discoverConfig(cwd: string): Promise<string | undefined> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === CONFIG_EXTENSION)
    .map((entry) => resolve(cwd, entry.name))
    .sort();
  if (candidates.length > 1) {
    throw new HostOptionsError(`multiple .yml files found; select one with --config: ${candidates.join(', ')}`);
  }
  return candidates[0];
}

function readConfigValues(value: unknown, configPath: string): HostOptionValues {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostOptionsError(`${configPath} must contain a YAML mapping at the document root`);
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (CONFIG_KEYS[key] !== true) throw new HostOptionsError(`${configPath} contains unknown key ${JSON.stringify(key)}`);
  }

  const values: HostOptionValues = {};
  if (config.port !== undefined) values.port = parsePort(config.port, 'port');
  if (config.name !== undefined) values.sessionName = parseSessionName(config.name, 'name');
  if (config.sessionId !== undefined) values.fixedSessionId = parseNonEmptyString(config.sessionId, 'sessionId');
  if (config.autoAccept !== undefined) {
    if (typeof config.autoAccept !== 'boolean') throw new HostOptionsError('autoAccept must be a boolean');
    values.autoAccept = config.autoAccept;
  }
  if (config.resource !== undefined) values.resourceUrl = parseNonEmptyString(config.resource, 'resource');
  if (config.share !== undefined) {
    const share = parseNonEmptyString(config.share, 'share');
    values.sharePath = isAbsolute(share) ? share : resolve(dirname(configPath), share);
  }
  if (config.mediaPort !== undefined && config.mediaPort !== null) {
    values.mediaPort = parsePort(config.mediaPort, 'mediaPort');
  }
  return values;
}

async function loadConfig(configPath: string): Promise<HostOptionValues> {
  if (extname(configPath).toLowerCase() !== CONFIG_EXTENSION) {
    throw new HostOptionsError(`host config must use the ${CONFIG_EXTENSION} extension: ${configPath}`);
  }
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    throw new HostOptionsError(`cannot read host config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new HostOptionsError(`invalid YAML in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return readConfigValues(value ?? {}, configPath);
}

function validateResolved(values: HostOptionValues): void {
  if (values.mediaPort !== undefined && values.sharePath === undefined) {
    throw new HostOptionsError('mediaPort/--media-port requires share/--share');
  }
  if (values.sharePath !== undefined && values.resourceUrl !== undefined) {
    throw new HostOptionsError('share/--share cannot be combined with resource/--resource');
  }
}

export async function resolveHostOptions(
  args: string[],
  cwd = process.cwd(),
): Promise<ResolvedHostOptions> {
  const commandLine = parseCommandLine(args);
  const configPath = commandLine.configPath === undefined
    ? await discoverConfig(cwd)
    : resolve(cwd, commandLine.configPath);
  const configValues = configPath === undefined ? {} : await loadConfig(configPath);
  const values: HostOptionValues = {
    port: DEFAULT_PORT,
    autoAccept: false,
    ...configValues,
    ...commandLine.values,
  };
  validateResolved(values);

  return {
    port: values.port ?? DEFAULT_PORT,
    autoAccept: values.autoAccept ?? false,
    ...(values.sessionName === undefined ? {} : { sessionName: values.sessionName }),
    ...(values.fixedSessionId === undefined ? {} : { fixedSessionId: values.fixedSessionId }),
    ...(values.resourceUrl === undefined ? {} : { resourceUrl: values.resourceUrl }),
    ...(values.sharePath === undefined ? {} : { sharePath: values.sharePath }),
    ...(values.mediaPort === undefined ? {} : { mediaPort: values.mediaPort }),
    ...(configPath === undefined ? {} : { configPath }),
  };
}
