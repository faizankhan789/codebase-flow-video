# Analysis guide: mapping a codebase end to end

Goal: a `FLOW.md` that explains every step of every pipeline in the repo, including every branch and alternative path, with each claim traceable to `file:line`. The video is built from this file, so the video can only be as accurate as `FLOW.md`.

## 1. Recon (cheap, read little)

Read these, in order, and stop reading once the picture is clear:

1. `README*`, `docs/` index, `ARCHITECTURE*`, `CLAUDE.md` / `AGENTS.md`
2. Manifests: `package.json`, `pyproject.toml` / `requirements*.txt`, `go.mod`, `Cargo.toml`, `pom.xml` / `build.gradle`, `Gemfile`, `composer.json`
3. Runtime wiring: `Dockerfile`, `docker-compose*`, `Procfile`, k8s / serverless / terraform files, CI workflows
4. The directory tree (`git ls-files | head -300` or `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`)

From this, list the **entry points**: anything that starts work.

| Look for | Examples |
|---|---|
| Process start | `main()`, `if __name__ == "__main__"`, `bin/` scripts, `"start"` / `"bin"` in package.json, `cmd/*/main.go` |
| HTTP / RPC | route tables, controllers, `@app.route`, `router.get`, `@GetMapping`, GraphQL resolvers, gRPC services |
| Background | queue consumers, cron / schedulers, Celery / Sidekiq / BullMQ workers, Lambda handlers, webhooks |
| UI | top-level pages / screens that trigger backend calls |
| CLI | argparse / click / commander / cobra command definitions |
| Data | ETL / DAG definitions (Airflow, Dagster, Prefect), notebooks run on a schedule |

## 2. Pick the pipelines

A **pipeline** is one entry point followed through to its final effect (a response, a DB write, a file, a message, a payment). Rank them by importance to the product, judged from the README, how much code they touch and what the user said. Trace them all for `FLOW.md`; the storyboard later picks which ones to show.

## 3. Trace each pipeline

Follow the calls from the entry point forward. At each meaningful step, record:

- **What it does**: one technical line, plus one plain-language line a CEO would understand.
- **In and out**: the data that arrives and the data that leaves.
- **Where**: `path/to/file.ext:line` of the function that does the work.
- **External systems** touched: DB tables, caches, queues, third-party APIs, LLMs, storage buckets, email/SMS.
- **Branches**: every place the flow can go more than one way. These are the "multiple options" and they must all be captured:
  - `if` / `switch` / pattern matches that change *where data goes* (not trivial guards)
  - validation failures and error handlers, `try`/`catch` paths that change the outcome
  - retries, backoff, dead-letter queues, circuit breakers, fallbacks
  - feature flags, env/config modes (`if settings.PROVIDER == "openai"`), A/B paths
  - strategy / plugin / adapter selection (several implementations behind one interface)
  - auth / permission outcomes (allowed, denied, needs 2FA)
  - async splits: fire-and-forget jobs, fan-out / fan-in, webhooks that come back later

Skip: logging, metrics, pure formatting helpers, trivial getters. They are not steps.

A "meaningful step" changes the data, makes a decision, or crosses a boundary (process, network, storage, person). Merge consecutive helpers that do one job into one step.

## 4. Scale with subagents

- Under ~50 source files, or a single pipeline: trace inline.
- Larger: dispatch one subagent per pipeline (or per top-level module), in parallel, in a single message. Give each one: the entry point, the record format from step 3, and an instruction to return only the structured trace (no file dumps). Then merge, deduplicating shared steps (for example, two pipelines that write through the same repository class).

Each file should be read once overall. Prefer `grep` for call sites over reading whole files.

## 5. Verify

Before writing `FLOW.md`, re-check every branch and every external system against the code. If a claim cannot be confirmed (dynamic dispatch, reflection, config loaded at runtime), keep it but mark it `(unverified: reason)`. Never invent a step to make the story smoother.

## 6. Write `FLOW.md`

Use this shape:

```markdown
# <Project>: end-to-end flow

## Overview
What the system is for, who uses it, the main actors and external systems. 3-6 sentences.

## Pipelines
### 1. <Name> (entry: `src/api/upload.ts:42` POST /invoices)
1. **Receive invoice**: `src/api/upload.ts:42`
   - Does: validates multipart upload, stores temp file
   - Plain: the supplier's invoice arrives
   - In: multipart PDF. Out: `fileId`
   - Branch: size > 10 MB, goes to chunked upload (1a)
   - Branch: not a PDF, returns 415 and stops
2. ...

### 2. <Name> ...

## Branch index
| # | Where | Condition | Outcomes |
|---|---|---|---|
| B1 | `src/api/upload.ts:57` | file > 10 MB | chunked upload / direct |

## External systems
| System | Used for | Where |

## Glossary
| Term in code | Plain meaning |
```

`FLOW.md` is for engineers and is a deliverable in its own right. It may contain file paths and technical names; the storyboard may not.
