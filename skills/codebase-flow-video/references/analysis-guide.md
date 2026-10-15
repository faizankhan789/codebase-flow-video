# Analysis guide: mapping a codebase end to end

Goal: a `FLOW.md` that explains every step of every pipeline in the repo, including every branch and alternative path, with each claim traceable to `file:line` **and the exact code at that line**. The video is built from this file, so the video can only be as accurate as `FLOW.md`. Two things make it accurate: evidence that a script can check (precision) and inventories that show nothing was missed (recall).

## 1. Recon (cheap, read little)

Record the revision first: `git rev-parse --short HEAD`. It goes at the top of `FLOW.md` as `Commit: \`<sha>\`` so the line numbers stay meaningful later.

Read these, in order, and stop reading once the picture is clear:

1. `README*`, `docs/` index, `ARCHITECTURE*`, `CLAUDE.md` / `AGENTS.md`
2. Manifests: `package.json`, `pyproject.toml` / `requirements*.txt`, `go.mod`, `Cargo.toml`, `pom.xml` / `build.gradle`, `Gemfile`, `composer.json`
3. Runtime wiring: `Dockerfile`, `docker-compose*`, `Procfile`, k8s / serverless / terraform files, CI workflows
4. The directory tree (`git ls-files | head -300` or `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`)

READMEs and docs describe intent and go stale. Use them to find entry points, never as evidence for a step.

## 2. Inventory entry points (recall)

Don't rely on spotting entry points while reading. Grep for them, then classify **every** hit as traced or out of scope (with a reason). Adapt the patterns to the stack; run only the ones that apply. The commands use POSIX regex only (no `\b`, `\s`), so they work with any git build; `--untracked` includes new files not yet committed:

```bash
# HTTP / RPC routes
git grep -n --untracked -E '@(app|router|bp|api)\.(get|post|put|patch|delete|route)|router\.(get|post|put|patch|delete|use)\(|@(Get|Post|Put|Patch|Delete|Request)Mapping|(HandleFunc|Handle)\(|re_path\(|path\(' -- ':!*test*'
# Process start and CLIs
git grep -n --untracked -E "if __name__ == .__main__.|func main\(\)|commander|click\.(command|group)|argparse\.ArgumentParser|cobra\.Command" -- ':!*test*'
# Background work: queues, cron, serverless, webhooks
git grep -n --untracked -E 'cron|schedule|@(celery|shared_task|app\.task)|Sidekiq|BullMQ|new Worker\(|consumer|subscribe\(|lambda_handler|webhook' -- ':!*test*'
# Data pipelines
git grep -n --untracked -E '@(dag|task|asset|flow)|DAG\(' -- ':!*test*'
```

Also check `"bin"` / `"scripts"` in `package.json`, `[project.scripts]` in `pyproject.toml`, `cmd/*/main.go`, `Procfile` and CI deploy targets.

## 3. Pick the pipelines

A **pipeline** is one entry point followed through to its final effect (a response, a DB write, a file, a message, a payment). Rank them by importance to the product, judged from how much code they touch, the README and what the user said. Trace them all for `FLOW.md`; the storyboard later picks which ones to show.

## 4. Trace each pipeline

Follow the calls from the entry point forward. Give each step an id `P<pipeline>.<step>` (sub-steps `P1.3a`). At each meaningful step, record:

- **Evidence**: `` `path/to/file.ext:line` `exact code from that line` ``. Copy the code from the file; never retype it from memory. Use `:42-58` for a range. The quote must be the distinctive part of the line (8+ characters), e.g. `` `if (amount > LIMIT)` ``, not `` `if` ``. The `path:line` form in backticks is reserved for code references; write hostnames and ports without backticks. If the code itself contains backticks (template literals), wrap the quote in double backticks: ``` ``const url = `${base}/pay` `` ```.
- **What it does**: one technical line, plus one plain-language line a CEO would understand.
- **In and out**: the data that arrives and the data that leaves.
- **External systems** touched: DB tables, caches, queues, third-party APIs, LLMs, storage buckets, email/SMS.
- **Branches**: every place the flow can go more than one way. Give each an id `B<n>` and mention it in the step as `Branch B<n>: ...`. These are the "multiple options" and they must all be captured:
  - `if` / `switch` / pattern matches that change *where data goes* (not trivial guards)
  - validation failures and error handlers, `try`/`catch` paths that change the outcome
  - retries, backoff, dead-letter queues, circuit breakers, fallbacks
  - feature flags, env/config modes (`if settings.PROVIDER == "openai"`), A/B paths
  - strategy / plugin / adapter selection (several implementations behind one interface)
  - auth / permission outcomes (allowed, denied, needs 2FA)
  - async splits: fire-and-forget jobs, fan-out / fan-in, webhooks that come back later

Skip: logging, metrics, pure formatting helpers, trivial getters. They are not steps.

A "meaningful step" changes the data, makes a decision, or crosses a boundary (process, network, storage, person). Merge consecutive helpers that do one job into one step.

**Show actual behaviour, not intended behaviour.** If the code does something odd (a branch that can never fire, an error that is swallowed, a check after the side effect it should guard), record what the code does and add it to a `## Suspected bugs` list. The report tells the user; the video does not paper over it.

**Resolve indirection before giving up:**

