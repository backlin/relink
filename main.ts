import {
	App,
	Modal,
	Notice,
	Plugin,
	TFile,
	WorkspaceLeaf,
	FuzzySuggestModal,
} from "obsidian";

/**
 * Fuzzy file picker that resolves with the chosen TFile.
 */
class FileSuggestModal extends FuzzySuggestModal<TFile> {
	private resolve: (file: TFile | null) => void;
	private promptText: string;

	constructor(app: App, prompt: string, resolve: (file: TFile | null) => void) {
		super(app);
		this.resolve = resolve;
		this.promptText = prompt;
		this.setPlaceholder(prompt);
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.resolve(item);
	}

	onClose(): void {
		// If modal closes without selection, resolve null
		setTimeout(() => this.resolve(null), 100);
	}
}

function pickFile(app: App, prompt: string): Promise<TFile | null> {
	return new Promise((resolve) => {
		let resolved = false;
		const modal = new FileSuggestModal(app, prompt, (file) => {
			if (!resolved) {
				resolved = true;
				resolve(file);
			}
		});
		modal.open();
	});
}

/**
 * Confirmation modal before executing the merge.
 */
class ConfirmModal extends Modal {
	private message: string;
	private resolve: (confirmed: boolean) => void;

	constructor(app: App, message: string, resolve: (confirmed: boolean) => void) {
		super(app);
		this.message = message;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });

		const btnContainer = contentEl.createDiv({ cls: "modal-button-container" });

		btnContainer
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => {
				this.resolve(false);
				this.close();
			});

		const confirmBtn = btnContainer.createEl("button", {
			text: "Merge",
			cls: "mod-cta",
		});
		confirmBtn.addEventListener("click", () => {
			this.resolve(true);
			this.close();
		});
	}

	onClose(): void {
		this.resolve(false);
	}
}

function confirm(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		let resolved = false;
		new ConfirmModal(app, message, (v) => {
			if (!resolved) {
				resolved = true;
				resolve(v);
			}
		}).open();
	});
}

class PromptModal extends Modal {
	private resolve: (value: string | null) => void;
	private title: string;
	private placeholder: string;
	private initialValue: string;

	constructor(app: App, title: string, placeholder: string, initialValue: string, resolve: (value: string | null) => void) {
		super(app);
		this.title = title;
		this.placeholder = placeholder;
		this.initialValue = initialValue;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });

		const input = contentEl.createEl("input", {
			type: "text",
			value: this.initialValue,
			placeholder: this.placeholder,
			cls: "mergelink-rename-input",
		});
		input.style.width = "100%";

		const btnContainer = contentEl.createDiv({ cls: "modal-button-container" });
		btnContainer.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.resolve(null);
			this.close();
		});
		const okBtn = btnContainer.createEl("button", { text: "Rename", cls: "mod-cta" });
		okBtn.addEventListener("click", () => {
			this.resolve(input.value.trim() || null);
			this.close();
		});

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { this.resolve(input.value.trim() || null); this.close(); }
			if (e.key === "Escape") { this.resolve(null); this.close(); }
		});

		setTimeout(() => { input.select(); }, 50);
	}

	onClose(): void {
		this.resolve(null);
	}
}

function promptText(app: App, title: string, placeholder: string, initialValue: string): Promise<string | null> {
	return new Promise((resolve) => {
		let resolved = false;
		new PromptModal(app, title, placeholder, initialValue, (v) => {
			if (!resolved) { resolved = true; resolve(v); }
		}).open();
	});
}

