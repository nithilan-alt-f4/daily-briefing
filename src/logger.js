const RING_SIZE = 500;
const ring = [];

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

function push(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ')}`;
  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();
}

console.log = (...args) => { push('info', args); originalLog(...args); };
console.error = (...args) => { push('error', args); originalError(...args); };

export function getLogs(n = 200) {
  return ring.slice(-n);
}
