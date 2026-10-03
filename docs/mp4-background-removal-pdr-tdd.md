# MP4 BG Removal — PDR + TDD

> Baseline: 2026-10-03. PDR means Product Design Requirements; TDD means Technical Design Document. This describes the current local implementation. A requirement marked implemented is a code capability, not a guarantee that every input video will key cleanly.

## 1. Product definition (PDR)

MP4 BG Removal is the local green-screen removal module in Codex Workbench. It turns an AI-generated MP4 into a transparent, infinitely looping Animated WebP for animated UI frames and similar assets. Both the outer background and a green center must become transparent. The user can inspect a single frame before spending time encoding the selected interval.

The module runs in a local browser with a local Node.js process and FFmpeg/FFprobe. It does not upload media to an internet service. The browser may list several MP4 files, but **only the selected file is converted**. Each selected file has its own editing profile and frame interval for the current session. Settings are not copied from one file to another.

### User flow

1. Drop or select one or more MP4 files, then select a file from the list.
2. Scrub the source timeline, set its start and end handles, and play the selected source interval to locate a useful segment.
3. Set the key color, Similarity, and Blend/Feather. Inspect the processed single frame or generate a transparent interval preview.
4. Choose original, square preset, or custom output dimensions. Use proportional crop or proportional scale with transparent padding. Adjust the crop in the fixed frame and optionally move or zoom the transparent foreground.
5. Choose an existing output folder and convert the **current** file. Inspect the saved path and open its folder.

### Functional requirements and acceptance behavior

| ID | Requirement | Current behavior |
| --- | --- | --- |
| MP4-01 | Select/drop several MP4 files, select one for editing, and remove files without changing the source files. | Implemented. Only the current file converts. |
| MP4-02 | Keep key, trim, crop, size, FPS, foreground placement, preview background, and output folder independent per file while the page stays open. | Implemented as per-file in-memory profiles/ranges; refresh does not persist them. |
| MP4-03 | Default key color `#00FF00`; adjustable Similarity and Blend/Feather. | Implemented with FFmpeg `colorkey`. Defaults: Similarity `0.27`, Blend `0.08`. |
| MP4-04 | Inspect a source frame and its transparent result without a full video conversion. | Implemented by sending a browser-captured PNG frame to local FFmpeg. |
| MP4-05 | Select an inclusive source-frame interval with two timeline handles, jump to its endpoints, and play that source interval directly. | Implemented. Source FPS defaults to 30 and is editable for frame addressing. |
| MP4-06 | Preview the processed interval and scrub individual output frames. Reuse an unchanged preview. | Implemented with a temporary transparent WebM cached in browser memory; a changed key, trim, crop, size, or FPS invalidates it. |
| MP4-07 | Export transparent Animated WebP with infinite looping, default output FPS 20, and a source-based filename. | Implemented with `libwebp_anim`, lossless encoding, RGBA, and loop count `0`. Existing filenames get a numeric suffix. |
| MP4-08 | Offer original size, 256/512/1024 square presets, and custom width and height from 16 to 4096 pixels. | Implemented. |
| MP4-09 | Never squeeze or stretch the content when output and source ratios differ. | Implemented via proportional crop or proportional scale with transparent padding. The crop editor's fixed frame follows the output ratio. |
| MP4-10 | Move the source image within the fixed crop frame and zoom it; show the chosen crop without the frame outside edit mode. | Implemented. Cropping parameters are applied to preview and export. |
| MP4-11 | Move and zoom the **transparent foreground** from 0.5× to 2× independently of the optional preview background. | Implemented. The foreground transform is included in export; the background is preview-only. |
| MP4-12 | Show checkerboard transparency or a user-supplied background in the preview, never in the export. | Implemented. |
| MP4-13 | Choose/validate an output directory, save directly there, show the saved path, and open that folder. | Implemented. Windows has a native folder picker; an absolute path can be entered manually. |
| MP4-14 | Show conversion progress, current filename, and FFmpeg errors; retain the original MP4 on failure. | Implemented. Temporary job files are removed after use or expiry. |
| MP4-15 | Allow the source list and settings panel to collapse and the settings panel to resize. | Implemented; settings width is saved in browser local storage. |

### Scope and constraints

- No batch-convert action. Multiple selected files are a queue of independent editing sessions, not a shared-settings batch.
- The export has no audio. The optional background image is never composited into the WebP.
- Color keying quality depends on the source. Similarity and Feather are intended for per-file visual tuning.
- The tool is a local browser app, not an Electron installer. Node.js and FFmpeg are runtime requirements.

## 2. Technical design (TDD)

### Architecture

```text
WorkbenchApp.tsx  →  #chroma route and top navigation
chroma/ChromaPage.tsx  →  per-file UI state, timeline, crop/foreground editing,
                          browser media playback, preview caching, job polling
chroma/chroma.css  →  layout, preview checkerboard, crop frame and controls
chromaPlugin.ts  →  mounts /api/chroma in Vite dev and preview servers
chroma/server.mjs  →  local HTTP endpoints, jobs, upload limits, cleanup
chroma/config.mjs  →  validated conversion settings and FFmpeg filter graph
chroma/ffmpeg.mjs  →  FFprobe, one-frame PNG keying, WebM preview, WebP encoding
chroma/files.mjs + chroma/shell.mjs  →  output naming, directory validation,
                                        Windows folder picker/reveal
```

