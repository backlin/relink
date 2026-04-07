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

/**
 * Escape a string for use in a RegExp.
 */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default class MergeLinkPlugin extends Plugin {
	async onload(): Promise<void> {
		this.addCommand({
			id: "merge-note-into",
			name: "Merge note into another (preserve backlinks)",
			callback: () => this.runMerge(),
		});
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
}
