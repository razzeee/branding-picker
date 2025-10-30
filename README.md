# Branding Picker

A small GJS (GNOME JavaScript) application written in TypeScript that accepts a dropped PNG or SVG and suggests AppStream branding colors for light and dark schemes.

## Features

- Drop a PNG or SVG onto the app
- Analyze the image to pick primary branding colors for light and dark schemes
- Copy an AppStream `<branding>` XML snippet to the clipboard

## Prerequisites

- gjs (GJS runtime)
- GTK4 and GNOME platform libraries
- (optional) librsvg (`Rsvg`) for better SVG rasterization

## Build

Install dependencies and build:

```bash
npm install --no-audit --no-fund
npm run build
```

## Run

Run the compiled JS with `gjs`:

```bash
gjs dist/main.js

# or use the provided wrapper script
./run.sh
```

## Flatpak

There is a sample Flatpak manifest `org.example.BrandingPicker.json` in the project root. To build with `flatpak-builder` you will usually add a local `dir` source to the manifest and then run:

```bash
flatpak run org.flatpak.Builder build-dir --user --ccache --force-clean --install org.example.BrandingPicker.json
```

## Development

- Edit `src/main.ts`. The project uses TypeScript and compiles to `dist/main.js`.
- The `run.sh` script is a thin wrapper to invoke `gjs` with the compiled JS.
