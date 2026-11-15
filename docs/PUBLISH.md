# Publishing evalbar

Everything the repository needs on GitHub, written before it exists. Nothing here happens before
the owner says yes.

## The About box

**Description**, 350 characters or fewer, carrying the number:

> An LLM evaluation command line you point at your own cases: a pass rate with its exact interval, a
> verdict against your bar, and a refusal when the sample cannot tell. Given semcache's published
> 3 wrong answers against 0 in 2,000, it says the sample cannot tell, and that about 5,231 would.
> TypeScript, no runtime dependencies.

**Homepage**: none. The README is the page: the tool is the command, and its picture is drawn from
its own output by `node tools/picture.ts`.

**Topics**, ten:

```
llm  evals  llm-evaluation  llm-as-a-judge  statistics  confidence-intervals  cli  typescript  greek  testing
```

`evals` and `llm-evaluation` are the two a stranger with a model in production searches;
`llm-as-a-judge` and `confidence-intervals` are what separates this from the other runners.

## Settings

- **Public.** Issues on, so a stranger's first issue can arrive; wiki, projects and discussions off.
- **No Pages.** No workflow deploys anything; CI, if added, runs `npm ci` and `npm run check`.
- **No default community files.** The MIT LICENSE is committed and `check:licence` holds the README
  to it.

## The order

1. Create the repository with the description and topics above.
2. Push `main` with its whole history, every commit authored `Nikos Broikos
   <broikos.nikolaos@gmail.com>`, none co-authored (`check:source` holds both).
3. Run `bash tools/five-minutes.sh` against a clone of the pushed repository, from GitHub this
   time, and commit its output.
4. The README's clone command already names `Broikos-Nikos/evalbar`; check it resolves.

## Not before the owner's word

- No npm publish. `package.json` keeps `"private": true` until then; the name was free on
  registry.npmjs.org at tick 1 (B1).
- No post on any social platform, ever, from this workspace.
