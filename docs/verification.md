# Verification record

Every claim below was produced on this machine against the shipping DeepSeek Harness
(`@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.2**, Windows, 2026-11-12).

## 1. Unit tests

```text
$ npm test
# tests 13
# pass 13
# fail 0
```

Covers pass-through, rescue ordering, note text, corrupt-image refusal, count/byte
overflow, disposal restoring native behavior, and manifest/config checks.

## 2. Integration against the real attachment store

The real `@deepseek-ai/dsh-attachment-local` 0.2.1-rc.2 module was extracted from the
shipping app and driven directly (no mocks for the store or for sharp). 21 assertions:

- baseline: `admitPromptContent` refuses a 9000×3000 JPEG with `IMAGE_DIMENSION_TOO_LARGE`
  and an 8192×8192 JPEG with `IMAGE_TOO_MANY_PIXELS` (the reported bug);
- with the wrapper: the oversized source becomes `{type:"file"}` whose stored bytes
  are sha256-identical to the source, the compliant image in the same batch stays
  `{type:"image"}`, the note names dimensions and limit, user text is untouched;
- `readFileStream` re-verifies the rescued object;
- corrupt bytes still fail with `INVALID_IMAGE` (no silent rescue);
- 21 small images: 20 stay images, 1 becomes a file (`TOO_MANY_IMAGES` overflow);
- disposing the wrapper restores the native refusal.

## 3. Real UI run

DeepSeek Harness Desktop, real Web UI, authenticated browser session, new blank
session, hidden file input, one short prompt:

| Case | Result |
|---|---|
| `wide_9000x3000.jpg` (9000×3000, 328,873 B) | **PASS** — no 8192 px toast; user message renders a file card `wide_9000x3000.jpg / JPG 321KB`; session store records `type:"file"`, `bytes: 328873`; on-disk object sha256 `d4caf240ab954d7d4bc7144e160c39a5fd0241ce3b1e3925f0ce7c39875cbdb8` matches the source; model replies `ok` |
| `small_800x600.jpg` (800×600, 18,494 B) | **PASS (control)** — still an ordinary image attachment with thumbnail; behavior unchanged |

Session ids (local, may be archived): `session-54fe7b5e-fa4b-4c79-a205-fa46d69345aa`
(big image), `session-a1599a3f-d506-4b0c-a4d4-d895e6cf01b9` (control).

## 4. What was not verified

- Other hosts/backends than `dsh-attachment-local` (the wrapper degrades to native
  behavior when `saveFile` is unavailable).
- Other DSH versions than 0.2.1-rc.2 (`engines.dsh` declares that range).
- macOS / Linux.
