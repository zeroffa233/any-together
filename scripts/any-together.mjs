#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'any-together.config.json');
const EXTENSION_SOURCE = join(ROOT, 'extension');
const EXTENSION_DIR = join(ROOT, '.any-together', 'extension');
const DEFAULTS = {
  extension: {
    browser: 'auto',
    profileDir: '.any-together/browser-profile',
  },
};

function printHelp() {
  console.log(`AnyTogether 外围工具\n\n用法:\n  npm run setup                         一键准备环境、配置和扩展\n  npm run doctor                        检查环境与项目状态\n  npm run config                        创建或检查本地工具配置\n  npm run start                         启动 host（自动读取当前目录唯一的 .yml）\n  npm run extension:prepare             准备浏览器扩展目录\n  npm run extension:install             准备扩展并启动独立浏览器配置\n\n常用参数:\n  --config <path>                       使用指定 JSON 工具配置\n  --host-config <path>                  启动时使用指定 .yml 运行配置\n  --browser <auto|chrome|chromium|brave|path>\n                                        指定扩展安装时使用的浏览器\n  --dry-run                             只打印扩展安装动作，不启动浏览器\n\n启动覆盖参数（优先于 .yml）:\n  npm run start -- --port 9000\n  npm run start -- --resource https://www.bilibili.com/video/BV...\n  npm run start -- --share /absolute/path/movie.mp4\n`);
}

function fail(message) {
  console.error(`any-together: ${message}`);
  process.exitCode = 1;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function commandPath(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\r?\n/)[0] || null;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置不是有效 JSON：${filePath}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function mergeConfig(value) {
  const extension = value?.extension && typeof value.extension === 'object' ? value.extension : {};
  return {
    extension: { ...DEFAULTS.extension, ...extension },
  };
}

async function loadConfig(configPath = CONFIG_PATH) {
  if (!existsSync(configPath)) return { path: configPath, exists: false, value: mergeConfig({}) };
  return { path: configPath, exists: true, value: mergeConfig(await readJson(configPath)) };
}

function configText() {
  return `${JSON.stringify({
    $schema: './config/any-together.config.schema.json',
    ...DEFAULTS,
  }, null, 2)}\n`;
}

async function ensureConfig(configPath = CONFIG_PATH) {
  if (existsSync(configPath)) return false;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, configText(), 'utf8');
  return true;
}

function validateConfig(config) {
  const extension = config.extension;
  for (const [name, value] of Object.entries({
    'extension.browser': extension.browser,
    'extension.profileDir': extension.profileDir,
  })) {
    if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
  }
}

function resolveFromRoot(value) {
  return isAbsolute(value) ? value : resolve(ROOT, value);
}

async function prepareExtension() {
  if (!existsSync(EXTENSION_SOURCE)) throw new Error('找不到 extension/ 目录');
  await mkdir(dirname(EXTENSION_DIR), { recursive: true });
  await cp(EXTENSION_SOURCE, EXTENSION_DIR, { recursive: true, force: true });
  return EXTENSION_DIR;
}

function browserCandidates(preference) {
  if (preference && preference !== 'auto') {
    const aliases = {
      chrome: ['google-chrome', 'google-chrome-stable'],
      chromium: ['chromium', 'chromium-browser'],
      brave: ['brave-browser'],
    };
    return aliases[preference] ?? [preference];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
    return roots.flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Chromium', 'Application', 'chrome.exe'),
      join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ]);
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser'];
}

