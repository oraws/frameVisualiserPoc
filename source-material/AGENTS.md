# Shared agent instructions

These instructions apply to the whole repository. Codex, Google Antigravity,
Gemini CLI, and any future coding agent must use the same project files and
leave the workspace intelligible to the next agent.

## Read before changing code

1. Read this file.
2. Read `SKILLS.md` for the task-specific runbooks.
3. Read `docs/PROJECT_STATUS.md` for the current verified state and unfinished work.
4. Read `docs/APP_ARCHITECTURE.md` before changing application behaviour,
   rendering, asset formats, local APIs, or persistence.
5. Read the relevant `tools/*/README.md` before changing an importer, renderer,
   calibration tool, or model pipeline.

Instructions in the user's current request take precedence over these files.

## Shared workspace protocol

- Treat the Git working tree as shared. Run `git status --short` and inspect the
  relevant diff before editing. Do not discard, reset, overwrite, or tidy work
  that may belong to the user or another agent.
- Continue from existing implementation and saved assets. Do not rebuild a
  feature from a chat summary when the repository contains the real state.
- Keep durable project knowledge in repository files, not only in a chat.
- Update `docs/PROJECT_STATUS.md` when a task changes behaviour, architecture,
  a data pipeline, a persistent format, or a material limitation. Replace stale
  status instead of appending a transcript.
- Update `docs/APP_ARCHITECTURE.md` when boundaries, data flow, storage, or
  runtime services change. Update the nearest tool README for command details.
- Record only facts verified from the current tree or a completed test. Clearly
  mark proposed work and known uncertainty.
- Do not put secrets, credentials, account information, machine-specific tokens,
  or private chat content in shared documentation.

## Product rules

- Supplier fidelity is the central requirement. Preserve exact artwork content,
  moulding identity, physical dimensions, profile shape, finish, and colour.
- Supplier photographs are evidence. Family references show intended family
  character, but may not override exact-SKU geometry or colour.
- A vision-model opinion is not an accepted asset. Model outputs remain review
  candidates until the user explicitly accepts a saved version.
- Keep review history immutable. Selecting or accepting a version must not clear
  later or earlier versions; history deletion is a separate administration task.
- Avoid visible repeated texture patterns, seams, unsupported ridges, false
  metallic colour, and lighting that changes the moulding's base colour.
- Room lighting should provide believable form, reflections, and shadows while
  the material base colour remains supplier-grounded.

## Verification

- For application changes, run `npm run build`.
- For moulding catalogue or asset changes, also run
  `npm run validate:moulding-assets`.
- For profile geometry changes, also run `npm run test:geometry`.
- For room-template changes, also run `node tools/test-generated-room.mjs` when
  the changed room is covered by it.
- For high-resolution rendering changes, run the focused test or render path in
  `tools/high-res-render/README.md` when local Blender is available.
- For any visual change, open the actual local viewer, reproduce the relevant
  mode and representative SKU, and inspect the result. A successful build alone
  is not visual verification.
- Do not assume port 4321. Astro/Vite may move to another free port when more
  than one instance is running. Use the URL printed by the process and confirm
  that it is serving this working tree.

## Generated and local state

- Do not edit generated texture/profile variants by hand unless the task is a
  manual asset correction and the provenance is documented.
- Local job, batch, benchmark, routing, and acceptance state may live in ignored
  dotfiles and job directories. Preserve it unless the user explicitly asks to
  clear it.
- Large model runtimes, virtual environments, Blender backups, and transient
  render jobs stay out of Git as defined by `.gitignore`.

