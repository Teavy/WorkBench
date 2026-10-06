# MP4 BG Removal — Technical Design (TDD)

> Baseline: 2026-10-03; persistent frame-project design added on 2026-10-04; editor interaction details updated on 2026-10-06. See [product requirements](PRD.md) and [verification](verification.md).

## Architecture

```text
WorkbenchApp.tsx  →  #chroma route and top navigation
chroma/ChromaPage.tsx  →  per-file UI state, output preview, crop/foreground editing,
                          browser media playback, preview caching, job polling
chroma/chroma.css  →  layout, preview checkerboard, crop frame and controls
chromaPlugin.ts  →  mounts /api/chroma in Vite dev and preview servers
chroma/server.mjs  →  local HTTP endpoints, jobs, upload limits, cleanup
chroma/config.mjs  →  validated conversion settings and FFmpeg filter graph
chroma/ffmpeg.mjs  →  FFprobe, one-frame PNG keying, WebM preview, WebP encoding
chroma/files.mjs + chroma/shell.mjs  →  output naming, directory validation,
                                        Windows folder picker/reveal
chroma/FrameEditor.tsx  →  selected file's frame timeline and slot editing
chroma/SingleFrameEditor.tsx  →  per-slot image, mask, selection, and view tools
chroma/useOutputMask.ts  →  shared global/per-slot mask painting and undo stack
chroma/frameProjects.mjs  →  project files, PNG extraction, frame rendering,
                             WebP/PNG/atlas export
```

`ChromaPage` loads the saved project list into the left panel. Each entry has a stable local project ID, saved MP4, profile, range, and optional preview background. Only the selected source is loaded into a browser `File`; the other entries remain lightweight placeholders. Profile changes are cached immediately in browser storage and written to the local project profile endpoint. The bottom editor receives only the selected ID, so it cannot display another file's frame copy.

`ChromaPage` also owns the right output preview's Original/Edited switch, playback state, frame counter, and scrubber. Edited playback state is passed to `FrameEditor`, so starting or pausing in either surface updates the other. Seeking an Edited frame sends a preview request to the bottom editor, which keeps the timeline selection and right preview aligned. Original playback uses the immutable generated order. Switching orders stops playback without changing the independently selected export order.

Each uploaded source MP4 stores its byte length and SHA-256 fingerprint in `project.json`. Listing older projects backfills the fingerprint while their source is present. If `source.mp4` is missing, the list exposes a Relink action. The candidate is streamed into a temporary file, checked against both the saved length and SHA-256, probed as video, and installed under the original project ID. A renamed but byte-identical file is accepted. A mismatch is removed without changing the project, its frame pool, edits, profile, or mask. Projects already missing their source before a fingerprint was stored cannot be verified through this flow.

## Video pipeline

The conversion config includes `color`, `similarity`, `blend`, `fps`, `size`, optional custom `width/height`, `squareMode`, `cropScale`, `cropX/cropY`, foreground transform, inclusive `startFrame/endFrame`, and `sourceFps`. `parseConfig` bounds these values before FFmpeg receives them.

For a single-frame preview, the browser captures the requested source frame as PNG and posts it to `/api/chroma/preview`. FFmpeg reads that PNG from a pipe, applies the same key/crop/sizing filters as export, and returns a PNG with alpha. The CSS checkerboard or uploaded preview background sits behind the resulting image.

For interval preview, the browser creates a temporary job, uploads the selected MP4 to the local service, polls progress, and reads a VP9 WebM with alpha. The filter graph trims the inclusive source frame range, resets timestamps, converts to RGBA, applies `colorkey=0xRRGGBB:similarity:blend`, changes FPS, applies sizing and optional global foreground placement, and ends as RGBA. The preview is cached against a signature of the conversion and interval settings, so unchanged replay and scrubbing do not restart FFmpeg. Exports use the PNG-frame project pipeline described below; WebP encoding uses lossless `libwebp_anim` with infinite looping.

For crop mode, `cropGeometry` computes a crop matching the requested output ratio at the selected scale and position. FFmpeg then proportionally scales to cover the target and crops any rounding excess. The edit overlay renders the original image with one zoom factor on both axes; its white frame is sized from the same source crop geometry. For padding mode, FFmpeg proportionally scales to fit and adds transparent margins. Neither path deliberately applies separate horizontal and vertical scaling to content.

