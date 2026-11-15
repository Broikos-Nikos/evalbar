# Publishing evalbar

Everything the repository needs on GitHub, written before it exists. The owner said yes on
2026-11-15: "can we build a demo on broikos and upload on github like the rest?"

## The About box

**Description**, 350 characters or fewer, carrying the number:

> An LLM evaluation command line you point at your own cases: a pass rate with its exact interval, a
> verdict against your bar, and a refusal when the sample cannot tell. Given semcache's published
> 3 wrong answers against 0 in 2,000, it says the sample cannot tell, and that about 5,231 would.
> TypeScript, no runtime dependencies.

**Homepage**: https://broikos-nikos.github.io/evalbar/, the live page. It runs evalbar's own code in
the browser: `evalbar report` and `evalbar compare` on numbers a visitor types, the exact grader on
Greek pairs, the importer's scrubber on a log line.

**Topics**, ten:

```
llm  evals  llm-evaluation  llm-as-a-judge  statistics  confidence-intervals  cli  typescript  greek  testing
```

`evals` and `llm-evaluation` are the two a stranger with a model in production searches;
`llm-as-a-judge` and `confidence-intervals` are what separates this from the other runners.

## Settings

- **Public.** Issues on, so a stranger's first issue can arrive; wiki, projects and discussions off.
- **Pages from GitHub Actions.** `.github/workflows/pages.yml` runs the command's gates, builds the
  page, drives it in a browser, and deploys only when all of that passes.
- **No default community files.** The MIT LICENSE is committed and `check:licence` holds the README
  to it.

## The order

1. Create the repository with the description, the homepage and the topics above.
2. Push `main` with its whole history, every commit authored `Nikos Broikos
   <broikos.nikolaos@gmail.com>`, none co-authored (`check:source` holds both).
3. Set Pages to build from GitHub Actions, and watch the run to green.
4. Open the live page in a real browser at 1280 and at 390, console quiet, nothing wider than the
   window. Only then does a second push say in the README that the page is live.
5. Run `bash tools/five-minutes.sh https://github.com/Broikos-Nikos/evalbar`, which times a clone
   from GitHub, the one the README's first command makes, and commit its output with that push. If
   the time moves, the README's sentence moves with it: `check:claims` fails until it does.
6. For the card on broikos.gr/github-projects, the still: `node tools/capture.ts --still
   evalbar-still.jpg --url https://broikos-nikos.github.io/evalbar/` in `page/`, the live page at
   1920 by 1080 at load, and the handover beside it, in the siblings' shape.

## Not before the owner's word

- No npm publish. `package.json` keeps `"private": true` until then; the name was free on
  registry.npmjs.org at tick 1 (B1).
- No post on any social platform, ever, from this workspace.
