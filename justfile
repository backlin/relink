# Build for production (typecheck + bundle + minify)
build: install
    pnpm build

# Build in watch mode for development
dev:
    pnpm dev

# Typecheck without emitting
check:
    pnpm tsc -noEmit -skipLibCheck

# Install dependencies
install:
    pnpm install

# Install plugin into an Obsidian vault (pass vault path)
install-plugin vault=(env('HOME') / "Vaults/Memory"): build
    mkdir -p "{{ vault }}/.obsidian/plugins/relink"
    cp dist/main.js manifest.json "{{ vault }}/.obsidian/plugins/relink/"

# Remove build artifacts
clean:
    rm -rf dist
