const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Parse the actual TOML and DOT string escaping, not a second handwritten job.
// This narrow offline harness models task error propagation checked against
// Chainlink 2.23.0. It is not a replacement for a Chainlink testnet canary.
function readJob() {
  const filename = path.join(__dirname, '../../../chainlink-node/basicJobSpec');
  const source = execFileSync('python3', ['-c',
    'import tomllib,sys; print(tomllib.load(open(sys.argv[1],"rb"))["observationSource"])', filename], { encoding: 'utf8' });
  const tasks = new Map();
  for (const match of source.matchAll(/\b(\w+)\s*\[((?:"(?:\\.|[^"\\])*"|[^\]"])*)\]/g)) {
    const attrs = Object.fromEntries([...match[2].matchAll(/(\w+)=("(?:\\.|[^"\\])*")/g)]
      .map(([, name, value]) => [name, JSON.parse(value)]));
    tasks.set(match[1], { ...attrs, parents: [] });
  }
  for (const chain of source.matchAll(/\b\w+(?:\s*->\s*\w+)+/g)) {
    const names = chain[0].split(/\s*->\s*/);
    for (let i = 1; i < names.length; i++) tasks.get(names[i]).parents.push(names[i - 1]);
  }
  return tasks;
}

// ethabidecode's abi as Chainlink 2.23.0 reads it (ParseETHABIArgsString, common_eth.go):
// split on commas, then on spaces, and the second word is the result's key, verbatim.
// go-ethereum's type regexp is not anchored, so "(bool" is still a bool: abi="(bool allowed)"
// decodes, under the key "allowed)", and $(task.allowed) is then a keypath that is not found.
// Measured on the binary: installer/tests/job-timeouts.integration.sh.
function decodeArgs(abi) {
  return abi.split(',').map(text => {
    const parts = text.replace(/\b(?:calldata|memory|storage)\b/g, ' ').trim().split(/ +/).filter(Boolean);
    const type = parts.length === 2 && /[a-zA-Z]+(?:[0-9]+(?:x[0-9]+)?)?/.exec(parts[0]);
    if (!type) throw new Error(`bad ABI specification: ${abi}`);
    return { type: type[0], name: parts[1] };
  });
}

async function runJob({ event, op, ethers, bridge = async () => {}, rpcFailure = false }) {
  const tasks = readJob(), results = new Map();
  const effects = { bridge: 0, transaction: 0 };
  const variable = expression => expression.slice(2, -1).split('.').reduce((value, key) => value?.[key], Object.fromEntries(results));
  const values = expression => JSON.parse(expression.replace(/\$\([^)]+\)/g, value => JSON.stringify(String(variable(value)))));
  while (results.size < tasks.size) {
    const ready = [...tasks].find(([name, task]) => !results.has(name) && task.parents.every(parent => results.has(parent)));
    if (!ready) throw new Error('Cyclic job or missing dependency');
    const [name, task] = ready;
    try {
      if (task.parents.some(parent => results.get(parent) instanceof Error)) throw new Error('task inputs');
      let value = true;
      switch (task.type) {
        case 'ethabidecodelog': value = event; break;
        case 'ethabiencode':
          if (name === 'authorize_data') {
            const iface = new ethers.Interface([`function ${task.abi} view returns (bool)`]);
            const input = values(task.data);
            value = iface.encodeFunctionData('isAuthorizedRequest', iface.fragments[0].inputs.map(arg => input[arg.name]));
          }
          break;
        case 'ethcall':
          if (rpcFailure) throw new Error('RPC unavailable');
          if (task.contract !== '{CONTRACT_ADDRESS}' || task.block !== 'latest') throw new Error('Unexpected gate target/state');
          value = await ethers.provider.call({ to: op.target, data: variable(task.data), gasLimit: BigInt(task.gas) });
          break;
        case 'ethabidecode': {
          const args = decodeArgs(task.abi);
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(args.map(arg => arg.type), variable(task.data));
          value = Object.fromEntries(args.map((arg, i) => [arg.name, decoded[i]]));
          break;
        }
        case 'conditional': {
          const input = variable(task.data);
          if (input === undefined) throw new Error('keypath not found');
          if (input !== true) throw new Error('conditional was not satisfied');
          break;
        }
        case 'bridge': effects.bridge++; await bridge(); break;
        case 'ethtx': effects.transaction++; break;
        case 'cborparse': case 'jsonparse': break; // mocked evidence/response; no network or paid providers
        default: throw new Error(`Unhandled task type: ${task.type}`);
      }
      results.set(name, value);
    } catch (error) { results.set(name, error); }
  }
  return effects;
}
module.exports = { readJob, runJob, decodeArgs };