## File lifecycle and local access

Preview jobs use a directory under the OS temporary folder. Their temporary `source.mp4` is deleted when FFmpeg completes or fails. Completed preview outputs are deleted when the job is removed or expires after one hour; a later server start also clears expired job directories. The separately saved project copy of an uploaded MP4 persists until the user removes that left-list entry after confirmation. The original user MP4 is never deleted or overwritten. Exports use the validated chosen directory and a numeric suffix if the name exists. Save and project-write endpoints require a local request header; the service is mounted on the local Vite server.

The current server accepts MP4 uploads up to 1 GB and captured PNG previews up to 20 MB. FFmpeg's stderr is returned on conversion failure. The app expects FFmpeg and FFprobe on `PATH`, or paths supplied through `FFMPEG_PATH` and `FFPROBE_PATH`.

### Persistent frame projects

Local file projects live in the user's application-data directory (`%LOCALAPPDATA%\Codex Workbench\Chroma Projects` on Windows; the XDG data directory or `~/.local/share/codex-workbench/chroma-projects` elsewhere), or under `CHROMA_PROJECT_DIR` when set. Upload creates a project ID and saves `source.mp4` immediately. `profile.json` stores per-file controls and source range; an optional `background` asset stores the preview image. Frame generation later writes numbered transparent PNGs and an initially full slot list into that same project. `frameCount` stays equal to the source PNG pool size; `slots.length` is the edited animation's frame count and can shrink after deletion. Each slot references a source PNG or `null` and may carry a per-slot `edit` object with normalized x/y offset, zoom, and an optional mask ID. Refresh restores the saved list and last selected ID.

FFmpeg applies the existing trim, key, FPS, sizing, and global foreground filters to generate the PNG pool. Export accepts an order parameter: `original` reads the immutable numbered PNG pool; `edited` reads the current slot list, where `null` becomes a fully transparent image. Individual PNG export copies numbered frames into a new folder. WebP encodes the selected sequence at the project's FPS, so deleted edited slots reduce its duration by one frame interval each. Atlas uses row-major tiling with a user-selected row count based on the selected order's frame count and transparent trailing cells. Every export uses the right panel's current output folder and leaves source MP4 and PNG pool intact. When the selected file has no generated frame copy, original-order export uses a temporary hidden project for encoding and then removes it; the saved left-list entry remains intact.

The output mask is a separate `output-mask.png` in the selected file project, with white/opaque pixels preserving output and transparent pixels erasing it. The browser paints on an output-resolution canvas in `Adjust > Mask`; the same PNG alpha masks the foreground wrapper in the right preview after the foreground transform. Brush strokes are saved to the local project endpoint and reloaded on refresh. During export, FFmpeg scales that mask to output resolution and multiplies each rendered frame's alpha by its alpha channel before WebP encoding, PNG copying, or atlas tiling. This postprocess also handles direct Original exports made through a temporary frame project by pointing export at the selected file's mask. Generated source PNGs and the preview background are unchanged. Replacing the source MP4 removes its old mask.

`Adjust > Position` stores Move activation as temporary UI state. The output-stage drag layer is mounted only when Position and Move are both active; switching to Mask or Export disables it. Its cursor is `move`. The output mask's `Show mask` control changes only the red preview overlay, while Erase and Restore share the same output-resolution brush canvas and undo history. The global Mask key listener is active only in that panel: bracket keys change brush size by 4 px within its existing bounds, and Ctrl+Z invokes the same undo operation as the button. It ignores text-entry fields and yields to an open single-frame editor.

The single-frame editor stores its settings on the edited slot. Per-slot masks are immutable PNG assets in `frame-masks/`, named by SHA-256; copying a slot can initially share the asset because any later mask stroke creates a new asset ID. The browser reuses the output-mask brush implementation and paints in output-canvas coordinates. The edited frame's image is transformed first, then its fixed per-slot mask is applied; the global output mask applies afterward to all frames. The right preview and timeline thumbnail use the same saved slot settings. During Edited export, `renderSlot` applies transform and per-slot mask before the existing global-mask and format stages. Original export bypasses per-slot edits. Reordering and delete/undo carry the whole slot object; source replacement clears its edit. Regenerating or replacing the source clears the frame-mask directory and slot list. Blend generation renders edited endpoints before mixing them.

