# MergeLink

Obsidian plugin that merges one note into another while preserving backlinks as aliased wikilinks.

When you merge note **A** into note **B**, all links pointing to A are rewritten so they point to B but still display the original text:

| Before | After |
|---|---|
| `[[A]]` | `[[B\|A]]` |
| `[[A\|custom text]]` | `[[B\|custom text]]` |
| `[[A#heading]]` | `[[B#heading\|A]]` |
| `[[A#heading\|custom]]` | `[[B#heading\|custom]]` |

A's content is appended to B with a separator, and A is moved to Obsidian's trash (recoverable).

## Usage

1. Open the note you want to merge away (the **source**)
2. Open the command palette (`Ctrl+P` / `Cmd+P`)
3. Search for **"Merge note into another (preserve backlinks)"**
4. Pick the **target** note (the one that receives the content)
5. Confirm

The active note is automatically used as the source. After merging, the source tab is closed and the target note is opened. If no note is open, a picker lets you choose the source.

## Installation

### Manual

1. Build the plugin (see below) or grab `main.js` and `manifest.json` from a release
2. Copy `main.js` and `manifest.json` into your vault at `.obsidian/plugins/mergelink/`
3. Enable **MergeLink** in Settings > Community plugins

## Building

```bash
pnpm install
pnpm build
```

This produces `main.js` in the project root.

## Development

```bash
pnpm dev
```

Builds in watch mode with source maps.
