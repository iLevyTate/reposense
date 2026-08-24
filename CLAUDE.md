# Working on RepoSense

Guidance for agents and contributors. Two kinds of rules live here: how to
write, and what must never break.

## Writing style

These rules govern everything written for people: the README, docs, code
comments, UI copy, commit messages, PR bodies, release notes, and posts.

- No em dashes and no en dashes, anywhere. Use a comma, a colon, a period,
  or parentheses instead. This rule has no exceptions.
- Never "not just X, it's Y" or its relatives ("more than just", "isn't
  only"). State what the thing is.
- No participial tails ("..., making it easier to..."). Give the consequence
  its own sentence.
- No transition glue opening a paragraph: Moreover, Furthermore,
  Additionally, "In today's world".
- Answer questions directly. Do not restate the question first.
- Lists earn each item. No rule-of-three padding, no triplets of synonyms.
- No bolded-label bullets of the form "**Speed**: it is fast". Write prose
  or a plain list.
- No vague attribution (experts say, studies show). Name the source or drop
  the claim.
- Banned words: delve, tapestry, realm, landscape, testament, underscore,
  navigate, foster, harness, leverage, robust, seamless, intricate, nuanced,
  multifaceted, meticulous, pivotal, crucial, vital, comprehensive, unlock,
  elevate, supercharge, transform, revolutionize, empower, streamline,
  cutting-edge, game-changing.
- Vary sentence length. Commit to positions instead of hedging. Prefer a
  checkable number to an adjective. End when the argument ends.

## Rules that must never break

- The SVG renderer is byte-deterministic: the same tree produces the same
  file. No Math.random, no Date.now in any render path. Seeded PRNGs only.
- The record hook (`?record=1`, `window.__reposense.seek`) renders identical
  pixels for identical timestamps on every machine. Nothing transient may
  reach a recorded frame, and user preferences (reduced motion included)
  must not change recorded output.
- The composer uses FXAA, never MSAA on a float target. MSAA there breaks
  real ANGLE/D3D drivers and paints the canvas white in production.
- Guard every fresnel with `pow(max(..., 0.0), k)`. A float-ulp overshoot
  makes pow return NaN and bloom smears it across the whole frame.
- The layout engine stays free of DOM and three.js imports. The Action
  depends on rendering SVG in a runner with no browser.

## Commands

- `npm test` runs the unit and CLI suites in about two seconds with nothing
  installed.
- `npm run test:browser` boots the real site in Chromium and drives it. Run
  it before any push that touches the viewer.
- `node scripts/reposense.mjs <dir> --json --svg out.svg` renders any local
  repository without the browser.
