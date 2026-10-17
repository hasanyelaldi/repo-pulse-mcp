// Prints a Markdown table of bench/results/*.json and writes bench/results.json,
// a trimmed copy (metrics and answers only, no session ids) that is committed.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const dir = new URL('./results/', import.meta.url);
const rows = readdirSync(dir)
  .filter((f) => /^[a-z]+-(shell|pulse)\.json$/.test(f))
  .sort()
  .map((f) => {
    const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    const u = j.usage;
    const [id, mode] = f.replace('.json', '').split('-');
    return {
      id,
      mode,
      model: Object.keys(j.modelUsage ?? {})[0] ?? null,
      ok: !j.is_error,
      turns: j.num_turns,
      inputTokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
      outputTokens: u.output_tokens,
      seconds: Math.round(j.duration_ms / 100) / 10,
      costUsd: Math.round(j.total_cost_usd * 1000) / 1000,
      deniedCommands: j.permission_denials?.length ?? 0,
      answer: j.result,
    };
  });

console.log('| Question | Mode | Turns | Input tokens | Output tokens | Time (s) | Cost (USD) |');
console.log('| -------- | ---- | ----: | -----------: | ------------: | -------: | ---------: |');
for (const r of rows) {
  console.log(
    `| ${r.id} | ${r.mode} | ${r.turns} | ${r.inputTokens.toLocaleString('en')} | ${r.outputTokens} | ${r.seconds} | ${r.costUsd.toFixed(3)} |`,
  );
}
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(rows, null, 2) + '\n');
