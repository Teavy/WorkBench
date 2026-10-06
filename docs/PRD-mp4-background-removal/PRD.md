# MP4 BG Removal — Product Requirements (PRD)

> Baseline: 2026-10-03; frame-project extension added on 2026-10-04; editing interaction decisions updated on 2026-10-06. The first requirements table records the original implementation status. MP4-16–MP4-29 cover the frame workflow and later editing controls. See [technical design](TDD.md) and [verification](verification.md).

MP4 BG Removal is the local green-screen removal module in Codex Workbench. It turns an AI-generated MP4 into a transparent, infinitely looping Animated WebP for animated UI frames and similar assets. Both the outer background and a green center must become transparent. The user can inspect a single frame before spending time encoding the selected interval.

The module runs in a local browser with a local Node.js process and FFmpeg/FFprobe. It does not upload media to an internet service. The left list is the single source of project selection. Every uploaded MP4 is saved locally with its own settings and optional edited frame sequence; only the selected entry is previewed, edited, or exported.

## User flow

1. Drop or select one or more MP4 files, then select a file from the list.
2. Scrub the source timeline, set its start and end handles, and play the selected source interval to locate a useful segment.
3. Set the key color, Similarity, and Blend/Feather. Inspect the processed single frame or generate a transparent interval preview.
4. Choose original, square preset, or custom output dimensions. Use proportional crop or proportional scale with transparent padding. Adjust the crop in the fixed frame and optionally move or zoom the transparent foreground.
5. Choose an existing output folder and convert the **current** file. Inspect the saved path and open its folder.

## Functional requirements and acceptance behavior

| ID | Requirement | Current behavior |
| --- | --- | --- |
| MP4-01 | Select/drop several MP4 files, select one for editing, and remove files without changing the source files. | Implemented. Only the current file converts. |
| MP4-02 | Keep key, trim, crop, size, FPS, foreground placement, preview background, and output folder independent per file across page refresh and app restart. | Implemented with a saved profile and background asset beside each locally saved MP4. |
| MP4-03 | Default key color `#00FF00`; adjustable Similarity and Blend/Feather. | Implemented with FFmpeg `colorkey`. Defaults: Similarity `0.27`, Blend `0.08`. |
| MP4-04 | Inspect a source frame and its transparent result without a full video conversion. | Implemented by sending a browser-captured PNG frame to local FFmpeg. |
| MP4-05 | Select an inclusive source-frame interval with two timeline handles, jump to its endpoints, and play that source interval directly. | Implemented. Source FPS defaults to 30 and is editable for frame addressing. |
| MP4-06 | Preview the processed interval and scrub individual output frames. Reuse an unchanged preview. | Implemented with a temporary transparent WebM cached in browser memory; a changed key, trim, crop, size, or FPS invalidates it. |
| MP4-07 | Export transparent Animated WebP with infinite looping, default output FPS 20, and a source-based filename. | Implemented with `libwebp_anim`, lossless encoding, RGBA, and loop count `0`. Existing filenames get a numeric suffix. |
| MP4-08 | Offer original size, 256/512/1024 square presets, and custom width and height from 16 to 4096 pixels. | Implemented. |
| MP4-09 | Never squeeze or stretch the content when output and source ratios differ. | Implemented via proportional crop or proportional scale with transparent padding. The crop editor's fixed frame follows the output ratio. |
| MP4-10 | Move the source image within the fixed crop frame and zoom it; show the chosen crop without the frame outside edit mode. | Implemented. Cropping parameters are applied to preview and export. |
| MP4-11 | Move and zoom the **transparent foreground** from 0.5× to 2× independently of the optional preview background. In `Output Edit > Adjust > Position`, selecting Position alone must not enable dragging: the user first activates Move, which shows a four-way move cursor. Leaving Position or Output Edit disables Move. | Implemented. The foreground transform is included in export; the background is preview-only. |
| MP4-12 | Show checkerboard transparency or a user-supplied background in the preview, never in the export. | Implemented. |
| MP4-13 | Choose/validate an output directory, save directly there, show the saved path, and open that folder. | Implemented. Windows has a native folder picker; an absolute path can be entered manually. |
| MP4-14 | Show conversion progress, current filename, and FFmpeg errors; retain the original MP4 on failure. | Implemented. Temporary job files are removed after use or expiry. |
| MP4-15 | Allow the source list and settings panel to collapse and the settings panel to resize. | Implemented; settings width is saved in browser local storage. |