- Dependency injection, plugins, strategy maps, `getattr` / reflection: grep for where implementations are registered or bound (`register(`, `bind(`, `provide`, `container.`, a dict of handlers, entry-points in the manifest) and list only the ones actually wired up.
- Config-driven branches: find the default value and where production sets it (`.env.example`, settings files, helm values, terraform). Note `default: <value>` on the branch so the video does not present an off-by-default path as the normal one.
- Only after that, mark what remains `(unverified: reason)`.

**Use tests as evidence.** Test names and assertions say which branches are intended (`it('rejects orders over the credit limit')`). Cite them next to the step when they confirm a branch, and note branches that have no test.

## 5. Inventory branches, config and external systems (recall)

For the files your traces touched, list every branch site and reconcile. List the files inline (a `$FILES` variable does not split into separate paths in zsh):

```bash
# every file cited in your traces after the --
git grep -n --untracked -w -E 'if|elif|else if|switch|case|match|when|unless|catch|except|rescue|guard' -- src/orders.js src/payments.js
git grep -n --untracked -E 'process\.env|os\.environ|getenv|os\.Getenv|ENV\[|settings\.|config\.|feature_?flag|isEnabled\(' -- src/orders.js src/payments.js
```

Each branch hit is either in the branch index or counts as a trivial guard (null check, logging, formatting). Each config read that changes the flow becomes a branch with its default. Then check external systems across the repo, so the External systems table is complete:

```bash
git grep -n --untracked -E "^(import|from)[[:space:]].*(requests|httpx|axios|fetch|boto3|@aws-sdk|stripe|openai|anthropic|redis|pg|psycopg|mongoose|prisma|sqlalchemy|kafka|amqp|nodemailer|twilio|sendgrid)|require\(['\"](axios|stripe|redis|pg|aws-sdk)" -- ':!*test*'
```

Record the counts in the `## Coverage` section (template below). A big gap between "found" and "traced or classified" means something was missed.

## 6. Scale with subagents

- Under ~50 source files, or a single pipeline: trace inline.
- Larger: dispatch one subagent per pipeline (or per top-level module), in parallel, in a single message. Give each one: the entry point, the record format from step 4 (including the evidence rule: exact quotes copied from the file), the id prefix to use (`P3.*`, branches `B30`-`B39`) so ids do not collide, and an instruction to return only the structured trace (no file dumps). Then merge, deduplicating shared steps (for example, two pipelines that write through the same repository class).

Each file should be read once overall. Prefer `grep` for call sites over reading whole files.

## 7. Verify

Two passes, both required. Details in `references/verification-guide.md`.

1. **Mechanical:** `node <skill-dir>/renderer/verify-flow.mjs flow-video/FLOW.md`. It checks that every cited file exists, every line is in range, every quote sits at its cited line, every step and branch has evidence, every `Branch B<n>` mention is in the index, and the commit pin matches. Fix every `ERROR`. A quote "found at line N" usually means the line number drifted; a quote "not found anywhere" means the claim was invented or misremembered: re-read the code.
2. **Independent:** a fresh subagent that did not write `FLOW.md` re-checks each claim's *meaning* against the code. Fix every claim it marks WRONG.

If a claim cannot be confirmed (dynamic dispatch, reflection, config loaded at runtime), keep it but mark it `(unverified: reason)`. Never invent a step to make the story smoother.

## 8. Write `FLOW.md`

Use this shape:

```markdown
# <Project>: end-to-end flow

Commit: `<git rev-parse --short HEAD>`

## Overview
What the system is for, who uses it, the main actors and external systems. 3-6 sentences.

## Pipelines
### 1. <Name> (entry: `src/api/upload.ts:42` `router.post('/invoices', upload)`)
1. **P1.1 Receive invoice**: `src/api/upload.ts:42` `router.post('/invoices', upload)`
   - Does: validates multipart upload, stores temp file
   - Plain: the supplier's invoice arrives
   - In: multipart PDF. Out: `fileId`
   - Branch B1: size > 10 MB, goes to chunked upload (P1.1a)
   - Branch B2: not a PDF, returns 415 and stops
   - Tests: `test/upload.test.ts:30` `it('rejects non-PDF files')`
2. ...

### 2. <Name> ...

## Branch index
| # | Where (exact code) | Condition | Outcomes |
|---|---|---|---|
| B1 | `src/api/upload.ts:57` `if (file.size > MAX_DIRECT_BYTES)` | file > 10 MB | chunked upload / direct |

## External systems
| System | Used for | Where |

## Coverage
| Inventory | Found | Traced | Out of scope (why) |
|---|---|---|---|
| Entry points | 7 | 3 | 4: health check, two one-off scripts, admin CLI |
| Branch sites in traced files | 41 | 9 in branch index | 32 trivial guards |
| Config reads that change flow | 3 | 3 | defaults noted on B4, B7, B8 |
| External clients | 5 | 5 | none |

## Suspected bugs
- `src/pay.ts:88` `catch (e) {}` swallows declined payments; the order is still marked paid.

## Glossary
| Term in code | Plain meaning |
```

`FLOW.md` is for engineers and is a deliverable in its own right. It may contain file paths and technical names; the storyboard may not. Write ids exactly as `**P1.2 Title**` (step list items) and `| B3 |` (branch rows): the verifier and the storyboard checker parse them.
