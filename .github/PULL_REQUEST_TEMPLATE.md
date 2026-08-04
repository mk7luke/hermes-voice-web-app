<!--
Security fix? Stop — do not describe the vulnerability here.
Email 92970468+mk7luke@users.noreply.github.com first. See SECURITY.md.
-->

## What and why

<!-- The diff shows what changed. Explain why it needed changing. -->

Fixes #

## How you verified it

<!-- Paste what you actually ran, with real numbers. "Tests pass" says less
     than "npm test → 95/95". -->

```
npm test        →
npm run typecheck →
```

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Exercised manually against a real Hermes instance (say so if you could not — that is fine, just be explicit)

## Checklist

- [ ] One concern per PR
- [ ] Bug fix includes a test that fails before and passes after
- [ ] No `.env` values, tokens, or tailnet hostnames in the diff or in pasted output

## Touching `server/src/auth.ts`, `context.ts`, `config.ts`, or `routes/`?

That code sits between the internet and someone's personal AI agent, so it gets a
closer read.

- [ ] `tests/auth.test.ts` and `tests/routes.test.ts` still pass **unmodified**

If you changed an assertion in either file, say why here. Those tests encode the
app's safety properties — no route reaches Hermes without a valid cookie, and a
client cannot choose its Hermes session. A change that breaks them is usually the
bug, not the test.