## Frame-project extension: transparent frames and frame animation editor

MP4-16–MP4-29 are represented in the current working tree. MP4-25 supports reopening intact saved projects and restoring a missing source MP4 by selecting the identical file, even after it is renamed. Recovery of missing generated or derived PNG assets remains open. These requirements do not change the original direct-conversion behavior of MP4-01–MP4-15 above.

### Workflow and layout

1. After choosing the source interval, output FPS, key, and output dimensions, the user generates transparent PNG frames. The generated frame count follows the selected source interval and output FPS. Every generated frame initially occupies one frame slot in time order.
2. A Photoshop-like frame animation timeline occupies a dedicated area across the bottom of the page, below the existing file list, live frame preview, and settings/export columns. The user selects and edits frame slots there. The bottom area grows to show its controls and status without vertical scrolling; the frame strip scrolls horizontally, including by using a vertical mouse wheel while hovering over it. The source interval controls remain separate from this new editing timeline.
3. The existing final-effect output preview, to the right of the source frame, stays in place. When a saved frame project exists, it defaults to edited order and offers a separate Original/Edited switch. Both orders have direct Play/Pause and a frame scrubber. Edited playback, frame counter, scrubber, and bottom-timeline selection stay synchronized whether playback starts in the bottom editor or the output preview. The user can switch orders without changing export settings. The bottom editor has no second large preview canvas.
4. The bottom timeline edits only the file currently selected in the left list. It has no separate project picker. It can be closed and reopened without losing the edited copy; the right preview's Original/Edited switch controls which order is displayed. The timeline has no inline per-frame position or zoom controls; those controls are in the single-frame editor.

### Frame-slot behavior

| ID | Planned requirement and acceptance behavior |
| --- | --- |
| MP4-16 | Generate a transparent PNG frame pool from the selected MP4 interval. Populate the bottom timeline with every generated frame in its original order; do not require manual selection to create the initial animation. |
| MP4-17 | Keep the generated source PNG pool intact. The edited timeline starts with one slot per generated frame. Deleting an edited slot reduces its count and duration; the most recent deletion can be undone. Inserting an empty slot before or after the selected frame increases count and duration. Output FPS gives every slot the same playback time; clearing, moving, replacing, or assigning a slot does not change its count. Do not provide per-frame duration controls. |
| MP4-18 | Clear a slot without deleting it. Its thumbnail becomes an empty slot with a `+` action; all export formats render that slot as a fully transparent frame for its normal playback time. |
| MP4-19 | Drag a frame tile to change slot order without changing count. Shift-click selects a continuous range; dragging a selected range moves it as a group in the same internal order. A selection of at least two slots can be reversed in place. The original source order remains intact. The timeline offers previous-frame, play/pause, and next-frame icon controls. Each tile shows its source image ID above and its timeline slot number below; a small cue distinguishes adjacent slots whose original source image numbers are not consecutive. |
| MP4-20 | Replace an occupied slot, or assign an empty slot through its `+` action, by opening a chooser containing all generated transparent PNG source frames. The chooser distinguishes source PNGs unused by the edited timeline, used once, and used multiple times, with counts and filters. The same source frame may be assigned to multiple slots. When multiple slots are selected, replace, clear, and delete apply to the selection. Ctrl+C copies the selected slots, including empty slots; Ctrl+V inserts those copies in order immediately after the active frame. The toolbar explains these shortcuts and has no separate Copy/Paste buttons. Keyboard shortcuts apply only while the timeline or its toolbar has focus, and copied slots belong to the current file. |
| MP4-21 | In the initial frame-timeline version, only slot order and source-frame assignment are editable. Per-frame position and zoom belong to the later single-frame editor, not the inline timeline controls. |
| MP4-26 | Offer a loop blend on the edited sequence. The user chooses K head/tail frame pairs; the app crossfades each corresponding tail and head frame, replaces those 2K slots with K transition slots, and shortens playback by K / output FPS. The original sequence and source PNG pool remain unchanged. Show the new count/duration in the timeline and right export panel, preview transition frames in the existing output preview, and allow the blend to be undone until the next edit. WebP, individual PNG, and atlas exports all use the blended frames when Edited is selected. |
| MP4-27 | Allow two specified slots anywhere in the edited timeline to be selected with Ctrl-click (or two adjacent slots with Shift-click). The user chooses 1–60 transition frames; pairwise crossfades of those two endpoint images are inserted immediately after the earlier selected slot. Existing slots remain in order and edited duration increases by inserted count / output FPS. Adjacent endpoints form a direct transition. Preview and all Edited exports include the inserted frames. The most recent blend can be undone until another edit. |

