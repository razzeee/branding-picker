# Branding Picker - AI Coding Instructions

## Project Overview

A GTK4/Adwaita desktop application written in TypeScript that analyzes PNG/SVG images dropped by users and generates AppStream branding color suggestions for light and dark color schemes. Runs on GJS (GNOME JavaScript) runtime and is packaged as a Flatpak.

## Architecture

### Technology Stack

- **Runtime**: GJS (GNOME JavaScript runtime) - NOT Node.js
- **Language**: TypeScript compiled to CommonJS JavaScript
- **UI Framework**: GTK4 with libadwaita (Adw)
- **Build**: TypeScript compiler (tsc) targeting ES2020
- **Packaging**: Flatpak with `org.gnome.Platform` runtime v49

### Key Architectural Constraints

1. **Single-file architecture**: All code currently lives in `src/main.ts` (2600+ lines) - should be split into modules
2. **GJS-specific patterns**: Uses `imports.gi.*` for GNOME libraries, not standard ES modules
3. **Runtime type checking**: Must check for GJS globals like `imports` and handle build-time compilation gracefully
4. **No external dependencies**: Pure GTK4/GdkPixbuf image analysis without npm runtime packages

## Critical Developer Workflows

### Build and Run

```bash
# Build TypeScript to JavaScript
npm run build

# Run locally with GJS
gjs dist/main.js
# or use the wrapper (sets GTK theme)
./run.sh

# Watch mode for development
npm run watch
```

### Flatpak Development

```bash
# Build Flatpak locally
flatpak-builder build-dir --user --ccache --force-clean --install org.example.BrandingPicker.json

# Run Flatpak
flatpak run org.example.BrandingPicker
```

**Important**: Flatpak manifest (`org.example.BrandingPicker.json`) requires Node.js SDK extension for npm/TypeScript build.

## Code Patterns and Conventions

### Critical Syntax Rules

**Always use braces with if statements**, even for single-line blocks:

```typescript
// ✅ CORRECT
if (condition) {
  doSomething();
}

// ❌ WRONG - Never do this
if (condition) doSomething();
```

### GJS Module Loading Pattern

Always version-gate GI imports to avoid runtime conflicts:

```typescript
if (typeof imports !== 'undefined' && imports.gi && imports.gi.versions) {
  imports.gi.versions.Gtk = '4.0';
  imports.gi.versions.Gdk = '4.0';
  imports.gi.versions.Adw = '1';
}
const { Gio, Gtk, Gdk, GLib, GdkPixbuf } = imports.gi;
```

### Build-time vs Runtime Guards

Use typeof checks to prevent errors when TypeScript compiler runs (no GJS available at build time):

```typescript
if (typeof imports !== 'undefined' && imports.gi) {
  // GJS runtime code
}
```

### Image Analysis Architecture

- **Multiple algorithms**: 6 different color analysis strategies (kmeans, hsl-shift, complementary, contrast-max, vivid, average)
- **Algorithm switching**: `currentAlgorithm` global variable controls active analyzer
- **Color manipulation**: Centralized `rgbToHsl`/`hslToRgb` helpers for all analyzers
- **SVG handling**: Uses librsvg (`Rsvg`) when available for better SVG rasterization

### UI State Management

Global variables track UI state:

- `currentImagePath`: Currently loaded image file path
- `previewFrameLight`/`previewFrameDark`: Preview widget handles
- `imageLight`/`imageDark`: GtkImage widgets for display
- `tempFiles[]`: Tracks downloaded images for cleanup

### Drag-and-Drop Implementation

- Accepts file:// URIs and http(s):// URLs
- Downloads remote images to temp dir with GLib async I/O
- Cleans up temp files on new image load

## Common Tasks

### Adding a New Color Algorithm

1. Create `analyzePixbuf_<name>(pixbuf)` function
2. Return `{ primary, light, dark }` hex color object
3. Add case to `analyzePixbufDispatch()` switch statement
4. Add UI button in algorithm selection box (search for "algoBox" in code)

### Modifying Color Derivation Logic

- Light/dark variants use HSL lightness shifts: `DEFAULT_LIGHT_DELTA = 0.22`, `DEFAULT_DARK_DELTA = 0.26`
- Saturation boost for desaturated colors: `Math.max(s, 0.12)` to avoid gray results
- Special handling for very light (>0.85) or very dark (<0.15) primary colors
- Find logic in `analyzePixbuf_kmeans()` as reference implementation

### Working with GdkPixbuf

```typescript
const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
const width = pixbuf.get_width();
const height = pixbuf.get_height();
const pixels = pixbuf.get_pixels(); // Uint8Array
const rowstride = pixbuf.get_rowstride();
const n_channels = pixbuf.get_n_channels(); // 3 for RGB, 4 for RGBA

// Pixel access pattern:
const idx = y * rowstride + x * n_channels;
const r = pixels[idx] & 0xff;
const g = pixels[idx + 1] & 0xff;
const b = pixels[idx + 2] & 0xff;
```

## Integration Points

### AppStream XML Output

Generates `<branding>` tags for AppStream metadata:

```xml
<branding>
  <color type="primary" scheme_preference="light">#hexcolor</color>
  <color type="primary" scheme_preference="dark">#hexcolor</color>
</branding>
```

### Clipboard Integration

Uses `Gdk.Display.get_clipboard()` with fallback to manual selection dialogs if clipboard API unavailable.

## Project Structure

### Current State & Future Plans

- **Single-file limitation**: Currently all code is in `src/main.ts` - needs refactoring into separate modules
- **Module system**: When splitting files, use CommonJS (`module.exports`/`require`) since TypeScript targets CommonJS for GJS
- **Suggested structure**: Consider splitting into:
  - `src/algorithms/` - Color analysis algorithms (kmeans, hsl-shift, etc.)
  - `src/ui/` - UI components and state management
  - `src/utils/` - Color conversion helpers, pixel access utilities
  - `src/main.ts` - Application entry point and window setup

### Build Artifacts

- **No dist gitignore**: `dist/` excluded from git; Flatpak builds locally
- **No test suite**: Visual inspection is sufficient for this interactive color-picking tool

## Known Quirks

- **GTK version checks**: Code uses defensive `typeof widget.method === 'function'` checks for GTK API compatibility
- **Size allocation timing**: Preview rescaling uses GLib idle callbacks to wait for widget allocation
- **Temp file management**: Downloads go to `GLib.get_tmp_dir()` with "branding-picker-" prefix
- **No Rsvg fallback**: SVG rendering degrades to GdkPixbuf's basic loader if Rsvg unavailable

## Don't Do This

- ❌ Add Node.js runtime dependencies (npm packages used at build time only)
- ❌ Use ES6 import/export syntax (GJS requires CommonJS: `module.exports`/`require`)
- ❌ Assume modern browser APIs (this is GJS, not Node or browsers)
- ❌ Use `async`/`await` - GJS uses callback-based async patterns with GLib
- ❌ Omit braces on if statements - always use `{ }` even for single-line blocks

## Performance Notes

- Image sampling uses stepped iteration (`step = Math.max(1, ...)`) to analyze ~60 samples per axis
- K-means limited to 12 iterations for responsive UI
- Skip fully transparent pixels (alpha < 10) to ignore logo backgrounds