Single-frame lasso and polygon points are held in output-canvas coordinates while the modal is open. Closing a path rasterizes it to an alpha coverage array; the same coverage clips subsequent brush strokes and drives one-step Erase selected or Restore selected operations. These operations use the existing mask PNG, preview refresh, save queue, and undo stack. The outline and selection coverage are editor-only state and are discarded when the slot editor closes or navigates to another slot.

The single-frame editor's keyboard handler routes Ctrl+Z to its per-slot mask undo while a brush or selection tool is active; it leaves text-entry undo alone. Both mask canvases hide the browser's fixed-size crosshair and draw a reticle on the circular brush preview. Its arms are at most 40% of the displayed brush diameter, capped at 8 CSS px, so shrinking the brush also shrinks the reticle. The editor's Space/middle-button pan keeps its hand cursor and does not paint.

Loop blend works on the current edited slot list of length N with overlap K, where 1 ≤ K ≤ min(60, floor((N−1)/2)). Its new list is slots K through N−K−1 followed by K blends of slots N−K+j and j, with head weight `(j+1)/(K+1)`. FFmpeg premultiplies RGBA before mixing and unpremultiplies afterward to avoid dark transparent edges. Generated blend PNGs are stored under `frames/derived`; `blendFrameCount` assigns persistent frame IDs above the original `frameCount`. Existing preview and all three export paths resolve those IDs without changing the immutable source pool. A saved `loopBlendUndo` slot snapshot permits one undo; any subsequent slot edit clears it. Regenerating the PNG pool removes derived files and resets the edited list.

Selected-pair blend reuses the same alpha-aware renderer. Two selected slot indices A < B and K between 1 and 60 produce K blends of the endpoint images at weights `(j+1)/(K+1)`. These derived slots are inserted after A, preserving every existing slot and increasing duration by K/FPS. Ctrl-click allows nonadjacent endpoint selection; when A and B are adjacent, the new transition directly connects them. `blendUndoCount` records the number of derived images created by either blend operation so undo removes only those images, including when the sequence grew rather than shrank.

## Main local API

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
| `GET/POST /api/chroma/projects` | List saved files or create one local entry. |
| `GET/PATCH /api/chroma/projects/:id` | Read project state or save frame slots. |
| `DELETE /api/chroma/projects/:id` | Remove a temporary export project; `?permanent=1` removes a user-confirmed saved entry. |
| `PUT/GET /api/chroma/projects/:id/source` | Save/read the selected MP4. New uploads defer PNG generation. |
| `PUT /api/chroma/projects/:id/relink-source` | Restore a missing source MP4 only when its bytes match the saved fingerprint. |
| `GET/PUT /api/chroma/projects/:id/profile` | Read/save the file's controls and range. |
| `PUT/GET/DELETE /api/chroma/projects/:id/background` | Save/read/remove the preview-only background. |
| `PUT/GET/DELETE /api/chroma/projects/:id/mask` | Save/read/remove the selected file's global output mask. |
| `POST /api/chroma/projects/:id/frame-masks` | Save one output-sized per-slot mask PNG and return its content hash. |
| `GET /api/chroma/projects/:id/frame-masks/:hash` | Read a saved per-slot mask asset. |
| `POST /api/chroma/projects/:id/generate` | Generate or regenerate transparent frames for that same file ID. |
| `POST /api/chroma/projects/:id/loop-blend` | Generate K premultiplied-alpha crossfades and shorten the edited sequence. |
| `POST /api/chroma/projects/:id/between-blend` | Insert K blended frames after the earlier of two selected edited slots. |
| `POST /api/chroma/projects/:id/undo-loop-blend` | Restore the edited slots captured immediately before the most recent blend. |
| `GET /api/chroma/projects/:id/frames/:number` | Read a generated source PNG. |
| `POST /api/chroma/projects/:id/export` | Export original or edited order as WebP, numbered PNG files, or PNG atlas. |
