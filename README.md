# pi-ext-spellcheck

Codebook-powered spell checking for pi-coding-agent.

Requires [`codebook-lsp`](https://github.com/blopker/codebook) on your `$PATH`.

## Usage

In pi, press `ctrl+s` to spell check the current editor content.

For each misspelled word:
- Select the word from the list
- Pick a suggested correction (or skip)
- Corrections are applied directly to the editor buffer

## Install

```bash
pi install git:https://github.com/dougefresher/pi-ext-spellcheck
```

Or for local development:

```bash
pi -e ./index.ts
```