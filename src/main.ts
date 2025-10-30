// Minimal GJS GTK4 Adwaita app in TypeScript compiled to JS for gjs

// GJS globals (provided at runtime). Tell TypeScript they exist.
declare const imports: any;
declare const ARGV: any;
declare function log(...args: any[]): void;

// When multiple GI versions are present, GJS requires selecting the version
// before calling into `imports.gi`. Set the GTK/GDK/GdkPixbuf versions we expect.
if (typeof imports !== 'undefined' && imports.gi && imports.gi.versions) {
  try {
    // Prefer GTK4/GDK4 and GdkPixbuf 2.0 for raster handling
    imports.gi.versions.Gtk = imports.gi.versions.Gtk || '4.0';
    imports.gi.versions.Gdk = imports.gi.versions.Gdk || '4.0';
    // GdkPixbuf is usually 2.0
    imports.gi.versions.GdkPixbuf = imports.gi.versions.GdkPixbuf || '2.0';
    // Prefer libadwaita (Adw) if available
    imports.gi.versions.Adw = imports.gi.versions.Adw || '1';
    // Prefer libsoup 2.4 if multiple versions are available to avoid GJS warnings
    try {
      imports.gi.versions.Soup = imports.gi.versions.Soup || '2.4';
    } catch (e) {}
  } catch (e) {
    // Ignore if versions can't be set (e.g., running outside GJS at build time)
  }
}

const { Gio, Gtk, Gdk, GLib, GdkPixbuf } =
  typeof imports !== 'undefined'
    ? imports.gi
    : { Gio: null, Gtk: null, Gdk: null, GLib: null, GdkPixbuf: null };
// Adw (libadwaita) may be available; initialize it if present so the Adwaita style is applied.
let Adw: any = null;
try {
  if (typeof imports !== 'undefined' && imports.gi && imports.gi.Adw) {
    Adw = imports.gi.Adw;
    if (Adw.init) {
      Adw.init();
    }
  }
} catch (e) {
  Adw = null;
}