`ChromaPage` holds each `File` object in the browser. A map keyed by that object stores its editing profile; another map stores its selected frame interval. It is session state, not durable media storage. The only persisted UI value is the resizable settings-panel width. The selected file is read by the browser video element for frame selection; a full conversion streams it to the local Node process.

### Video pipeline

The conversion config includes `color`, `similarity`, `blend`, `fps`, `size`, optional custom `width/height`, `squareMode`, `cropScale`, `cropX/cropY`, foreground transform, inclusive `startFrame/endFrame`, and `sourceFps`. `parseConfig` bounds these values before FFmpeg receives them.

For a single-frame preview, the browser captures the requested source frame as PNG and posts it to `/api/chroma/preview`. FFmpeg reads that PNG from a pipe, applies the same key/crop/sizing filters as export, and returns a PNG with alpha. The CSS checkerboard or uploaded preview background sits behind the resulting image.

For interval preview/export, the browser creates a job, uploads only the selected MP4 to the local service, polls progress, and reads the result. The filter graph trims the inclusive source frame range, resets timestamps, converts to RGBA, applies `colorkey=0xRRGGBB:similarity:blend`, changes FPS, applies sizing, applies optional foreground placement, and ends as RGBA. The temporary interval preview uses VP9 WebM with alpha; the export uses lossless `libwebp_anim` with infinite looping. The preview is cached against a signature of the conversion and interval settings, so unchanged replay and scrubbing do not restart FFmpeg. The foreground transform is applied in the preview display and in the export filter graph.

For crop mode, `cropGeometry` computes a crop matching the requested output ratio at the selected scale and position. FFmpeg then proportionally scales to cover the target and crops any rounding excess. The edit overlay renders the original image with one zoom factor on both axes; its white frame is sized from the same source crop geometry. For padding mode, FFmpeg proportionally scales to fit and adds transparent margins. Neither path deliberately applies separate horizontal and vertical scaling to content.

### File lifecycle and local access

Jobs use a directory under the OS temporary folder. The uploaded `source.mp4` is deleted when FFmpeg completes or fails. Completed job outputs are deleted when the job is removed or expires after one hour; a later server start also clears expired job directories. The selected user MP4 is never deleted or overwritten. The final WebP is written to the validated chosen directory, with a numeric suffix if the base name exists. Directory, save, and reveal endpoints require a local request header; the service is mounted on the local Vite server.

The current server accepts MP4 uploads up to 1 GB and captured PNG previews up to 20 MB. FFmpeg's stderr is returned on conversion failure. The app expects FFmpeg and FFprobe on `PATH`, or paths supplied through `FFMPEG_PATH` and `FFPROBE_PATH`.

### Main local API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/chroma/preview` | Key one PNG frame and return a transparent PNG. |
| `GET/POST /api/chroma/output-directory` | Read the default folder or validate a selected folder. |
| `POST /api/chroma/pick-directory` | Open the Windows native folder picker. |
| `POST /api/chroma/open-directory` | Open a validated folder. |
| `POST /api/chroma/save` | Save a WebP into the selected directory. |
| `POST /api/chroma/reveal` | Reveal a saved result in its containing folder. |
| `POST /api/chroma/jobs` | Create a conversion or interval-preview job. |
| `PUT /api/chroma/jobs/:id/source` | Stream the selected MP4 into the temporary job. |
| `GET /api/chroma/jobs/:id` | Poll status, progress, and errors. |
| `GET /api/chroma/jobs/:id/output` | Read the WebM preview or WebP result. |
| `DELETE /api/chroma/jobs/:id` | Cancel/clean up the temporary job. |

## 3. Verification and regression checklist

1. Load two MP4 files. Give them different key, crop, trim, output size, and output folder settings; switching files must restore each profile. Convert one and confirm the other has no output.
2. With a 1280×720 source, select 720×720 and 400×600 output. The fixed white crop frame must have the respective ratio while the source picture retains 16:9; outside edit mode, the chosen crop must fill the source pane without an overlay.
3. Drag and zoom the crop, scrub source and output frames, set an interval with both handles, and use the first/last frame jump buttons. Check that exported frames match the selected interval and crop.
4. Play the source interval without first generating an output preview. Generate an output preview, scrub it, replay unchanged settings without a new job, then change a key or crop setting and confirm regeneration.
5. Add and remove a preview background. Move and zoom the transparent foreground. Check that only the foreground transform reaches export, and inspect the WebP alpha rather than judging only from the checkerboard UI.
6. Save to a non-default directory, verify the actual path, open that folder, and repeat the name to confirm a safe numeric suffix. Confirm failures show FFmpeg stderr and never alter the source MP4.
7. Run `npm test`, `npx tsc --noEmit`, `npm run build`, and `node scripts/smoke-chroma.mjs` with FFmpeg installed. Browser interaction and visual crop geometry require a manual UI check in addition to automated tests.

## 4. Known limitations

- Editing profiles and preview media are lost when the page reloads. Only the settings-panel width persists.
- Source-frame addressing uses a user-editable FPS value; variable-frame-rate footage may not align perfectly with every nominal frame number.
- WebM transparency playback depends on browser support. The final WebP is encoded separately.
- Native folder selection and reveal currently target Windows; other systems can provide an existing absolute path for output.
- FFmpeg chroma keying cannot reconstruct source pixels that have the same color as the background.