### Exports and project recovery

| ID | Planned requirement and acceptance behavior |
| --- | --- |
| MP4-22 | Offer Original/Edited export order and WebP/individual PNG/PNG atlas format together in the right settings panel. Original order works without creating an editor project. PNG files go into their own new folder under the chosen output folder. |
| MP4-23 | For PNG atlas, the user specifies rows; columns are `ceil(selected-order frame count / rows)`. For 20 frames, 4 rows produce 4 × 5 and 5 rows produce 5 × 4. Unused trailing cells remain transparent. |
| MP4-24 | Animated WebP uses the chosen output FPS. Empty edited slots play as transparent frames for their normal time, while deleted edited slots shorten the animation. Original-order export retains the full generated duration. |
| MP4-25 | Save enough project data locally to reopen after refresh or restart: source media, settings, original PNG pool, edited slot assignments/order, and empty slots. If the saved source MP4 is missing, allow the user to choose an identical MP4 and verify it by SHA-256 regardless of its filename, without discarding frame edits. Recovery of missing generated or derived PNG assets remains a follow-up. |
| MP4-28 | In the existing right output preview, `Adjust` offers a global Mask mode. The user paints with a size-adjustable hard-edge or soft-edge brush to erase unwanted areas, can paint them back with Restore, undo recent strokes, or reset the mask. Erase and Restore have distinct icons; `Show mask` toggles a translucent red guide. While Mask is active, `[` and `]` change brush size by 4 px within its limits, and Ctrl+Z undoes the latest mask stroke. The brush cursor uses a center reticle shorter than its circular footprint, including at the minimum brush size. The mask stays in output-frame coordinates, persists with the selected file after refresh, and applies to every frame in both Original and Edited preview/export. It affects WebP, individual PNG, and PNG atlas output, while leaving source PNG frames and the preview-only background unchanged. |

### Single-frame editor

| ID | Requirement and acceptance behavior |
| --- | --- |
| MP4-29 | Edit one **edited-timeline slot** without changing its generated source PNG. Single click continues to select a slot; double-click or the `Edit this frame` action opens a larger editor. The editor offers position, zoom, a per-slot mask with the same Erase/Restore, edge, brush size, undo-stroke, and reset controls as the global mask, and translucent previous/next edited slots as onion skin. Save changes commits this slot; Cancel discards them. Reusing one source PNG in several slots permits independent edits. Original preview/export remains unchanged, while Edited preview and WebP, individual PNG, and atlas exports show the slot edit. Onion skin is an editor-only guide. |

The per-slot edit is saved with its timeline slot, so it follows reordering. Copying a slot copies its current edit as an independent starting point. Clearing or replacing its source frame clears its edit. Deleting and undoing a slot restores its edit. Regenerating the PNG pool clears per-slot edits. Blend generation uses the currently edited appearance of its endpoint slots.

The per-slot mask is fixed to the output canvas, just like the global Output Edit mask. Moving or zooming the slot's image does **not** move or scale its mask: a painted spot stays at the same canvas coordinate and erases whatever part of that slot's image is underneath after the image transform. For example, after painting at the canvas center, moving the image right leaves the painted spot at the center. The global Output Edit mask remains a separate, all-frame mask. The per-slot mask and the global mask both apply to the final frame; restoring a spot in one mask cannot undo erasure by the other mask.

The editor's Save changes action commits the position, zoom, and mask together; Previous and Next save the current frame before changing slots. Cancel does not change the slot. A saved edit can be reopened for further changes or reset. Onion skin uses adjacent edited-timeline slots, with independent previous/next visibility and an opacity control.

