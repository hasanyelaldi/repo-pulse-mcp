// Turns a real `claude -p --output-format stream-json --verbose` transcript into an
// asciicast v2 recording. Only timing and colours are added; every tool call,
// argument and answer line comes from the transcript.
// Usage: node to-cast.mjs <transcript.jsonl> <question> <out.cast>
import { readFileSync, writeFileSync } from 'node:fs';

const [file, question, out] = process.argv.slice(2);
const events = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const COLS = 112;
const ROWS = 38;
const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const frames = [];
let t = 0;
const emit = (s, delay = 0) => {
  t += delay;
  frames.push([Number(t.toFixed(3)), 'o', s]);
};

emit(c('2', process.env.DEMO_LABEL ?? '') + '\r\n', 0.3);
emit(c('1;35', '❯ '), 0.2);
for (const ch of question) emit(ch, 0.028);
emit('\r\n\r\n', 0.5);

const fmtArgs = (input) =>
  Object.entries(input ?? {})
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ');

// Print each tool call together with its own result, in the order results arrive.
let answer = '';
let summary = '';
const calls = new Map();
for (const ev of events) {
  if (ev.type === 'assistant') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'tool_use') calls.set(block.id, block);
    }
  } else if (ev.type === 'user') {
    for (const block of ev.message?.content ?? []) {
      if (block.type !== 'tool_result') continue;
      const call = calls.get(block.tool_use_id);
      const name = (call?.name ?? '?').replace(/^mcp__repo-pulse__/, '');
      const text = Array.isArray(block.content)
        ? block.content.map((p) => p.text ?? '').join('')
        : String(block.content ?? '');
      const kb = (Buffer.byteLength(text) / 1024).toFixed(1);
      emit(
        `${c('1;32', '●')} ${c('1', `repo-pulse · ${name}`)}${c('2', `(${fmtArgs(call?.input)})`)}\r\n`,
        0.6,
      );
      emit(
        c('2', `  └ ${block.is_error ? 'error' : 'structured result'} · ${kb} KB JSON`) + '\r\n',
        0.7,
      );
    }
  } else if (ev.type === 'result') {
    answer = ev.result ?? '';
    const model = Object.keys(ev.modelUsage ?? {})[0] ?? '';
    summary = `✓ ${calls.size} tool calls · ${(ev.duration_ms / 1000).toFixed(1)}s · ${model}`;
  }
}

emit('\r\n', 0.4);
for (const line of answer.split('\n')) {
  const styled = line
    .replace(/\*\*(.+?)\*\*/g, (_, s) => c('1', s))
    .replace(/`([^`]+)`/g, (_, s) => c('36', s));
  emit(`${styled}\r\n`, line.startsWith('|') ? 0.07 : 0.18);
}
emit('\r\n' + c('2', summary) + '\r\n', 0.6);
emit('', 4);

const header = {
  version: 2,
  width: COLS,
  height: ROWS,
  timestamp: 0,
  env: { TERM: 'xterm-256color' },
};
writeFileSync(
  out,
  [JSON.stringify(header), ...frames.map((f) => JSON.stringify(f))].join('\n') + '\n',
);
console.log(`wrote ${out}: ${frames.length} frames, ${t.toFixed(1)}s`);