/**
 * Escape a string for use in a RegExp.
 */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default class MergeLinkPlugin extends Plugin {
	async onload(): Promise<void> {
		this.addCommand({
			id: "rename-preserve-backlinks",
			name: "Rename note (preserve backlink text)",
			callback: () => this.runRenamePreserve(),
		});

		this.addCommand({
			id: "merge-note-into",
			name: "Merge note into another (preserve backlinks)",
			callback: () => this.runMerge(),
		});

		this.addCommand({
			id: "replace-wikilinks-with-urls",
			name: "Copy with Wiki-links replaced by target URLs",
			callback: () => this.runReplaceWikilinksWithUrls(),
		});
	}

	async runRenamePreserve(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active file.");
			return;
		}

		const newBasename = await promptText(this.app, "Rename note", "New name", file.basename);
		if (!newBasename || newBasename === file.basename) return;

		const oldBasename = file.basename;
		const oldPathNoExt = file.path.slice(0, -3);
		const newPath = file.path.replace(/[^/]+\.md$/, `${newBasename}.md`);
		const newRef = newPath.slice(0, -3);

		try {
			await this.app.vault.rename(file, newPath);

			const oldBasenameEsc = escapeRegExp(oldBasename);
			const oldPathNoExtEsc = escapeRegExp(oldPathNoExt);

			const pattern = new RegExp(
				`\\[\\[(?:${oldPathNoExtEsc}|${oldBasenameEsc})(#[^\\]|]*?)?(?:\\|([^\\]]*?))?\\]\\]`,
				"g"
			);

			const allFiles = this.app.vault.getMarkdownFiles();
			for (const f of allFiles) {
				const content = await this.app.vault.read(f);
				const updated = content.replace(
					pattern,
					(_match, heading: string | undefined, alias: string | undefined) => {
						const h = heading ?? "";
						const headingText = heading ? heading.slice(1) : ""; // strip leading #
						const displayText = alias ?? (headingText ? `${oldBasename} > ${headingText}` : oldBasename);
						return `[[${newRef}${h}|${displayText}]]`;
					}
				);
				if (updated !== content) {
					await this.app.vault.modify(f, updated);
				}
			}

			new Notice(`Renamed "${oldBasename}" to "${newBasename}".`);
		} catch (e) {
			console.error("MergeLink rename error:", e);
			new Notice(`MergeLink error: ${e}`);
		}
	}

	async runMerge(): Promise<void> {
		// 1. Use active note as source, or fall back to picker
		const activeFile = this.app.workspace.getActiveFile();
		let source: TFile | null;
		if (activeFile) {
			source = activeFile;
		} else {
			source = await pickFile(this.app, "Select SOURCE note (will be merged & removed)");
		}
		if (!source) return;

		// 2. Pick target (B) — the note that receives the content
		const target = await pickFile(this.app, `Select TARGET note to merge "${source.basename}" into`);
		if (!target) return;

		if (source.path === target.path) {
			new Notice("Source and target must be different notes.");
			return;
		}

		// 3. Confirm
		const sourceName = source.basename;
		const targetName = target.basename;
		const ok = await confirm(
			this.app,
			`Merge "${sourceName}" into "${targetName}"?\n\n` +
				`• Content of "${sourceName}" will be appended to "${targetName}".\n` +
				`• All [[${sourceName}]] links will become [[${targetName}|${sourceName}]].\n` +
				`• "${sourceName}" will be deleted.`
		);
		if (!ok) return;

		try {
			await this.executeMerge(source, target);

			// Close any leaves showing the (now deleted) source note
			this.app.workspace.getLeavesOfType("markdown").forEach((leaf: WorkspaceLeaf) => {
				const file = (leaf.view as any).file as TFile | undefined;
				if (file && file.path === source!.path) {
					leaf.detach();
				}
			});

			// Open the target note
			await this.app.workspace.openLinkText(target.path, "", false);

			new Notice(`Merged "${sourceName}" into "${targetName}".`);
		} catch (e) {
			console.error("MergeLink error:", e);
			new Notice(`MergeLink error: ${e}`);
		}
	}

	async executeMerge(source: TFile, target: TFile): Promise<void> {
		const vault = this.app.vault;
		const sourceName = source.basename;
		const targetName = target.basename;

		// --- Append source content into target ---
		const sourceContent = await vault.read(source);
		const targetContent = await vault.read(target);

		const separator = `\n`;
		await vault.modify(target, targetContent + separator + sourceContent);

		// --- Update backlinks across the entire vault ---
		const allFiles = vault.getMarkdownFiles();

		// Build patterns to match wikilinks pointing to the source note.
		// We need to handle:
		//   [[A]]           → [[B|A]]
		//   [[A|custom]]    → [[B|custom]]
		//   [[A#heading]]   → [[B#heading|A]]
		//   [[A#heading|x]] → [[B#heading|x]]
		//
		// Also handle path-based links like [[folder/A]] if source is in a subfolder.
		// We match by basename and optionally by full path without extension.

		const sourceBasename = escapeRegExp(sourceName);
		const sourcePathNoExt = escapeRegExp(source.path.replace(/\.md$/, ""));

		// Pattern matches [[<sourcePath>#<heading>|<alias>]] in all variations
		// Group 1: the note reference (basename or path)
		// Group 2: optional #heading
		// Group 3: optional |alias
		const pattern = new RegExp(
			`\\[\\[` +
				`(?:${sourcePathNoExt}|${sourceBasename})` + // note name
				`(#[^\\]|]*?)?` +                            // optional #heading (group 1)
				`(?:\\|([^\\]]*?))?` +                        // optional |alias (group 2)
				`\\]\\]`,
			"g"
		);

		const targetRef = target.path.replace(/\.md$/, "");

		for (const file of allFiles) {
			if (file.path === source.path) continue;
			if (file.path === target.path) {
				// In the target file itself, remove self-links that would be circular
				continue;
			}

			const content = await vault.read(file);
			const updated = content.replace(pattern, (_match, heading: string | undefined, alias: string | undefined) => {
				const h = heading ?? "";
				// If there was an explicit alias, preserve it; otherwise use source name
				const displayText = alias ?? sourceName;
				return `[[${targetRef}${h}|${displayText}]]`;
			});

			if (updated !== content) {
				await vault.modify(file, updated);
			}
		}

		// --- Also update links inside the target file (from the originally merged content) ---
		const mergedContent = await vault.read(target);
		const selfLinkPattern = new RegExp(
			`\\[\\[` +
				`(?:${sourcePathNoExt}|${sourceBasename})` +
				`(#[^\\]|]*?)?` +
				`(?:\\|([^\\]]*?))?` +
				`\\]\\]`,
			"g"
		);
		const updatedMerged = mergedContent.replace(selfLinkPattern, (_match, heading: string | undefined, alias: string | undefined) => {
			const h = heading ?? "";
			const displayText = alias ?? sourceName;
			// Links to the source within the merged content should now point to the target itself
			return `[[${targetRef}${h}|${displayText}]]`;
		});
		if (updatedMerged !== mergedContent) {
			await vault.modify(target, updatedMerged);
		}

		// --- Delete the source note ---
		await vault.trash(source, false); // moves to Obsidian trash (.trash folder)
	}

	async runReplaceWikilinksWithUrls(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file.");
			return;
		}

		const vault = this.app.vault;
		const metadataCache = this.app.metadataCache;
		const raw = await vault.read(activeFile);
		const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

		// Matches [[linkpath]], [[linkpath|alias]], [[linkpath#heading]], [[linkpath#heading|alias]]
		// Group 1: linkpath, Group 2: #heading (optional), Group 3: alias (optional)
		const wikilinkPattern = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

		const updated = content.replace(wikilinkPattern, (
			_match,
			linkpath: string,
			_heading: string | undefined,
			alias: string | undefined
		) => {
			const displayText = alias?.trim() || linkpath.trim();
			const targetFile = metadataCache.getFirstLinkpathDest(linkpath.trim(), activeFile.path);
			if (!targetFile) return displayText;

			const url = metadataCache.getFileCache(targetFile)?.frontmatter?.url;
			return url ? `[${displayText}](${url})` : displayText;
		});

		const html = markdownToHtml(updated);
		await navigator.clipboard.write([
			new ClipboardItem({
				"text/plain": new Blob([updated], { type: "text/plain" }),
				"text/html": new Blob([html], { type: "text/html" }),
			}),
		]);
		new Notice("Copied to clipboard with wikilinks replaced.");
	}
}

/**
 * Convert a markdown string to an HTML string suitable for rich-text pasting.
 * Only handles the subset produced by runReplaceWikilinksWithUrls:
 *   - [text](url) → <a href="url">text</a>
 *   - blank lines   → paragraph breaks
 *   - single newlines → <br>
 */
function markdownToHtml(markdown: string): string {
	const paragraphs = markdown.split(/\n{2,}/);
	const htmlParagraphs = paragraphs.map((para) => {
		// Escape HTML entities in the raw text first, then re-introduce tags.
		// We process inline runs so that link text/URLs are escaped before wrapping.
		const escaped = para
			.split(/(\[[^\]]*\]\([^)]*\))/) // split on markdown links
			.map((part, i) => {
				if (i % 2 === 1) {
					// This part is a markdown link: [text](url)
					const m = part.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
					if (m) {
						const text = escapeHtml(m[1]);
						const href = escapeHtml(m[2]);
						return `<a href="${href}">${text}</a>`;
					}
				}
				return escapeHtml(part);
			})
			.join("");

		// Single newlines within a paragraph become <br>
		return `<p>${escaped.replace(/\n/g, "<br>")}</p>`;
	});

	return `<html><body>${htmlParagraphs.join("")}</body></html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