Both onion-skin layers start hidden. The editor offers three preview background modes: the selected file's preview-only background image, a checkerboard showing transparent pixels, or a solid color. Solid-color presets are black, white, gray, green screen, and magenta. The image mode can display the background at its original pixel size or fitted to the canvas. Background mode, solid color, and image sizing are remembered for the same project across edited slots and editor reopenings. Its header shows the canvas dimensions in CSS pixels and the percentage relative to the output size; Show at 100% switches to actual-size viewing, while Fit window restores the responsive view. A Show mask toggle in the preview header stays available with every editing tool. When enabled, the editor draws translucent red mask marks over the unmasked source frame so image details remain visible beneath them; hiding the guide shows the actual erased transparency. These display controls do not change the saved frame or exports.

The editor also has a separate view magnifier. Zooming the view enlarges the canvas content inside a fixed-size preview window, with horizontal and vertical scrolling; it does not change the saved image zoom or position. A persistent vertical tool rail offers Move (V) to drag the frame image, Hand (H) to pan the canvas, Erase (E) to paint away this slot, and Restore (R) to paint it back. Selecting a tool directly exposes its position or mask settings without first switching tabs. Hand is initially selected to avoid accidental frame edits. The mask settings show a live brush thumbnail with edge softness and size. While Erase or Restore is active, `[` decreases the brush size by 4 px and `]` increases it by 4 px, within the existing size limits; the controls and thumbnail update immediately. Ctrl+Z undoes the latest per-slot mask stroke. The brush cursor's center reticle stays shorter than its circular footprint, so a small brush remains visible. Holding Space temporarily pans the canvas from any tool; middle-mouse drag also pans. The view magnifier and panning do not affect exports.

The same tool rail offers a freehand lasso (L) and a polygon selection (P) for the single-frame mask. Drag to trace a lasso; click polygon corners and close it by clicking near the first point, double-clicking, pressing Enter, or using Close polygon. Polygon vertices are not marked with circles; while drawing, right-click removes the most recent vertex. The browser context menu is suppressed while the single-frame editor is open. A dashed outline remains visible when switching tools. Erase selected and Restore selected apply the region to this slot's mask in one undoable operation; Ctrl+Z can undo that applied mask change while a selection tool is active. Erase and Restore brushes paint only inside an active selection. Deselect, Esc, or Ctrl+D removes the selection without changing the mask. Selections are temporary editing guides; only applied mask pixels are saved and exported.

### Current behavior and follow-up details

- Atlas traversal is left to right within each row, then top to bottom. Unused trailing cells are transparent. No separate atlas metadata file is exported; the project retains the actual slot count.
- The right preview and export order switches are independent. A saved project defaults both to edited order when opened. Original frames remain available even after editing. The preview surface does not edit individual frame content; `Adjust > Mask` paints one global output mask for the selected file.
- Each left-list entry stores its MP4, profile, optional preview background, and optional generated PNG pool in the user's local application-data directory, or `CHROMA_PROJECT_DIR` when configured. Refresh restores the list and last selected entry; only that entry's MP4 is loaded into browser memory. The bottom editor automatically follows the selected entry.
- Generating frames again for the same file replaces its edited sequence after confirmation. It does not create a second project-picker entry.
- If the saved source MP4 is moved or deleted outside the app, the left list marks it missing and offers Relink. The selected replacement must match the saved SHA-256 fingerprint; its filename may differ. The original project name, settings, frame slots, PNG pool, and mask remain intact. Existing projects receive a fingerprint when they are listed while their source is still present; a legacy project whose source was already lost before fingerprinting cannot be verified automatically.
- Missing generated or derived PNG assets do not yet have an in-app repair flow. This remains a gap in MP4-25's recovery behavior.

## Scope and constraints

- No batch-convert action. Multiple selected files are a queue of independent editing sessions, not a shared-settings batch.
- The export has no audio. The optional background image is never composited into the WebP.
- Color keying quality depends on the source. Similarity and Feather are intended for per-file visual tuning.
- The tool is a local browser app, not an Electron installer. Node.js and FFmpeg are runtime requirements.

## Known product limitations

- Temporary WebM preview media is regenerated after reload. Saved MP4 files, settings, backgrounds, and edited frame sequences persist.
- Source-frame addressing uses a user-editable FPS value; variable-frame-rate footage may not align perfectly with every nominal frame number.
- WebM transparency playback depends on browser support. The final WebP is encoded separately.
- Native folder selection and reveal currently target Windows; other systems can provide an existing absolute path for output.
- FFmpeg chroma keying cannot reconstruct source pixels that have the same color as the background.
