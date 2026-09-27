const valueOptions = new Map([
  ['--project-dir', 'project'], ['--revision', 'revision'], ['--wait', 'waitSeconds'],
]);
const booleanOptions = new Map([
  ['--no-pull', 'noPull'], ['--no-install', 'noInstall'],
  ['--status', 'status'], ['--verify', 'verify'],
  ['--accept-data-loss', 'acceptDataLoss'], ['--help', 'help'],
]);

export function parseArguments(operation, args) {
  if (!['deploy', 'upgrade', 'restore'].includes(operation) || !Array.isArray(args)) {
    throw new Error('Invalid deployment operation or arguments.');
  }
  const options = { operation, noPull: false, noInstall: false, waitSeconds: 120, acceptDataLoss: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    seen.add(argument);
    if (booleanOptions.has(argument)) {
      options[booleanOptions.get(argument)] = true;
    } else if (valueOptions.has(argument)) {
      const value = args[++index];
      if (typeof value !== 'string' || !value || value.startsWith('--') || /[\0\r\n]/.test(value)) {
        throw new Error(`Missing or invalid argument for ${argument}.`);
      }
      options[valueOptions.get(argument)] = value;
    } else {
      throw new Error(`Unknown deployment option: ${argument}`);
    }
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(options.waitSeconds))
    || !Number.isSafeInteger(Number(options.waitSeconds))) {
    throw new Error('Wait seconds must be a nonnegative safe integer.');
  }
  options.waitSeconds = Number(options.waitSeconds);
  if (options.revision !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.revision)) {
    throw new Error('Revision must be a full lowercase Git commit ID.');
  }
  if (options.revision && options.noPull) throw new Error('Conflicting revision and no-pull options.');
  if (operation !== 'restore' && options.acceptDataLoss) {
    throw new Error('The accept-data-loss option is only valid for restore.');
  }
  if (operation === 'restore' && [...seen].some(flag => ![
    '--project-dir', '--accept-data-loss', '--help',
  ].includes(flag))) {
    throw new Error('Unsupported restore option.');
  }
  if (options.status || options.verify) {
    const allowed = options.status
      ? ['--status', '--project-dir', '--help']
      : ['--verify', '--project-dir', '--wait', '--help'];
    if ([...seen].some(flag => !allowed.includes(flag))) {
      throw new Error('Conflicting status or verify options.');
    }
    options.operation = options.status ? 'status' : 'verify';
    delete options.status;
    delete options.verify;
    if (options.operation === 'verify' && options.waitSeconds === 0) {
      throw new Error('Verify requires a positive wait interval.');
    }
  }
  return options;
}

export function quoteArgument(value, platform) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
    throw new Error('Unsafe recovery command argument.');
  }
  if (platform === 'win32') return `'${value.replaceAll("'", "''")}'`;
  if (platform === 'linux') return `'${value.replaceAll("'", "'\\''")}'`;
  throw new Error('Unsupported recovery command platform.');
}
