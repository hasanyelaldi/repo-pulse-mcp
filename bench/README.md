# Benchmark: Claude Code with a shell vs. with repo-pulse

The same four questions were asked to Claude Code in two configurations, on two well-known
open-source repositories:

- **shell**: only the `Bash` tool, limited to read-only `git` and text utilities (`sort`, `uniq`,
  `head`, `tail`, `awk`, `wc`, `grep`, `cut`). This mirrors a coding agent working directly in a
  repository.
- **pulse**: only the repo-pulse MCP server. No built-in tools, so no shell.

Everything else was identical: model `claude-sonnet-5-5`, Claude Code 2.1.302, project settings
only, no other MCP servers, and the question text word for word. Each cell is a **single run**
(n = 1), so treat small differences as noise.

| Repository                                                | Commit    | Commits |  Tags |
| --------------------------------------------------------- | --------- | ------: | ----: |
| [vitejs/vite](https://github.com/vitejs/vite)             | `df7503c` |   9,793 | 1,054 |
| [expressjs/express](https://github.com/expressjs/express) | `a419aa7` |   6,181 |   306 |

Run on 2026-10-17. The time windows in the questions ("last 90 days") are relative to that date.

## Questions

| Id         | Repo    | Question                                                                                                         |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `hotspots` | vite    | Which 10 files changed the most in the last 90 days, and roughly how many people worked on each?                 |
| `coupling` | vite    | Over the last 365 days, which files most often change in the same commits as `packages/vite/src/node/config.ts`? |
| `release`  | express | Draft release notes for the latest tag compared to the previous tag, grouped by type.                            |
| `stale`    | vite    | Which remote branches have had no commits for at least 90 days and are already merged into main?                 |

## Results

| Question | Mode  | Turns | Input tokens | Output tokens | Time (s) | Answer                                        |
| -------- | ----- | ----: | -----------: | ------------: | -------: | --------------------------------------------- |
| hotspots | shell |     2 |       10,232 |           585 |      6.6 | ✅ Correct                                    |
| hotspots | pulse |     2 |       15,993 |           525 |      6.5 | ✅ Correct, identical table                   |
| coupling | shell |     2 |       10,350 |           672 |      7.4 | ❌ Undercounted `config.spec.ts` (9 vs. 20)   |
| coupling | pulse |     2 |       15,747 |           608 |      8.6 | ✅ Correct, filters stated (see below)        |
| release  | shell |     3 |       19,904 |         1,454 |     14.0 | ✅ Good draft                                 |
| release  | pulse |     3 |       31,440 |         1,360 |     12.5 | ✅ Good draft, explains the 4.x/5.x tag lines |
| stale    | shell |     5 |       27,866 |         1,327 |     15.9 | ✅ Correct after 2 rejected commands          |
| stale    | pulse |     2 |       15,523 |           285 |      4.3 | ✅ Correct                                    |

Input tokens include cached tokens (system prompt and tool definitions). Raw metrics and the full
answers are in [`results.json`](results.json).

**Checking the coupling answers.** Counted directly with `git log --no-merges` over the same
window, `config.ts` changed in 70 commits, 20 of which also touched `config.spec.ts` and 22 also
touched `build.ts`. repo-pulse reported 17 and 18. It skips 27 bulk commits that touch more than
30 files, which is its documented default, and it said so in its answer. The shell run reported 9
shared commits for `config.spec.ts`, less than half the real number. It ranked the file in a
tie at 3rd–5th place instead of 2nd and did not mention any caveat.

## What this shows, honestly

- **Fewer tokens is _not_ the selling point.** For a single aggregation, a strong model writes a
  compact `git log | sort | uniq -c` pipeline whose output is tiny. repo-pulse adds a fixed cost
  of about 2.5k tokens per session for its tool definitions, and some results are larger than
  necessary. The biggest example is `release_notes_draft`, which returns both structured sections
  and a Markdown draft, so 76 commits reach the model twice. This is a known optimization target.
- **Fewer steps on multi-step questions.** For `stale`, the shell run needed 5 turns, including
  two commands that were rejected for writing a temp file, and took 3.7× longer. repo-pulse
  answered in one round of calls.
- **Correct counting.** Hand-written pipelines can be silently wrong. The shell run got the
  coupling numbers wrong without noticing. repo-pulse computes them in tested code and reports its
  filters, such as skipped bulk commits and excluded merges.
- **No shell needed.** Every pulse run used no built-in tools at all, which is the situation in
  chat clients such as Claude Desktop. There the shell column is not an option.

The benchmark also found a real gap. In the first round, repo-pulse 0.2.0 had no way to list tags,
so the `release` question failed in pulse mode. The `list_tags` tool was added in response, and
the table above was produced with it.

## Reproduce

Requires Claude Code (`claude`) and a build of this repository (`npm run build`). The runs use
your Claude Code account.

```bash
mkdir -p bench/repos
git clone https://github.com/vitejs/vite.git bench/repos/vite
git clone https://github.com/expressjs/express.git bench/repos/express
git -C bench/repos/vite checkout df7503c
git -C bench/repos/express checkout a419aa7

while IFS=$'\t' read -r id repo question; do
  for mode in shell pulse; do bench/run.sh "$id" "$repo" "$mode" "$question"; done
done < bench/questions.tsv

node bench/summarize.mjs
```

Because the questions use relative time windows, numbers will drift when you run them on a
later date.

## Demo GIFs

Both GIFs are rendered from real runs in pulse mode on vite. The runs used
`--output-format stream-json --verbose`, and [`to-cast.mjs`](to-cast.mjs) converted the
transcript to an asciicast, which [agg](https://github.com/asciinema/agg) turned into a GIF. Only
typing speed and colours are added. The tool calls, their arguments, the answer and the footer
come from the transcript.

- [`docs/demo-review.gif`](../docs/demo-review.gif): `review_context` on the vite branch
  `fix/chunk-import-map-preload-hashing` against `origin/main` at `df7503cc4`, recorded on
  2026-10-17 with v0.4.0 plus the author identity fix. Rendered with
  `agg --font-size 14 --theme monokai`.
- [`docs/demo.gif`](../docs/demo.gif): unreleased changes and stale branches, recorded with v0.3.0.

To record a new one, run the question like `run.sh` does in pulse mode, but with
`--output-format stream-json --verbose` and the output redirected to a `.jsonl` file, then:

```bash
DEMO_LABEL="vitejs/vite @ <commit> · Claude Code + repo-pulse (no shell)" \
  node bench/to-cast.mjs transcript.jsonl "<question>" demo.cast
agg --font-size 14 --theme monokai demo.cast docs/demo-review.gif
```
