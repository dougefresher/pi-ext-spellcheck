/**
 * Spell Check Extension for pi-coding-agent
 *
 * Uses codebook-lsp to spell-check editor content on demand via a shortcut
 * (default: ctrl+s). Misspelled words are shown in a selection dialog with
 * suggestions, and corrections are applied directly to the editor.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// -- Types ------------------------------------------------------------------

interface Misspelling {
  word: string;
  suggestions: string[];
  line: number;
  col: number;
}

// -- Lint output parser ------------------------------------------------------

/**
 * Parse codebook-lsp lint output. Format for each misspelling:
 *   <filepath>:<line>:<col>  <word>  -> <sugg1>, <sugg2>, ...
 *
 * The file header line (just the filepath, no colon) separates files.
 * We only care about the first file since we lint one temp file at a time.
 */
function parseLintOutput(stdout: string): Misspelling[] {
  const results: Misspelling[] = [];
  const lines = stdout.split('\n');

  // Skip until we find the first file header line (format: just a path, no colon+number)
  let pastHeader = false;
  for (const line of lines) {
    if (!pastHeader) {
      if (line.length > 0 && !/:\d+:\d+/.test(line)) {
        pastHeader = true;
      }
      continue;
    }

    // Match: <path>:<line>:<col>  <word>  -> <suggestions>
    const match = line.match(/^(.+):(\d+):(\d+)\s+([^\s]+)\s*(?:->\s*(.*))?$/);
    if (!match) continue;

    const word = match[4]!;
    const suggestions = match[5]
      ? match[5]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    results.push({
      word,
      suggestions,
      line: Number.parseInt(match[2]!, 10) - 1, // Convert to 0-based
      col: Number.parseInt(match[3]!, 10) - 1, // Convert to 0-based
    });
  }

  return results;
}

// -- Spell check runner -----------------------------------------------------

/**
 * Run codebook-lsp lint on the given text.
 * Writes to a temp file, runs lint, cleans up, returns misspellings.
 *
 * The file extension is used for Tree-sitter language detection.
 * Falls back to .txt for unknown languages.
 */
function runSpellCheck(text: string, cwd: string): Misspelling[] {
  // Determine a reasonable file extension based on the cwd context.
  // We don't have the active file info in the shortcut handler, so use .txt as
  // a safe default. Users working in a language project can override.
  const ext = '.txt';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-spellcheck-'));
  const tmpFile = path.join(tmpDir, `editor${ext}`);

  try {
    fs.writeFileSync(tmpFile, text, 'utf-8');

    const result = child_process.spawnSync('codebook-lsp', ['lint', '--suggest', tmpFile], {
      cwd,
      timeout: 10000,
      encoding: 'utf-8',
    });

    // codebook-lsp writes diagnostics to stdout, metadata to stderr
    return parseLintOutput(result.stdout);
  } catch {
    return [];
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

// -- Correction logic -------------------------------------------------------

/**
 * Apply a single word correction to the editor text.
 * Replaces the first occurrence of `oldWord` that appears at or after
 * the given line/col offset.
 */
function applyCorrection(text: string, misspelling: Misspelling, correction: string): string {
  const lines = text.split('\n');

  // Start searching from the reported line
  for (let i = misspelling.line; i < lines.length; i++) {
    const line = lines[i]!;
    const searchFrom = i === misspelling.line ? misspelling.col : 0;

    const idx = line.indexOf(misspelling.word, searchFrom);
    if (idx === -1) continue;

    const before = line.slice(0, idx);
    const after = line.slice(idx + misspelling.word.length);
    lines[i] = before + correction + after;
    break;
  }

  return lines.join('\n');
}

// -- Extension --------------------------------------------------------------

export default function spellCheck(pi: ExtensionAPI) {
  // Track whether we have codebook-lsp available
  let codebookAvailable = false;

  pi.on('session_start', (_event, ctx) => {
    try {
      child_process.execSync('codebook-lsp --version', { stdio: 'pipe' });
      codebookAvailable = true;
      if (ctx.hasUI) {
        ctx.ui.notify('Spell check ready (ctrl+; to check)', 'info');
      }
    } catch {
      codebookAvailable = false;
      if (ctx.hasUI) {
        ctx.ui.notify('Spell check: codebook-lsp not found on PATH', 'warning');
      }
    }
  });

  pi.registerShortcut('ctrl+;', {
    description: 'Spell check editor content',
    handler: async (ctx) => {
      if (!codebookAvailable) {
        ctx.ui.notify('codebook-lsp not available', 'error');
        return;
      }

      const text = ctx.ui.getEditorText();
      if (!text.trim()) {
        ctx.ui.notify('Editor is empty', 'info');
        return;
      }

      const misspellings = runSpellCheck(text, ctx.cwd);

      if (misspellings.length === 0) {
        ctx.ui.notify('No spelling errors found', 'info');
        return;
      }

      // Show misspellings one at a time. The user picks a word to fix,
      // then picks a suggestion. Loop until they cancel or fix everything.
      let currentText = text;
      // Work on a copy so we don't mutate while iterating
      const remaining = [...misspellings];

      while (remaining.length > 0) {
        const options = remaining.map(
          (m) =>
            `${m.word} (line ${m.line + 1}, col ${m.col + 1})${
              m.suggestions.length > 0 ? ` -> ${m.suggestions.slice(0, 3).join(', ')}` : ''
            }`,
        );

        const choice = await ctx.ui.select(`Spelling errors (${remaining.length} remaining)`, [...options, 'Done']);

        if (!choice || choice === 'Done') break;

        const index = options.indexOf(choice);
        if (index === -1) break;

        const misspelling = remaining[index]!;

        if (misspelling.suggestions.length > 0) {
          const correction = await ctx.ui.select(`Replace "${misspelling.word}" with:`, [
            ...misspelling.suggestions,
            'Skip',
          ]);

          if (correction && correction !== 'Skip') {
            currentText = applyCorrection(currentText, misspelling, correction);
            ctx.ui.setEditorText(currentText);
          }
        } else {
          ctx.ui.notify(`No suggestions for "${misspelling.word}"`, 'warning');
        }

        remaining.splice(index, 1);
      }
    },
  });
}