// Helper: analyze pixbuf and return primary/light/dark colors
function analyzePixbuf(pixbuf: any) {
  // Use a simple k-means style quantization on sampled pixels to find dominant colors.
  // This is lightweight and doesn't require external libs. We then derive light/dark
  // variants by converting to HSL and adjusting lightness.
  const width = pixbuf.get_width();
  const height = pixbuf.get_height();
  const rowstride = pixbuf.get_rowstride();
  const n_channels = pixbuf.get_n_channels();
  const pixels = pixbuf.get_pixels();

  // Collect a modest number of samples (subsample for speed)
  // Skip fully transparent pixels (when pixbuf has alpha channel) so backgrounds
  // don't dominate the sampled colors for logos/SVGs.
  const samples: Array<[number, number, number]> = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 60)); // ~60 samples per axis
  const hasAlpha = n_channels === 4;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      try {
        const idx = y * rowstride + x * n_channels;
        if (hasAlpha) {
          const a = pixels[idx + 3] & 0xff;
          if (a < 10) {
            continue;
          } // skip near-transparent
        }
        const r = pixels[idx] & 0xff;
        const g = pixels[idx + 1] & 0xff;
        const b = pixels[idx + 2] & 0xff;
        samples.push([r, g, b]);
      } catch (e) {
        // ignore malformed reads
      }
    }
  }

  if (samples.length === 0) {
    return { primary: '#888888', light: '#bbbbbb', dark: '#444444' };
  }

  // k-means-ish clustering
  const k = Math.min(6, Math.max(2, Math.floor(samples.length / 20))); // up to 6 clusters
  const centroids: Array<[number, number, number]> = [];
  // initialize centroids by picking evenly-spaced samples
  for (let i = 0; i < k; i++) {
    centroids.push(samples[Math.floor((i * samples.length) / k)]);
  }

  const assign = new Array(samples.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    // assign
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c++) {
        const d0 = p[0] - centroids[c][0];
        const d1 = p[1] - centroids[c][1];
        const d2 = p[2] - centroids[c][2];
        const dist = d0 * d0 + d1 * d1 + d2 * d2;
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    // update
    const sums: Array<[number, number, number]> = new Array(k).fill(null).map(() => [0, 0, 0]);
    const counts: number[] = new Array(k).fill(0);
    for (let i = 0; i < samples.length; i++) {
      const a = assign[i];
      sums[a][0] += samples[i][0];
      sums[a][1] += samples[i][1];
      sums[a][2] += samples[i][2];
      counts[a]++;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        const nr = Math.round(sums[c][0] / counts[c]);
        const ng = Math.round(sums[c][1] / counts[c]);
        const nb = Math.round(sums[c][2] / counts[c]);
        if (nr !== centroids[c][0] || ng !== centroids[c][1] || nb !== centroids[c][2])
          changed = true;
        centroids[c] = [nr, ng, nb];
      }
    }
    if (!changed) {
      break;
    }
  }

  // pick cluster by combined score: prefer large clusters and higher saturation
  const countsArr: number[] = new Array(k).fill(0);
  for (let i = 0; i < assign.length; i++) countsArr[assign[i]]++;
  type ClusterInfo = {
    idx: number;
    count: number;
    rgb: [number, number, number];
    hsl: [number, number, number];
    sat: number;
    score: number;
  };
  const clusters: ClusterInfo[] = [];
  for (let c = 0; c < k; c++) {
    const rgb = centroids[c];
    const [hh, ss, ll] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const sat = ss;
    // score combines cluster size and saturation bias (tunable)
    const score = countsArr[c] * (1 + sat * 3);
    clusters.push({ idx: c, count: countsArr[c], rgb, hsl: [hh, ss, ll], sat, score });
  }
  clusters.sort((a, b) => b.score - a.score);

  // choose the top scoring cluster, but avoid near-gray results when a more saturated
  // cluster is reasonably large. If the top is too desaturated, try to find the
  // most saturated cluster with count >= 3% of samples.
  let chosen = clusters[0];
  const satThreshold = 0.12; // below this considered desaturated/gray
  if (chosen.sat < satThreshold) {
    const minCount = Math.max(1, Math.floor(samples.length * 0.03));
    const moreSat = clusters
      .slice()
      .filter((c) => c.count >= minCount)
      .sort((a, b) => b.sat - a.sat);
    if (moreSat.length > 0 && moreSat[0].sat > chosen.sat + 0.05) {
      chosen = moreSat[0];
    }
  }
  const primaryRgb = chosen.rgb;
  const primaryHsl: [number, number, number] = [chosen.hsl[0], chosen.hsl[1], chosen.hsl[2]];

  const rgbToHex = (r: number, g: number, b: number) =>
    '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);

  // Helpers: rgb <-> hsl
  function rgbToHsl(r: number, g: number, b: number) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0,
      s = 0,
      l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
      }
      h /= 6;
    }
    return [h, s, l];
  }

  function hslToRgb(h: number, s: number, l: number) {
    let r: number, g: number, b: number;
    if (s === 0) {
      r = g = b = l; // achromatic
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) {
          t += 1;
        }
        if (t > 1) {
          t -= 1;
        }
        if (t < 1 / 6) {
          return p + (q - p) * 6 * t;
        }
        if (t < 1 / 2) {
          return q;
        }
        if (t < 2 / 3) {
          return p + (q - p) * (2 / 3 - t) * 6;
        }
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  const [ph, psOrig, pl] = primaryHsl || rgbToHsl(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
  // if the chosen color is very desaturated, nudge its saturation up to produce
  // visually pleasing branding colors (preserve hue)
  const ps = Math.max(psOrig, 0.12);
  // produce light/dark variants by shifting lightness; clamp within [0.03,0.97]
  const clamp01 = (v: number) => Math.max(0.03, Math.min(0.97, v));
  // Default light/dark deltas. We bias the dark variant to be noticeably
  // darker than the primary in most cases so the "dark" branding color is
  // actually darker than the primary color.
  const DEFAULT_LIGHT_DELTA = 0.22;
  const DEFAULT_DARK_DELTA = 0.26;
  let lightL = clamp01(pl + DEFAULT_LIGHT_DELTA);
  let darkL = clamp01(pl - DEFAULT_DARK_DELTA);

  // If original is already very light/dark, adjust variants to avoid extremes
  if (pl > 0.85) {
    // very light primary: keep light variant slightly less extreme, dark should be much darker
    lightL = clamp01(pl - 0.08);
    darkL = clamp01(pl - 0.3);
  } else if (pl < 0.15) {
    // very dark primary: make light variant lighter for visibility, but still
    // keep the dark variant darker than the primary where possible
    lightL = clamp01(pl + 0.3);
    darkL = clamp01(pl - 0.08);
  }

  // Ensure the dark variant is actually darker than the primary by a small gap
  // to avoid situations where rounding or clamping made it equal or lighter.
  const MIN_DARK_GAP = 0.12; // minimum difference in lightness between primary and dark
  try {
    if (pl - darkL < MIN_DARK_GAP) {
      darkL = clamp01(pl - MIN_DARK_GAP);
    }
  } catch (e) {}

  const lightRgb = hslToRgb(ph, ps, lightL);
  const darkRgb = hslToRgb(ph, ps, darkL);

  // Return hex strings
  return {
    primary: rgbToHex(primaryRgb[0], primaryRgb[1], primaryRgb[2]),
    light: rgbToHex(lightRgb[0], lightRgb[1], lightRgb[2]),
    dark: rgbToHex(darkRgb[0], darkRgb[1], darkRgb[2]),
  };
}

// Preview widgets/providers (populated in createApp)
let imageLight: any = null;
let imageDark: any = null;
let providerLight: any = null;
let providerDark: any = null;
// Container for previews so we can hide/show when no image is loaded
let previewsContainer: any = null;
let overlayLight: any = null;
let overlayDark: any = null;
let overlayLabelLight: any = null;
let overlayLabelDark: any = null;
// Keep track of the currently loaded image path so size-allocate handlers can rescale it
let currentImagePath: string | null = null;
// Keep global handles to the preview frames so we can query their allocation
let previewFrameLight: any = null;
let previewFrameDark: any = null;
// DrawingArea fallbacks (more control over painting & scaling)
let drawingLight: any = null;
let drawingDark: any = null;

// Fixed preview size (square) used throughout
const PREVIEW_SIZE = 300;

// Keep track of temp files we downloaded so we can clean them up when a new image is loaded
const tempFiles: string[] = [];

// Helper: force a widget to request a square content area of `size` and avoid
// expansion. Uses available APIs across GTK versions.
function enforceSquareWidget(widget: any, size: number) {
  try {
    if (!widget) return;
    try {
      if (typeof widget.set_min_content_width === 'function') widget.set_min_content_width(size);
    } catch (e) {}
    try {
      if (typeof widget.set_min_content_height === 'function') widget.set_min_content_height(size);
    } catch (e) {}
    try {
      if (typeof widget.set_max_content_width === 'function') widget.set_max_content_width(size);
    } catch (e) {}
    try {
      if (typeof widget.set_max_content_height === 'function') widget.set_max_content_height(size);
    } catch (e) {}
    try {
      if (typeof widget.set_hexpand === 'function') widget.set_hexpand(false);
    } catch (e) {}
    try {
      if (typeof widget.set_vexpand === 'function') widget.set_vexpand(false);
    } catch (e) {}
    try {
      if (typeof widget.set_size_request === 'function') widget.set_size_request(size, size);
    } catch (e) {}
  } catch (e) {}
}

// Schedule a rescale attempt after the main loop/idling so allocations are available
function scheduleRescaleForCurrentImage() {
  try {
    // Try to run at idle first
    if (GLib && GLib.idle_add) {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
          if (!currentImagePath) {
            return false;
          }
          const padding = 12;
          if (previewFrameLight && previewFrameLight.get_allocated_width) {
            const aw = previewFrameLight.get_allocated_width();
            const ah = previewFrameLight.get_allocated_height
              ? previewFrameLight.get_allocated_height()
              : aw;
            if (aw && ah) {
              const size = Math.max(32, Math.min(aw, ah) - padding * 2);
              const tmpDirLocal = GLib.get_tmp_dir ? GLib.get_tmp_dir() : '/tmp';
              const isTmp =
                typeof currentImagePath === 'string' &&
                currentImagePath.indexOf(tmpDirLocal) === 0 &&
                currentImagePath.indexOf('branding-picker-') >= 0;
              const pb = getPreviewPixbuf(currentImagePath as string, size, !isTmp);
              if (pb && imageLight) {
                imageLight.set_from_pixbuf(pb);
              }
              if (pb && imageLight) {
                imageLight.set_from_pixbuf(pb);
              }
              try {
                if (drawingLight && drawingLight.queue_draw) {
                  drawingLight.queue_draw();
                }
              } catch (e) {}
            }
          }
          if (previewFrameDark && previewFrameDark.get_allocated_width) {
            const aw = previewFrameDark.get_allocated_width();
            const ah = previewFrameDark.get_allocated_height
              ? previewFrameDark.get_allocated_height()
              : aw;
            if (aw && ah) {
              const size = Math.max(32, Math.min(aw, ah) - padding * 2);
              const tmpDirLocal = GLib.get_tmp_dir ? GLib.get_tmp_dir() : '/tmp';
              const isTmp =
                typeof currentImagePath === 'string' &&
                currentImagePath.indexOf(tmpDirLocal) === 0 &&
                currentImagePath.indexOf('branding-picker-') >= 0;
              const pb = getPreviewPixbuf(currentImagePath as string, size, !isTmp);
              if (pb && imageDark) {
                imageDark.set_from_pixbuf(pb);
              }
              if (pb && imageDark) {
                imageDark.set_from_pixbuf(pb);
              }
              try {
                if (drawingDark && drawingDark.queue_draw) {
                  drawingDark.queue_draw();
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
        return false; // one-shot
      });
      return;
    }
  } catch (e) {}

  // Fallback: try a short timeout (100ms) a few times
  try {
    let attempts = 0;
    const maxAttempts = 6;
    const cb = () => {
      try {
        attempts++;
        if (!currentImagePath) {
          return false;
        }
        const padding = 12;
        let didOne = false;
        if (previewFrameLight && previewFrameLight.get_allocated_width) {
          const aw = previewFrameLight.get_allocated_width();
          const ah = previewFrameLight.get_allocated_height
            ? previewFrameLight.get_allocated_height()
            : aw;
          if (aw && ah) {
            const size = Math.max(32, Math.min(aw, ah) - padding * 2);
            const tmpDirLocal2 = GLib.get_tmp_dir ? GLib.get_tmp_dir() : '/tmp';
            const isTmp2 =
              typeof currentImagePath === 'string' &&
              currentImagePath.indexOf(tmpDirLocal2) === 0 &&
              currentImagePath.indexOf('branding-picker-') >= 0;
            const pb = getPreviewPixbuf(currentImagePath as string, size, !isTmp2);
            if (pb && imageLight) {
              imageLight.set_from_pixbuf(pb);
            }
            try {
              if (drawingLight && drawingLight.queue_draw) {
                drawingLight.queue_draw();
              }
            } catch (e) {}
            didOne = true;
          }
        }
        if (previewFrameDark && previewFrameDark.get_allocated_width) {
          const aw = previewFrameDark.get_allocated_width();
          const ah = previewFrameDark.get_allocated_height
            ? previewFrameDark.get_allocated_height()
            : aw;
          if (aw && ah) {
            const size = Math.max(32, Math.min(aw, ah) - padding * 2);
            const tmpDirLocal = GLib.get_tmp_dir ? GLib.get_tmp_dir() : '/tmp';
            const isTmp =
              typeof currentImagePath === 'string' &&
              currentImagePath.indexOf(tmpDirLocal) === 0 &&
              currentImagePath.indexOf('branding-picker-') >= 0;
            const pb = getPreviewPixbuf(currentImagePath as string, size, !isTmp);
            if (pb && imageDark) {
              imageDark.set_from_pixbuf(pb);
            }
            try {
              if (drawingDark && drawingDark.queue_draw) {
                drawingDark.queue_draw();
              }
            } catch (e) {}
            didOne = true;
          }
        }
        if (didOne) {
          return false;
        }
        if (attempts >= maxAttempts) {
          return false;
        }
        return true; // try again
      } catch (e) {
        return false;
      }
    };
    if (GLib && GLib.timeout_add) {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, cb);
    }
  } catch (e) {}
}

// Color utilities
function hexToRgb(hex: string) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h, 16);
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function relativeLuminanceRgb(r: number, g: number, b: number) {
  const srgb = [r / 255, g / 255, b / 255].map((c) => {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(hex1: string, hex2: string) {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  const L1 = relativeLuminanceRgb(r1, g1, b1);
  const L2 = relativeLuminanceRgb(r2, g2, b2);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Scale-and-center-crop helper: try to create a square pixbuf of `size` that covers the area
function scaleAndCropToSquare(path: string, size: number) {
  try {
    const src = GdkPixbuf.Pixbuf.new_from_file(path);
    const w = src.get_width();
    const h = src.get_height();
    if (w === 0 || h === 0) {
      return null;
    }
    const scale = Math.max(size / w, size / h);
    const newW = Math.max(1, Math.ceil(w * scale));
    const newH = Math.max(1, Math.ceil(h * scale));
    let scaled: any = null;
    try {
      if (typeof (src as any).scale_simple === 'function') {
        scaled = (src as any).scale_simple(newW, newH, GdkPixbuf.InterpType.BILINEAR);
      }
    } catch (e) {}
    if (!scaled) {
      try {
        scaled = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, newW, newH, true);
      } catch (e) {
        scaled = null;
      }
    }
    if (!scaled) {
      return null;
    }
    const x = Math.max(0, Math.floor((newW - size) / 2));
    const y = Math.max(0, Math.floor((newH - size) / 2));
    try {
      if (typeof (scaled as any).new_subpixbuf === 'function') {
        return (scaled as any).new_subpixbuf(x, y, size, size);
      }
    } catch (e) {}
    try {
      return GdkPixbuf.Pixbuf.new_subpixbuf(scaled, x, y, size, size);
    } catch (e) {
      return scaled;
    }
  } catch (e) {
    return null;
  }
}

// Helper: load a pixbuf suitable for preview. If allowUpscale is false, do not enlarge
// images smaller than requested size — return the original pixbuf so it will be
// centered instead of being blown up.
function getPreviewPixbuf(path: string, size: number, allowUpscale: boolean) {
  try {
    if (!path) {
      return null;
    }
    // try to load original pixbuf first
    try {
      const src = GdkPixbuf.Pixbuf.new_from_file(path);
      if (!src) {
        return null;
      }
      const w = src.get_width();
      const h = src.get_height();
      // if we must not upscale and the image is smaller than requested, return the original
      if (!allowUpscale && w <= size && h <= size) {
        return src;
      }
      // Otherwise, prefer a scale-and-crop square that covers the preview
      const cropped = scaleAndCropToSquare(path, size);
      if (cropped) {
        return cropped;
      }
      // fallback: scale proportionally down to fit within size (no upscale if disallowed)
      if (allowUpscale) {
        try {
          return GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size, size, true);
        } catch (e) {}
      } else {
        // If not allowed to upscale but larger side exceeds size, scale down keeping aspect
        if (w > size || h > size) {
          try {
            const scale = Math.max(w, h);
            const target = size;
            try {
              return GdkPixbuf.Pixbuf.new_from_file_at_scale(path, target, target, true);
            } catch (e) {}
          } catch (e) {}
        }
        return src;
      }
    } catch (e) {
      return null;
    }
  } catch (e) {
    return null;
  }
}

// Helper: try to copy text to the clipboard using multiple strategies,
// or show a dialog with the text if all strategies fail.
function showSnippetDialog(snippet: string, parentWindow?: any) {
  try {
    const dialog = new Gtk.Dialog({
      transient_for: parentWindow || null,
      modal: true,
      title: 'Branding XML',
    });
    try {
      dialog.add_buttons('Close', Gtk.ResponseType.CLOSE);
    } catch (e) {}

    let content: any = null;
    try {
      content = dialog.get_content_area();
    } catch (e) {
      try {
        content = (dialog as any).get_content_area ? (dialog as any).get_content_area() : null;
      } catch (e) {
        content = null;
      }
    }

    const tv = new Gtk.TextView({ editable: false, cursor_visible: false });
    try {
      const buf = tv.get_buffer();
      buf.set_text(snippet);
      try {
        tv.set_selectable(true);
      } catch (e) {}
    } catch (e) {}

    try {
      const sw = new Gtk.ScrolledWindow({ min_content_width: 600, min_content_height: 200 });
      try {
        if (sw.set_child) {
          sw.set_child(tv);
        } else {
          sw.add(tv);
        }
      } catch (e) {
        try {
          sw.add(tv);
        } catch (e) {}
      }

      if (content && content.append) {
        content.append(sw);
      } else if (content && content.add) {
        content.add(sw);
      } else if ((dialog as any).set_child) {
        (dialog as any).set_child(sw);
      }
    } catch (e) {
      try {
        if (content && content.append) {
          content.append(tv);
        } else if (content && content.add) {
          content.add(tv);
        }
      } catch (e) {}
    }

    try {
      dialog.connect('response', () => {
        try {
          dialog.destroy();
        } catch (e) {}
      });
    } catch (e) {}

    try {
      dialog.show();
    } catch (e) {
      try {
        dialog.present();
      } catch (e) {}
    }
  } catch (e) {
    console.log(snippet);
  }
}

function copyToClipboard(snippet: string, parentWindow?: any) {
  // Helper to attempt set_text in different signatures
  const trySetText = (obj: any) => {
    if (!obj) {
      return false;
    }
    try {
      if (typeof obj.set_text === 'function') {
        try {
          obj.set_text(snippet);
          return true;
        } catch (e) {
          try {
            obj.set_text(snippet, -1);
            return true;
          } catch (e) {
            return false;
          }
        }
      }
    } catch (e) {}
    return false;
  };

  // 1) GTK4-style clipboard
  try {
    const disp = Gdk.Display.get_default ? Gdk.Display.get_default() : null;
    if (disp && (disp as any).get_clipboard) {
      const cb = (disp as any).get_clipboard();
      if (trySetText(cb)) return true;
    }
  } catch (e) {}

  // 2) GTK3-style clipboard
  try {
    if (
      typeof Gtk !== 'undefined' &&
      (Gtk as any).Clipboard &&
      (Gtk as any).Clipboard.get_default
    ) {
      try {
        const clipboard = (Gtk as any).Clipboard.get_default(Gdk.Display.get_default());
        if (trySetText(clipboard)) return true;
      } catch (e) {}
    }
  } catch (e) {}

  // 3) External helpers (wl-copy, xclip, xsel)
  // 3) Try xdg-desktop-portal Clipboard API via D-Bus (Flatpak sandbox friendly)
  try {
    // The portal API: org.freedesktop.portal.Clipboard. Use a session bus method call
    // We attempt a simple 'Set' call if available. This is best-effort and must not
    // throw in environments without the portal service.
    try {
      const bus = Gio.DBus.session || Gio.DBus.bus_get_sync(Gio.BusType.SESSION, null);
      // Some GJS versions expose Gio.DBus directly with convenient call flags, otherwise
      // fall back to Gio.DBusProxy on the well-known name if available.
      if (bus) {
        // Use the portal clipboard interface if present
        const portalName = 'org.freedesktop.portal.Clipboard';
        const portalPath = '/org/freedesktop/portal/clipboard';
        const iface = 'org.freedesktop.portal.Clipboard';
        try {
          // Try calling the Set method if provided: Set(text, options)
          // Not all portal implementations provide this exact call; wrap in try/catch.
          const flags = Gio.DBusCallFlags.NONE;
          const timeout = -1;
          // Some portals expect a dictionary of options; provide an empty dict
          const options = new GLib.Variant('(sa{sv})', [
            'text/copy',
            new GLib.Variant('a{sv}', []),
          ]);
          // Many portals do not actually implement a Set method with this signature, so
          // instead attempt to use a generic 'Copy' or 'SetClipboard' style call variants.
          // We'll attempt a few common method names.
          const tryPortalMethods = ['Set', 'Copy', 'SetClipboard', 'CopyText'];
          let portalSucceeded = false;
          for (let i = 0; i < tryPortalMethods.length && !portalSucceeded; i++) {
            const method = tryPortalMethods[i];
            try {
              // Build parameters conservatively: many portals accept a single string
              const param = new GLib.Variant('(s)', [snippet]);
              bus.call_sync(
                portalName,
                portalPath,
                iface,
                method,
                param,
                null,
                flags,
                timeout,
                null,
              );
              portalSucceeded = true;
            } catch (e) {
              try {
                // Try with (sa{sv}) tuple variant
                bus.call_sync(
                  portalName,
                  portalPath,
                  iface,
                  method,
                  options,
                  null,
                  flags,
                  timeout,
                  null,
                );
                portalSucceeded = true;
              } catch (e) {
                // ignore and continue
              }
            }
          }
          if (portalSucceeded) {
            log('Copied via xdg-desktop-portal');
            return true;
          }
        } catch (e) {
          // ignore portal-specific errors and continue to next fallback
        }
      }
    } catch (e) {
      // ignore and continue
    }
  } catch (e) {}

  try {
    const tryExternalCopy = (cmd: string[]) => {
      try {
        const proc = new Gio.Subprocess({ argv: cmd, flags: Gio.SubprocessFlags.STDIN_PIPE });
        proc.init(null);
        try {
          (proc as any).communicate_utf8(snippet, null);
          return true;
        } catch (e) {
          try {
            (proc as any).communicate_utf8_sync(snippet, null);
            return true;
          } catch (e) {
            return false;
          }
        }
      } catch (e) {
        return false;
      }
    };

    const helpers = [
      ['wl-copy'],
      ['xclip', '-selection', 'clipboard'],
      ['xsel', '--clipboard', '--input'],
    ];
    for (let i = 0; i < helpers.length; i++) {
      try {
        if (tryExternalCopy(helpers[i])) {
          log('Copied via external helper:', helpers[i].join(' '));
          return true;
        }
      } catch (e) {}
    }
  } catch (e) {}

  // 4) Fallback: show dialog with snippet
  showSnippetDialog(snippet, parentWindow);
  return false;
}

function handleFile(path: string, colorsBox: any, parentWindow?: any) {
  // Clean up any previously downloaded temp files we created
  try {
    // Remove any previously-downloaded temp files, but do not delete the file
    // we're about to open (path) if it is one of our temp files.
    const keep: string[] = [];
    for (let i = 0; i < tempFiles.length; i++) {
      try {
        const f = tempFiles[i];
        if (f === path) {
          // keep this one
          keep.push(f);
          continue;
        }
        try {
          GLib.unlink(f);
        } catch (e) {}
      } catch (e) {}
    }
    // restore any temp files we decided to keep (typically the current path)
    tempFiles.length = 0;
    for (let i = 0; i < keep.length; i++) {
      try {
        tempFiles.push(keep[i]);
      } catch (e) {}
    }
  } catch (e) {}

  // Clear previous children from colorsBox in a robust, cross-version way.
  try {
    // Preferred: foreach method (older codepaths)
    if (colorsBox && typeof (colorsBox as any).foreach === 'function') {
      try {
        (colorsBox as any).foreach((child: any) => {
          try {
            if (typeof colorsBox.remove === 'function') {
              colorsBox.remove(child);
            } else if (child && typeof child.destroy === 'function') {
              child.destroy();
            }
          } catch (e) {}
        });
      } catch (e) {}
    } else if (colorsBox && typeof (colorsBox as any).get_children === 'function') {
      // GTK4: get_children returns a JS array
      try {
        const kids = (colorsBox as any).get_children();
        if (kids && kids.length) {
          for (let i = 0; i < kids.length; i++) {
            try {
              if (typeof colorsBox.remove === 'function') {
                colorsBox.remove(kids[i]);
              } else if (kids[i] && typeof kids[i].destroy === 'function') {
                kids[i].destroy();
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    } else if (colorsBox && typeof (colorsBox as any).get_first_child === 'function') {
      // Fallback iterate-first-child (older GTK4 builds)
      try {
        let child = (colorsBox as any).get_first_child();
        while (child) {
          const next = child.get_next_sibling ? child.get_next_sibling() : null;
          try {
            if (typeof colorsBox.remove === 'function') {
              colorsBox.remove(child);
            } else if (child && typeof child.destroy === 'function') {
              child.destroy();
            }
          } catch (e) {}
          child = next;
        }
      } catch (e) {}
    } else {
      // Last resort: try to destroy any _children internal array if present
      try {
        const maybeKids = (colorsBox as any)._children;
        if (maybeKids && maybeKids.forEach) {
          maybeKids.forEach((c: any) => {
            try {
              if (c && typeof c.destroy === 'function') {
                c.destroy();
              }
            } catch (e) {}
          });
        }
      } catch (e) {}
    }
  } catch (e) {}

  try {
    // For SVGs, request a larger rasterization size so sampling yields good colors
    const isSvg = typeof path === 'string' && path.match(/\.svgz?$/i);
    const analysisSize = isSvg ? 512 : 256;
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, analysisSize, analysisSize, true);
    const colors = analyzePixbuf(pixbuf);

    const lightColor = colors.light;
    const darkColor = colors.dark;
    const primaryColor = colors.primary;

    const lightLabel = new Gtk.Label({ label: `Light: ${lightColor}` });
    const darkLabel = new Gtk.Label({ label: `Dark: ${darkColor}` });
    colorsBox.append(lightLabel);
    colorsBox.append(darkLabel);

    // Update previews background colors via CSS providers if available
    try {
      // Use the chosen primary branding color as the preview background so the
      // image is shown on top of the brand color for both light/dark previews.
      const cssPrimaryLight = `#preview-light { background-color: ${lightColor}; min-width: 300px; min-height: 300px; padding: 12px; }`;
      const cssPrimaryDark = `#preview-dark { background-color: ${darkColor}; min-width: 300px; min-height: 300px; padding: 12px; }`;
      try {
        if (providerLight && providerLight.load_from_data) {
          providerLight.load_from_data(cssPrimaryLight, -1);
        }
      } catch (e) {
        console.log(e);
      }
      try {
        if (providerDark && providerDark.load_from_data) {
          providerDark.load_from_data(cssPrimaryDark, -1);
        }
      } catch (e) {
        console.log(e);
      }
    } catch (e) {
      // ignore
    }

    // set images into the preview Image widgets if they exist (scale-and-crop to preview size)
    try {
      const previewSize = 300;
      // If the image was downloaded to tmp by our downloader, avoid upscaling it.
      const tmpDir = GLib.get_tmp_dir ? GLib.get_tmp_dir() : '/tmp';
      const isTmpDownloaded =
        typeof path === 'string' &&
        path.indexOf(tmpDir) === 0 &&
        path.indexOf('branding-picker-') >= 0;
      const pb = getPreviewPixbuf(path, previewSize, !isTmpDownloaded);
      if (pb) {
        if (imageLight) {
          imageLight.set_from_pixbuf(pb);
        }
        if (imageDark) {
          imageDark.set_from_pixbuf(pb);
        }
        // remember path so size-allocate can rescale when the preview frames are allocated
        try {
          currentImagePath = path;
        } catch (e) {}
        try {
          scheduleRescaleForCurrentImage();
        } catch (e) {}
        // Immediately attempt to rescale images to the actual preview frame allocation
        try {
          const padding = 12;
          if (previewFrameLight && previewFrameLight.get_allocated_width) {
            const aw = previewFrameLight.get_allocated_width();
            const ah = previewFrameLight.get_allocated_height
              ? previewFrameLight.get_allocated_height()
              : aw;
            const size = Math.max(32, Math.min(aw, ah) - padding * 2);
            const tmpDirLocal = GLib.get_tmp_dir ? GLib.get_tmp_dir() : '/tmp';
            const isTmp =
              typeof path === 'string' &&
              path.indexOf(tmpDirLocal) === 0 &&
              path.indexOf('branding-picker-') >= 0;
            const pb2 = getPreviewPixbuf(path, size, !isTmp);
            if (pb2) {
              if (imageLight) {
                imageLight.set_from_pixbuf(pb2);
              }
            }
          }
          if (previewFrameDark && previewFrameDark.get_allocated_width) {
            const aw = previewFrameDark.get_allocated_width();
            const ah = previewFrameDark.get_allocated_height
              ? previewFrameDark.get_allocated_height()
              : aw;
            const size = Math.max(32, Math.min(aw, ah) - padding * 2);
            const pb2 =
              scaleAndCropToSquare(path, size) ||
              GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size, size, true);
            if (pb2) {
              if (imageDark) {
                imageDark.set_from_pixbuf(pb2);
              }
            }
          }
        } catch (e) {}
        try {
          if (drawingLight && drawingLight.queue_draw) {
            drawingLight.queue_draw();
          }
          if (drawingDark && drawingDark.queue_draw) {
            drawingDark.queue_draw();
          }
        } catch (e) {}
      }
    } catch (e) {
      try {
        if (imageLight) {
          imageLight.set_from_pixbuf(pixbuf);
        }
      } catch (e) {}
      try {
        if (imageDark) {
          imageDark.set_from_pixbuf(pixbuf);
        }
      } catch (e) {}
    }

    const snippet = `<branding>\n  <color type=\"primary\" scheme_preference=\"light\">${lightColor}</color>\n  <color type=\"primary\" scheme_preference=\"dark\">${darkColor}</color>\n</branding>`;

    const copyButton = new Gtk.Button({ label: 'Copy AppStream branding XML' });
    copyButton.connect('clicked', () => copyToClipboard(snippet, parentWindow));
    colorsBox.append(copyButton);

    // Update overlay labels and show preview and colors area now that an image loaded
    try {
      // small helper to escape markup
      const escapeMarkup = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // overlay labels: show color hex and contrast vs white/black
      try {
        if (overlayLabelLight) {
          const contrastWithWhite = contrastRatio(lightColor, '#ffffff').toFixed(2);
          const contrastWithBlack = contrastRatio(lightColor, '#000000').toFixed(2);
          const text = `${lightColor} (W:${contrastWithWhite}, B:${contrastWithBlack})`;
          // Force the below-preview label for the light preview to white text as requested.
          const fg = '#ffffff';
          try {
            overlayLabelLight.set_markup(`<span foreground="${fg}">${escapeMarkup(text)}</span>`);
          } catch (e) {
            try {
              overlayLabelLight.set_text(text);
            } catch (e) {}
          }
        }
      } catch (e) {}
      try {
        if (overlayLabelDark) {
          const contrastWithWhite = contrastRatio(darkColor, '#ffffff').toFixed(2);
          const contrastWithBlack = contrastRatio(darkColor, '#000000').toFixed(2);
          const text = `${darkColor} (W:${contrastWithWhite}, B:${contrastWithBlack})`;
          // choose dark or light foreground for legibility (dark preview -> light text)
          const cW = contrastRatio(darkColor, '#ffffff');
          const fg = cW >= 3 ? '#ffffff' : '#000000';
          try {
            overlayLabelDark.set_markup(`<span foreground="${fg}">${escapeMarkup(text)}</span>`);
          } catch (e) {
            try {
              overlayLabelDark.set_text(text);
            } catch (e) {}
          }
        }
      } catch (e) {}
    } catch (e) {}

    // Show preview and colors area now that an image loaded
    try {
      if (previewsContainer) {
        if (typeof previewsContainer.show === 'function') {
          previewsContainer.show();
        } else if (typeof previewsContainer.set_visible === 'function') {
          previewsContainer.set_visible(true);
        }
      }
    } catch (e) {}
    try {
      if (colorsBox) {
        if (typeof colorsBox.show === 'function') {
          colorsBox.show();
        } else if (typeof colorsBox.set_visible === 'function') {
          colorsBox.set_visible(true);
        }
      }
    } catch (e) {}
    try {
      // After making previews visible, schedule a rescale now that allocation should exist
      scheduleRescaleForCurrentImage();
    } catch (e) {}
  } catch (e) {
    console.log('Error loading image: ' + e);
    // Hide previews/colors on error or if image couldn't be loaded
    try {
      if (previewsContainer) {
        if (typeof previewsContainer.hide === 'function') {
          previewsContainer.hide();
        } else if (typeof previewsContainer.set_visible === 'function') {
          previewsContainer.set_visible(false);
        }
      }
    } catch (e) {}
    try {
      if (colorsBox) {
        if (typeof colorsBox.hide === 'function') {
          colorsBox.hide();
        } else if (typeof colorsBox.set_visible === 'function') {
          colorsBox.set_visible(false);
        }
      }
    } catch (e) {}
  }
}

function createApp() {
  let window: any = null;
  const app = new Gtk.Application({
    application_id: 'org.example.BrandingPicker',
  });

  app.connect('activate', () => {
    if (!window) {
      try {
        window = new Gtk.ApplicationWindow({
          application: app,
          default_width: 700,
          default_height: 500,
          title: 'Branding Picker',
        });
      } catch (e) {
        window = new Gtk.Window({
          application: app,
          default_width: 700,
          default_height: 500,
          title: 'Branding Picker',
        });
      }

      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
      });
      // set uniform margin if setter exists
      try {
        if ((box as any).set_margin) {
          (box as any).set_margin(12);
        } else {
          if ((box as any).set_margin_top) (box as any).set_margin_top(12);
          if ((box as any).set_margin_bottom) (box as any).set_margin_bottom(12);
          if ((box as any).set_margin_start) (box as any).set_margin_start(12);
          if ((box as any).set_margin_end) (box as any).set_margin_end(12);
        }
      } catch (e) {
        // ignore if margins are not supported in this environment
      }
      // (Label will be placed inside the drop area so it's visually grouped with the Open button)

      // Controls: Open file button (will be placed inside the drop target)
      const openButton = new Gtk.Button({ label: 'Open…' });

      // Entry to accept a Flathub URL or an appId directly. When activated (Enter)
      // we will fetch the AppStream metadata from Flathub and download the icon.
      const appEntry = new Gtk.Entry({
        hexpand: true,
        placeholder_text: 'Flathub URL or appId (e.g. org.gnome.Glade)',
      });

      // Helper: extract appId from a Flathub URL or treat the input as an appId
      const extractAppIdFromInput = (input: string) => {
        try {
          if (!input) {
            return null;
          }
          try {
            // Trim
            input = input.trim();
          } catch (e) {}
          try {
            // If the user pasted a full URL, attempt to parse the last path segment
            const m = input.match(/https?:\/\/[^\/]*flathub\.org\/[^\/]*\/apps\/(.+)$/i);
            if (m && m[1]) {
              // remove any trailing slash
              let id = m[1].replace(/\/+$/, '');
              return id;
            }
          } catch (e) {}
          try {
            // Also accept short URLs like /en/apps/com.usebottles.bottles
            const m2 = input.match(/flathub\.org\/.+\/apps\/(.+)$/i);
            if (m2 && m2[1]) {
              return m2[1].replace(/\/+$/, '');
            }
          } catch (e) {}
          // Otherwise assume the input is the appId itself
          return input;
        } catch (e) {
          return null;
        }
      };

      // Helper: fetch AppStream JSON for an appId. Try libsoup first, fall back to curl.
      const fetchAppstream = (appId: string) => {
        try {
          if (!appId) {
            return null;
          }
          const url = `https://flathub.org/api/v2/appstream/${encodeURIComponent(appId)}`;
          // Try libsoup if available
          try {
            if (typeof imports !== 'undefined' && imports.gi && imports.gi.Soup) {
              const SoupLocal = imports.gi.Soup;
              try {
                // libsoup2 and libsoup3 have slightly different APIs; try both conservatively
                let session: any = null;
                try {
                  if (SoupLocal.Session) {
                    // libsoup2/3 compatible creation
                    try {
                      session = SoupLocal.Session.new();
                    } catch (e) {
                      try {
                        session = new SoupLocal.Session();
                      } catch (e) {
                        session = null;
                      }
                    }
                  }
                } catch (e) {}
                if (session) {
                  try {
                    const msg = SoupLocal.Message.new('GET', url);
                    try {
                      session.send_message(msg);
                    } catch (e) {
                      try {
                        // some Session variants use send_message_sync
                        if (typeof session.send_message_sync === 'function') {
                          session.send_message_sync(msg);
                        }
                      } catch (e) {}
                    }
                    if (msg && (msg as any).status_code === 200) {
                      try {
                        // response_body may be a string or a GLib.Bytes-like object
                        const body =
                          (msg as any).response_body && (msg as any).response_body.data
                            ? (msg as any).response_body.data
                            : (msg as any).response_body || null;
                        if (body) {
                          try {
                            const txt = typeof body === 'string' ? body : body.toString();
                            return JSON.parse(txt);
                          } catch (e) {}
                        }
                      } catch (e) {}
                    }
                  } catch (e) {}
                }
              } catch (e) {}
            }
          } catch (e) {}

          // Fallback: use curl via Gio.Subprocess to fetch JSON
          try {
            const argv = ['curl', '-fsSL', url];
            const proc = new Gio.Subprocess({
              argv: argv,
              flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            try {
              proc.init(null);
            } catch (e) {}
            try {
              const [ok, out, err] = proc.communicate_utf8(null, null);
              if (ok && out) {
                try {
                  return JSON.parse(out as string);
                } catch (e) {}
              }
            } catch (e) {}
          } catch (e) {}
        } catch (e) {}
        return null;
      };

      // Helper: download a URL to a temporary file and return the path, or null on failure
      const downloadUrlToTemp = (url: string) => {
        try {
          if (!url) {
            return null;
          }
          try {
            // If URL is relative, make absolute against flathub.org
            if (url.indexOf('://') < 0 && url.charAt(0) === '/') {
              url = 'https://flathub.org' + url;
            }
          } catch (e) {}

          // Prefer libsoup download if present so we don't rely on external tools
          try {
            if (typeof imports !== 'undefined' && imports.gi && imports.gi.Soup) {
              const SoupLocal = imports.gi.Soup;
              try {
                let session: any = null;
                try {
                  session = SoupLocal.Session.new();
                } catch (e) {
                  try {
                    session = new SoupLocal.Session();
                  } catch (e) {
                    session = null;
                  }
                }
                if (session) {
                  try {
                    const msg = SoupLocal.Message.new('GET', url);
                    try {
                      session.send_message(msg);
                    } catch (e) {
                      try {
                        if (typeof session.send_message_sync === 'function') {
                          session.send_message_sync(msg);
                        }
                      } catch (e) {}
                    }
                    if (msg && (msg as any).status_code === 200) {
                      try {
                        const body =
                          (msg as any).response_body && (msg as any).response_body.data
                            ? (msg as any).response_body.data
                            : (msg as any).response_body || null;
                        if (body) {
                          try {
                            const tmpDir = GLib.get_tmp_dir();
                            const extMatch = url.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
                            const ext = extMatch ? '.' + extMatch[1] : '.img';
                            const tmpPath = `${tmpDir}/branding-picker-${Date.now()}${ext}`;
                            try {
                              // body may be a string or a Bytes-like object
                              const data = typeof body === 'string' ? body : body.toString();
                              GLib.file_set_contents(tmpPath, data);
                              return tmpPath;
                            } catch (e) {}
                          } catch (e) {}
                        }
                      } catch (e) {}
                    }
                  } catch (e) {}
                }
              } catch (e) {}
            }
          } catch (e) {}

          // Fallback: use curl to write directly to a temp file
          try {
            const tmpDir = GLib.get_tmp_dir();
            const extMatch = url.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
            const ext = extMatch ? '.' + extMatch[1] : '.img';
            const tmpPath = `${tmpDir}/branding-picker-${Date.now()}${ext}`;
            const argv = ['curl', '-fsSL', '-o', tmpPath, url];
            try {
              const proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
              });
              try {
                proc.init(null);
              } catch (e) {}
              try {
                const [ok, out, err] = proc.communicate_utf8(null, null);
                // if curl exits successfully, return path
                if (ok) {
                  return tmpPath;
                }
              } catch (e) {}
            } catch (e) {}
          } catch (e) {}
        } catch (e) {}
        return null;
      };

      // Handler: when the entry is activated (Enter), attempt to fetch the app icon
      appEntry.connect('activate', () => {
        try {
          const raw = appEntry.get_text ? appEntry.get_text() : null;
          const appId = extractAppIdFromInput(raw);
          if (!appId) {
            try {
              // present a small dialog to inform user
              const d = new Gtk.MessageDialog({
                transient_for: window,
                modal: true,
                message_type: Gtk.MessageType.INFO,
                buttons: Gtk.ButtonsType.OK,
                text: 'Please enter a Flathub appId or URL',
              });
              try {
                d.connect('response', () => {
                  try {
                    d.destroy();
                  } catch (e) {}
                });
              } catch (e) {}
              try {
                d.show();
              } catch (e) {
                try {
                  d.present();
                } catch (e) {}
              }
            } catch (e) {}
            return;
          }

          // fetch metadata
          try {
            const meta = fetchAppstream(appId as string);
            if (!meta) {
              try {
                const d2 = new Gtk.MessageDialog({
                  transient_for: window,
                  modal: true,
                  message_type: Gtk.MessageType.ERROR,
                  buttons: Gtk.ButtonsType.OK,
                  text: `Failed to fetch metadata for ${appId}`,
                });
                try {
                  d2.connect('response', () => {
                    try {
                      d2.destroy();
                    } catch (e) {}
                  });
                } catch (e) {}
                try {
                  d2.show();
                } catch (e) {
                  try {
                    d2.present();
                  } catch (e) {}
                }
              } catch (e) {}
              return;
            }

            // find icon URL
            let iconUrl: string | null = null;
            try {
              if (meta.icons && Array.isArray(meta.icons) && meta.icons.length > 0) {
                for (let i = 0; i < meta.icons.length; i++) {
                  try {
                    if (meta.icons[i] && meta.icons[i].url) {
                      iconUrl = meta.icons[i].url;
                      break;
                    }
                  } catch (e) {}
                }
              }
            } catch (e) {}
            try {
              if (!iconUrl && meta.icon) {
                iconUrl = meta.icon;
              }
            } catch (e) {}

            if (!iconUrl) {
              try {
                const d3 = new Gtk.MessageDialog({
                  transient_for: window,
                  modal: true,
                  message_type: Gtk.MessageType.INFO,
                  buttons: Gtk.ButtonsType.OK,
                  text: `No icon URL found for ${appId}`,
                });
                try {
                  d3.connect('response', () => {
                    try {
                      d3.destroy();
                    } catch (e) {}
                  });
                } catch (e) {}
                try {
                  d3.show();
                } catch (e) {
                  try {
                    d3.present();
                  } catch (e) {}
                }
              } catch (e) {}
              return;
            }

            // download icon to temp file
            try {
              const tmpPath = downloadUrlToTemp(iconUrl as string);
              if (tmpPath) {
                // record temp file so we can clean it up later
                try {
                  tempFiles.push(tmpPath);
                } catch (e) {}
                handleFile(tmpPath, colorsBox, window);
              } else {
                try {
                  const d4 = new Gtk.MessageDialog({
                    transient_for: window,
                    modal: true,
                    message_type: Gtk.MessageType.ERROR,
                    buttons: Gtk.ButtonsType.OK,
                    text: `Failed to download icon for ${appId}`,
                  });
                  try {
                    d4.connect('response', () => {
                      try {
                        d4.destroy();
                      } catch (e) {}
                    });
                  } catch (e) {}
                  try {
                    d4.show();
                  } catch (e) {
                    try {
                      d4.present();
                    } catch (e) {}
                  }
                } catch (e) {}
              }
            } catch (e) {}
          } catch (e) {}
        } catch (e) {}
      });

      // Make the Open button accept drops so it doubles as the drop target
      try {
        const targets = [{ target: 'text/uri-list', flags: 0, info: 0 }];
        const flags = Gdk.DragAction.COPY;
        if ((openButton as any).drag_dest_set)
          (openButton as any).drag_dest_set(Gtk.DestDefaults.ALL, targets, flags);
        openButton.connect(
          'drag-data-received',
          (widget: any, context: any, x: any, y: any, data: any, info: any, time: any) => {
            try {
              const uris = data.get_uris();
              if (uris && uris.length > 0) {
                const file = Gio.File.new_for_uri(uris[0]);
                const path = file.get_path();
                handleFile(path, colorsBox, window);
              }
            } catch (e) {
              console.log('Drop on Open button failed:', e);
            }
          },
        );
      } catch (e) {}

      openButton.connect('clicked', () => {
        try {
          // Prefer FileChooserNative when available (GTK4)
          if (typeof Gtk.FileChooserNative !== 'undefined') {
            const chooser = new Gtk.FileChooserNative({
              title: 'Open image',
              action: Gtk.FileChooserAction.OPEN,
              transient_for: window,
            });
            const filter = new Gtk.FileFilter();
            filter.set_name('Images');
            try {
              filter.add_mime_type('image/png');
            } catch (e) {}
            try {
              filter.add_mime_type('image/svg+xml');
            } catch (e) {}
            try {
              filter.add_pattern('*.png');
              filter.add_pattern('*.svg');
            } catch (e) {}
            chooser.add_filter(filter);
            chooser.connect('response', (native: any, response: any) => {
              if (response === Gtk.ResponseType.ACCEPT) {
                const file = chooser.get_file();
                const path = file.get_path();
                handleFile(path, colorsBox, window);
              }
            });
            chooser.show();
          } else {
            // Fallback to a FileChooserDialog
            const dialog = new Gtk.FileChooserDialog({
              title: 'Open image',
              action: Gtk.FileChooserAction.OPEN,
              transient_for: window,
              modal: true,
            });
            dialog.add_buttons('Cancel', Gtk.ResponseType.CANCEL, 'Open', Gtk.ResponseType.OK);
            const filter = new Gtk.FileFilter();
            filter.set_name('Images');
            try {
              filter.add_mime_type('image/png');
            } catch (e) {}
            try {
              filter.add_mime_type('image/svg+xml');
            } catch (e) {}
            try {
              filter.add_pattern('*.png');
              filter.add_pattern('*.svg');
            } catch (e) {}
            dialog.add_filter(filter);
            const resp = dialog.run();
            if (resp === Gtk.ResponseType.OK) {
              const file = dialog.get_file();
              const path = file.get_path();
              handleFile(path, colorsBox, window);
            }
            dialog.destroy();
          }
        } catch (e) {
          console.log('File chooser failed: ', e);
        }
      });

      // Control area: instruction label and Open button (drop is handled by the button)
      const controlBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
      // (instruction label removed) control area kept minimal; Open button doubles as drop target
      try {
        controlBox.append(openButton);
      } catch (e) {
        try {
          controlBox.add(openButton);
        } catch (e) {}
      }
      try {
        controlBox.append(appEntry);
      } catch (e) {
        try {
          controlBox.add(appEntry);
        } catch (e) {}
      }

      const colorsBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
      });

      // Previews: show image on light and dark backgrounds (behind the image)
      const previewsBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
      });
      // Create frames with explicit header labels so we can control header foreground
      // color across themes. We build a small label widget for each header and set
      // its markup to force dark text on the light preview and light text on the
      // dark preview.
      const headerLight = new Gtk.Label({ label: 'Light preview' });
      const headerDark = new Gtk.Label({ label: 'Dark preview' });
      try {
        // Force header markup: dark text for light preview, light text for dark preview
        try {
          headerLight.set_markup('<span foreground="#000000">Light preview</span>');
        } catch (e) {
          try {
            headerLight.set_text('Light preview');
          } catch (e) {}
        }
        try {
          headerDark.set_markup('<span foreground="#ffffff">Dark preview</span>');
        } catch (e) {
          try {
            headerDark.set_text('Dark preview');
          } catch (e) {}
        }
      } catch (e) {}

      const previewLight = new Gtk.Frame({});
      const previewDark = new Gtk.Frame({});
      try {
        enforceSquareWidget(previewLight, PREVIEW_SIZE);
      } catch (e) {}
      try {
        enforceSquareWidget(previewDark, PREVIEW_SIZE);
      } catch (e) {}
      // Attach the custom header labels into the frames if API supports set_label_widget
      try {
        if ((previewLight as any).set_label_widget) previewLight.set_label_widget(headerLight);
        else if ((previewLight as any).set_label) previewLight.set_label('Light preview');
      } catch (e) {
        try {
          previewLight.set_label('Light preview');
        } catch (e) {}
      }
      try {
        if ((previewDark as any).set_label_widget) previewDark.set_label_widget(headerDark);
        else if ((previewDark as any).set_label) previewDark.set_label('Dark preview');
      } catch (e) {
        try {
          previewDark.set_label('Dark preview');
        } catch (e) {}
      }

      // expose frames to outer scope so handleFile can query allocation
      previewFrameLight = previewLight;
      previewFrameDark = previewDark;

      imageLight = new Gtk.Image();
      imageDark = new Gtk.Image();

      // Create DrawingArea fallbacks which will draw a cover-scaled image from currentImagePath
      try {
        drawingLight = new Gtk.DrawingArea();
        drawingLight.set_draw_func((area: any, cr: any, width: number, height: number) => {
          try {
            if (!currentImagePath) return;
            const padding = 12;
            const availW = Math.max(1, width - padding * 2);
            const availH = Math.max(1, height - padding * 2);
            const size = Math.max(availW, availH);
            const pb =
              scaleAndCropToSquare(currentImagePath as string, size) ||
              GdkPixbuf.Pixbuf.new_from_file_at_scale(currentImagePath as string, size, size, true);
            if (!pb) return;
            const x = Math.floor((width - size) / 2);
            const y = Math.floor((height - size) / 2);
            try {
              if (Gdk && (Gdk as any).cairo_set_source_pixbuf) {
                (Gdk as any).cairo_set_source_pixbuf(cr, pb, x, y);
                cr.paint();
              } else {
                // If cairo helper isn't available, attempt to convert via Cairo.ImageSurface
                try {
                  const surface = Gdk.cairo_surface_create_from_pixbuf
                    ? (Gdk as any).cairo_surface_create_from_pixbuf(pb, 1.0)
                    : null;
                  if (surface) {
                    cr.setSourceSurface(surface, x, y);
                    cr.paint();
                  }
                } catch (e) {}
              }
            } catch (e) {}
          } catch (e) {}
        });
      } catch (e) {
        drawingLight = null;
      }
      try {
        drawingDark = new Gtk.DrawingArea();
        drawingDark.set_draw_func((area: any, cr: any, width: number, height: number) => {
          try {
            if (!currentImagePath) return;
            const padding = 12;
            const availW = Math.max(1, width - padding * 2);
            const availH = Math.max(1, height - padding * 2);
            const size = Math.max(availW, availH);
            const pb =
              scaleAndCropToSquare(currentImagePath as string, size) ||
              GdkPixbuf.Pixbuf.new_from_file_at_scale(currentImagePath as string, size, size, true);
            if (!pb) return;
            const x = Math.floor((width - size) / 2);
            const y = Math.floor((height - size) / 2);
            try {
              if (Gdk && (Gdk as any).cairo_set_source_pixbuf) {
                (Gdk as any).cairo_set_source_pixbuf(cr, pb, x, y);
                cr.paint();
              } else {
                try {
                  const surface = Gdk.cairo_surface_create_from_pixbuf
                    ? (Gdk as any).cairo_surface_create_from_pixbuf(pb, 1.0)
                    : null;
                  if (surface) {
                    cr.setSourceSurface(surface, x, y);
                    cr.paint();
                  }
                } catch (e) {}
              }
            } catch (e) {}
          } catch (e) {}
        });
      } catch (e) {
        drawingDark = null;
      }

      // Ensure previews request enough space so images appear large
      try {
        if ((previewLight as any).set_hexpand) {
          (previewLight as any).set_hexpand(true);
        }
        if ((previewLight as any).set_vexpand) {
          (previewLight as any).set_vexpand(true);
        }
        if ((previewLight as any).set_min_content_width) {
          (previewLight as any).set_min_content_width(300);
        }
        if ((previewLight as any).set_min_content_height) {
          (previewLight as any).set_min_content_height(300);
        }
      } catch (e) {}
      try {
        if ((previewDark as any).set_hexpand) {
          (previewDark as any).set_hexpand(true);
        }
        if ((previewDark as any).set_vexpand) {
          (previewDark as any).set_vexpand(true);
        }
        if ((previewDark as any).set_min_content_width) {
          (previewDark as any).set_min_content_width(300);
        }
        if ((previewDark as any).set_min_content_height) {
          (previewDark as any).set_min_content_height(300);
        }
      } catch (e) {}

      // Center images inside the frames
      try {
        if ((imageLight as any).set_valign) {
          (imageLight as any).set_valign(Gtk.Align.CENTER);
        }
        if ((imageLight as any).set_halign) {
          (imageLight as any).set_halign(Gtk.Align.CENTER);
        }
      } catch (e) {}
      try {
        if ((imageDark as any).set_valign) {
          (imageDark as any).set_valign(Gtk.Align.CENTER);
        }
        if ((imageDark as any).set_halign) {
          (imageDark as any).set_halign(Gtk.Align.CENTER);
        }
      } catch (e) {}

      // Create overlays so we can show a swatch/label on top of the image
      try {
        overlayLight = new Gtk.Overlay();
      } catch (e) {
        overlayLight = null;
      }
      try {
        overlayDark = new Gtk.Overlay();
      } catch (e) {
        overlayDark = null;
      }

      // Set widget names so CSS can target them
      try {
        (previewLight as any).set_name('preview-light');
      } catch (e) {}
      try {
        (previewDark as any).set_name('preview-dark');
      } catch (e) {}

      // Labels shown below each preview (initially show placeholder)
      overlayLabelLight = new Gtk.Label({ label: 'No image loaded' });
      overlayLabelDark = new Gtk.Label({ label: 'No image loaded' });
      try {
        (overlayLabelLight as any).set_name('overlay-light');
      } catch (e) {}
      try {
        (overlayLabelDark as any).set_name('overlay-dark');
      } catch (e) {}

      // CssProviders for dynamic background colors (and overlay label styling)
      providerLight = new Gtk.CssProvider();
      providerDark = new Gtk.CssProvider();
      try {
        Gtk.StyleContext.add_provider_for_display(
          Gdk.Display.get_default(),
          providerLight,
          Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
        Gtk.StyleContext.add_provider_for_display(
          Gdk.Display.get_default(),
          providerDark,
          Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
      } catch (e) {
        // ignore if not available
      }

      // Pack images or drawing areas into overlays/frames
      try {
        if (overlayLight) {
          try {
            if (drawingLight) {
              overlayLight.set_child(drawingLight);
            } else {
              overlayLight.set_child(imageLight);
            }
          } catch (e) {
            try {
              if (drawingLight) {
                overlayLight.add(drawingLight);
              } else {
                overlayLight.add(imageLight);
              }
            } catch (e) {}
          }
          // overlay label moved below the frame; do not add as overlay
          try {
            previewLight.set_child(overlayLight);
          } catch (e) {
            try {
              previewLight.add(overlayLight);
            } catch (e) {}
          }
        } else {
          try {
            if (drawingLight) {
              previewLight.set_child(drawingLight);
            } else {
              previewLight.set_child(imageLight);
            }
          } catch (e) {
            try {
              if (drawingLight) {
                previewLight.add(drawingLight);
              } else {
                previewLight.add(imageLight);
              }
            } catch (e) {}
          }
        }
      } catch (e) {
        try {
          if (drawingLight) {
            previewLight.add(drawingLight);
          } else {
            previewLight.add(imageLight);
          }
        } catch (e) {}
      }

      try {
        if (overlayDark) {
          try {
            if (drawingDark) {
              overlayDark.set_child(drawingDark);
            } else {
              overlayDark.set_child(imageDark);
            }
          } catch (e) {
            try {
              if (drawingDark) {
                overlayDark.add(drawingDark);
              } else {
                overlayDark.add(imageDark);
              }
            } catch (e) {}
          }
          // overlay label moved below the frame; do not add as overlay
          try {
            previewDark.set_child(overlayDark);
          } catch (e) {
            try {
              previewDark.add(overlayDark);
            } catch (e) {}
          }
        } else {
          try {
            if (drawingDark) {
              previewDark.set_child(drawingDark);
            } else {
              previewDark.set_child(imageDark);
            }
          } catch (e) {
            try {
              if (drawingDark) {
                previewDark.add(drawingDark);
              } else {
                previewDark.add(imageDark);
              }
            } catch (e) {}
          }
        }
      } catch (e) {
        try {
          if (drawingDark) {
            previewDark.add(drawingDark);
          } else {
            previewDark.add(imageDark);
          }
        } catch (e) {}
      }

      // Create vertical containers that place the preview frame above its label
      try {
        const previewLightBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        try {
          previewLightBox.append(previewLight);
        } catch (e) {
          try {
            previewLightBox.add(previewLight);
          } catch (e) {}
        }
        try {
          overlayLabelLight.set_halign(Gtk.Align.CENTER);
          previewLightBox.append(overlayLabelLight);
        } catch (e) {
          try {
            previewLightBox.add(overlayLabelLight);
          } catch (e) {}
        }

        const previewDarkBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        try {
          previewDarkBox.append(previewDark);
        } catch (e) {
          try {
            previewDarkBox.add(previewDark);
          } catch (e) {}
        }
        try {
          overlayLabelDark.set_halign(Gtk.Align.CENTER);
          previewDarkBox.append(overlayLabelDark);
        } catch (e) {
          try {
            previewDarkBox.add(overlayLabelDark);
          } catch (e) {}
        }

        previewsBox.append(previewLightBox);
        previewsBox.append(previewDarkBox);
      } catch (e) {
        // Fallback: append frames directly
        previewsBox.append(previewLight);
        previewsBox.append(previewDark);
      }

      // When preview frames are allocated, rescale the current image to fit
      try {
        if ((previewLight as any).connect) {
          (previewLight as any).connect('size-allocate', () => {
            try {
              if (!currentImagePath) return;
              const aw = (previewLight as any).get_allocated_width
                ? (previewLight as any).get_allocated_width()
                : null;
              const ah = (previewLight as any).get_allocated_height
                ? (previewLight as any).get_allocated_height()
                : null;
              if (aw && ah) {
                const padding = 12;
                // enforce a square frame: pick the smaller side and request that size
                const outerSquare = Math.max(64, Math.min(aw, ah));
                try {
                  if ((previewLight as any).set_min_content_width) {
                    (previewLight as any).set_min_content_width(outerSquare);
                  }
                } catch (e) {}
                try {
                  if ((previewLight as any).set_min_content_height) {
                    (previewLight as any).set_min_content_height(outerSquare);
                  }
                } catch (e) {}
                const size = Math.max(32, outerSquare - padding * 2);
                const tmpDirLocal = GLib.get_tmp_dir ? GLib.get_tmp_dir() : '/tmp';
                const isTmp =
                  typeof currentImagePath === 'string' &&
                  currentImagePath.indexOf(tmpDirLocal) === 0 &&
                  currentImagePath.indexOf('branding-picker-') >= 0;
                const pb = getPreviewPixbuf(currentImagePath as string, size, !isTmp);
                if (pb && imageLight) {
                  imageLight.set_from_pixbuf(pb);
                }
                try {
                  if (drawingLight && drawingLight.queue_draw) drawingLight.queue_draw();
                } catch (e) {}
              }
            } catch (e) {}
          });
        }
      } catch (e) {}
      try {
        if ((previewDark as any).connect) {
          (previewDark as any).connect('size-allocate', () => {
            try {
              if (!currentImagePath) return;
              const aw = (previewDark as any).get_allocated_width
                ? (previewDark as any).get_allocated_width()
                : null;
              const ah = (previewDark as any).get_allocated_height
                ? (previewDark as any).get_allocated_height()
                : null;
              if (aw && ah) {
                const padding = 12;
                // enforce square frame
                const outerSquare = Math.max(64, Math.min(aw, ah));
                try {
                  if ((previewDark as any).set_min_content_width) {
                    (previewDark as any).set_min_content_width(outerSquare);
                  }
                } catch (e) {}
                try {
                  if ((previewDark as any).set_min_content_height) {
                    (previewDark as any).set_min_content_height(outerSquare);
                  }
                } catch (e) {}
                const size = Math.max(32, outerSquare - padding * 2);
                const tmpDirLocal = GLib.get_tmp_dir ? GLib.get_tmp_dir() : '/tmp';
                const isTmp =
                  typeof currentImagePath === 'string' &&
                  currentImagePath.indexOf(tmpDirLocal) === 0 &&
                  currentImagePath.indexOf('branding-picker-') >= 0;
                const pb = getPreviewPixbuf(currentImagePath as string, size, !isTmp);
                if (pb && imageDark) {
                  imageDark.set_from_pixbuf(pb);
                }
                try {
                  if (drawingDark && drawingDark.queue_draw) drawingDark.queue_draw();
                } catch (e) {}
              }
            } catch (e) {}
          });
        }
      } catch (e) {}

      // Keep a handle so we can show/hide the previews as needed
      previewsContainer = previewsBox;
      // Initially hidden until an image is loaded
      try {
        if (typeof previewsContainer.hide === 'function') previewsContainer.hide();
        else if (typeof previewsContainer.set_visible === 'function')
          previewsContainer.set_visible(false);
      } catch (e) {}
      try {
        if (typeof colorsBox.hide === 'function') colorsBox.hide();
        else if (typeof colorsBox.set_visible === 'function') colorsBox.set_visible(false);
      } catch (e) {}

      box.append(controlBox);
      box.append(previewsBox);
      box.append(colorsBox);

      if (window.set_child) {
        window.set_child(box);
      }

      // Note: drag-and-drop is handled by the Open button (configured earlier).
    }

    if (window.present) {
      window.present();
    }
  });

  return app;
}

function main(argv: any) {
  const app = createApp();
  return (app as any).run(argv);
}

if (typeof imports !== 'undefined' && imports.gi) {
  const argv = typeof ARGV !== 'undefined' ? ARGV : [];
  main(argv);
}