function findBrowser(preference) {
  for (const candidate of browserCandidates(preference)) {
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
    const resolved = commandPath(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function browserInstallCommand(browser, profileDir) {
  return [
    browser,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

async function installExtension(config, browserOverride, dryRun) {
  const extensionDir = await prepareExtension();
  const browserName = browserOverride ?? config.extension.browser;
  const browser = findBrowser(browserName);
  const profileDir = resolveFromRoot(config.extension.profileDir);
  const command = browser ? browserInstallCommand(browser, profileDir) : null;

  console.log(`any-together: 扩展已准备到 ${extensionDir}`);
  console.log(`any-together: 独立浏览器配置目录 ${profileDir}`);
  if (!browser || !command) {
    console.log('any-together: 未检测到 Chrome / Chromium / Brave。');
    console.log(`any-together: 手动安装：打开浏览器扩展管理页，开启“开发者模式”，加载 ${extensionDir}`);
    return false;
  }
  console.log(`any-together: 浏览器 ${browser}`);
  if (dryRun) {
    console.log(`any-together: dry-run：${command.map((item) => JSON.stringify(item)).join(' ')}`);
    return true;
  }
  await mkdir(profileDir, { recursive: true });
  const child = spawn(browser, command.slice(1), { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  console.log('any-together: 已启动独立浏览器配置，扩展会自动加载。');
  return true;
}

function hostArgs(overrides) {
  const args = [];
  if (Object.hasOwn(overrides, 'port')) args.push('--port', String(overrides.port));
  if (Object.hasOwn(overrides, 'resourceUrl')) args.push('--resource', overrides.resourceUrl);
  if (Object.hasOwn(overrides, 'sessionId')) args.push('--session-id', overrides.sessionId);
  if (Object.hasOwn(overrides, 'autoAccept')) {
    args.push(overrides.autoAccept ? '--auto-accept' : '--no-auto-accept');
  }
  if (Object.hasOwn(overrides, 'share')) args.push('--share', resolveFromRoot(overrides.share));
  if (Object.hasOwn(overrides, 'mediaPort')) args.push('--media-port', String(overrides.mediaPort));
  return args;
}

function parseArgs(args) {
  const options = { configPath: CONFIG_PATH, hostConfigPath: undefined, browser: undefined, dryRun: false, overrides: {}, passthrough: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      options.passthrough.push(...args.slice(index + 1));
      break;
    }
    const next = args[index + 1];
    const valueOf = (name) => arg === name ? next : arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
    const configPath = valueOf('--config');
    if (configPath !== undefined) { options.configPath = resolveFromRoot(configPath); index += arg === '--config' ? 1 : 0; continue; }
    const hostConfigPath = valueOf('--host-config');
    if (hostConfigPath !== undefined) { options.hostConfigPath = resolveFromRoot(hostConfigPath); index += arg === '--host-config' ? 1 : 0; continue; }
    const browser = valueOf('--browser');
    if (browser !== undefined) { options.browser = browser; index += arg === '--browser' ? 1 : 0; continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    const port = valueOf('--port');
    if (port !== undefined) { options.overrides.port = Number(port); index += arg === '--port' ? 1 : 0; continue; }
    const resourceUrl = valueOf('--resource');
    if (resourceUrl !== undefined) { options.overrides.resourceUrl = resourceUrl; index += arg === '--resource' ? 1 : 0; continue; }
    const share = valueOf('--share');
    if (share !== undefined) { options.overrides.share = share; index += arg === '--share' ? 1 : 0; continue; }
    const mediaPort = valueOf('--media-port');
    if (mediaPort !== undefined) { options.overrides.mediaPort = Number(mediaPort); index += arg === '--media-port' ? 1 : 0; continue; }
    if (arg === '--auto-accept') { options.overrides.autoAccept = true; continue; }
    if (arg === '--no-auto-accept') { options.overrides.autoAccept = false; continue; }
    const sessionId = valueOf('--session-id');
    if (sessionId !== undefined) { options.overrides.sessionId = sessionId; index += arg === '--session-id' ? 1 : 0; continue; }
    options.passthrough.push(arg);
  }
  return options;
}

async function commandSetup(options) {
  const created = await ensureConfig(options.configPath);
  if (created) console.log(`any-together: 已创建 ${options.configPath}`);
  const config = await loadConfig(options.configPath);
  validateConfig(config.value);
  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.log('any-together: 正在安装 npm 依赖…');
    const status = run(npmCommand(), ['install']);
    if (status !== 0) throw new Error('npm install 失败');
  } else {
    console.log('any-together: 检测到 node_modules，跳过依赖安装');
  }
  const buildStatus = run(npmCommand(), ['run', 'build']);
  if (buildStatus !== 0) throw new Error('项目构建失败');
  await prepareExtension();
  console.log('any-together: setup 完成。下一步：npm run start 或 npm run extension:install');
}

async function commandDoctor(options) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push([nodeMajor >= 22, `Node.js ${process.versions.node}（要求 >= 22）`]);
  checks.push([existsSync(join(ROOT, 'package-lock.json')), 'package-lock.json']);
  checks.push([existsSync(join(ROOT, 'node_modules')), 'node_modules']);
  checks.push([existsSync(join(ROOT, 'extension', 'manifest.json')), 'extension/manifest.json']);
  checks.push([existsSync(join(ROOT, 'extension', 'background.js')), 'extension/background.js']);
  const config = await loadConfig(options.configPath);
  try {
    validateConfig(config.value);
    checks.push([true, config.exists ? `配置有效：${config.path}` : '尚未创建本地配置（可运行 npm run config）']);
  } catch (error) {
    checks.push([false, error instanceof Error ? error.message : String(error)]);
  }
  for (const [ok, label] of checks) console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (checks.some(([ok]) => !ok)) process.exitCode = 1;
}

async function main() {
  const command = process.argv[2] ?? 'help';
  const options = parseArgs(process.argv.slice(3));
  if (command === 'help' || command === '--help' || command === '-h') return printHelp();
  try {
    if (command === 'config') {
      const created = await ensureConfig(options.configPath);
      console.log(created ? `any-together: 已创建 ${options.configPath}` : `any-together: 配置已存在 ${options.configPath}`);
      const config = await loadConfig(options.configPath);
      validateConfig(config.value);
      console.log('any-together: 配置有效');
      return;
    }
    if (command === 'setup') return await commandSetup(options);
    if (command === 'doctor') return await commandDoctor(options);
    if (command === 'extension:prepare') {
      console.log(`any-together: 扩展已准备到 ${await prepareExtension()}`);
      return;
    }
    if (command === 'extension:install') {
      const config = await loadConfig(options.configPath);
      validateConfig(config.value);
      await installExtension(config.value, options.browser, options.dryRun);
      return;
    }
    if (command === 'start') {
      const config = await loadConfig(options.configPath);
      validateConfig(config.value);
      const args = [
        ...hostArgs(options.overrides),
        ...(options.hostConfigPath === undefined ? [] : ['--config', options.hostConfigPath]),
        ...options.passthrough,
      ];
      const status = run(npmCommand(), ['run', 'start:host', '--', ...args]);
      process.exitCode = status;
      return;
    }
    throw new Error(`未知命令：${command}（运行 npm run setup 或 node scripts/any-together.mjs help 查看帮助）`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

await main();
