# Codex Workbench

Module requirements and technical design: [View Synthesizer PRD + TDD](docs/view-synthesizer-prd-tdd.md) · [Workflow Canvas PRD + TDD](docs/workflow-canvas-prd-tdd.md) · [MP4 BG Removal PDR + TDD](docs/mp4-background-removal-pdr-tdd.md).

The local app has three modules, selected from the top navigation:

- **View Synthesizer** keeps the existing camera-view image-editing workflow.
- **Workflow Canvas** is an early local-first node canvas. It supports text, planned GPT-text and planned image nodes, typed ports, multiple incoming and outgoing connections, node dragging, canvas panning/zooming, and automatic browser-local saving. GPT login/inference and image generation are **not connected yet**; the canvas does not return simulated AI results. There is no video node.
- **MP4 BG Removal** converts the currently selected green-screen MP4 to a transparent, infinitely looping Animated WebP. It has a fast single-frame keying preview and independent settings for each selected file.

## MP4 BG Removal: MP4 → Animated WebP

### Requirements

- Node.js 20.19+ and npm.
- FFmpeg and FFprobe available on `PATH`. On Windows, download an FFmpeg build from [ffmpeg.org](https://ffmpeg.org/download.html), extract it, add its `bin` folder to `PATH`, then verify `ffmpeg -version` and `ffprobe -version` in a new terminal. On macOS, `brew install ffmpeg`; on Debian/Ubuntu, `sudo apt install ffmpeg`.
- On Windows, **Browse folders** opens a native folder dialog through the local Node process. On other systems, enter an existing absolute folder path manually.

Run `npm install`, then `npm run dev`. Open `http://127.0.0.1:3000/#chroma`. Drag in MP4 files or select several at once. Select one MP4 to edit it. Its key color, Similarity, Blend, source and output FPS, crop, output size, frame range, and output folder are kept separately from the other MP4 files in the current session. Click **Convert current file** to convert only the selected MP4. **Keep original size** preserves the source dimensions. **Custom dimensions** accepts integer dimensions from 16 to 4096 pixels; crop and transparent padding keep the source image's proportions.

For square or custom output from a source with a different aspect ratio, select **Crop to output ratio** in the compact bar above the previews to crop a matching region before scaling. Click **Edit crop**, drag the image inside the fixed white frame to position it, and use the zoom slider or reset button as needed. After editing, the source preview fills its pane with the selected crop, without a frame overlay; source playback also uses this crop. The output preview updates after each drag. **Scale to fit + transparent padding** keeps the entire frame with transparent margins instead. Neither mode stretches the picture.

Use **Adjust** below the output preview to move the transparent foreground independently of the optional background image. Drag the foreground in the output pane and adjust its zoom from 0.5× to 2×. This placement is applied to the exported Animated WebP; the preview background is never exported.

The timeline below the source video has two white draggable handles for the included start and end frames, a green playhead for the currently inspected source frame, and a highlighted export interval. Click the track to inspect a source frame, or use its first and last frame buttons. The output pane has a separate frame-by-frame slider limited to that interval; it previews a keyed output frame without moving the source preview. **Follow source frame** reconnects the output preview to the source playhead. Source FPS and output FPS are edited together in the right settings panel. The default interval is the full video, and intervals are kept separately for each MP4. **Play source interval** under the left source frame loops the selected clip immediately in the browser, without FFmpeg conversion. **Play preview** builds a temporary transparent WebM preview with the same FFmpeg keying, trim, FPS, and sizing settings as the export. The preview stays cached in browser memory so the output slider can seek through it and playback can restart without reconversion. Changing a conversion setting or interval invalidates the cache. The source list and settings panel can be collapsed to give both previews more room. Drag the left edge of the expanded settings panel to resize it; its width is remembered locally. The final exported file remains Animated WebP. You can upload a local image as the preview background to inspect the transparent edges; the background image and checkerboard are never included in the WebP output.

Click the path under **Output folder**, then choose **Browse folders** on Windows, or paste an existing absolute folder path and click **Use this folder**. The selected path is shown on that button and validated before conversion. The **Open folder** button directly below opens that directory in Explorer. The local Node process writes the WebP directly to that exact folder, including when the page runs in the Codex in-app browser.

The preview's checkerboard is CSS only. Output files are named after their source files (`flower_frame.mp4` → `flower_frame.webp`); existing names receive a numeric suffix instead of being overwritten. The encoder uses `colorkey`, converts the result to RGBA, and emits lossless `libwebp_anim` with loop count 0 (infinite). Conversion progress and FFmpeg errors appear next to each file. After conversion, the result card shows the actual saved path; its **Open folder** button opens the containing directory in Explorer on Windows, and the card can be dismissed with its close button.

Everything runs on the local machine at `127.0.0.1`. The browser reads the selected MP4 directly for frame selection. During full conversion, the browser streams that MP4 to the local Node process, which puts it in an OS temporary directory only until FFmpeg finishes or fails. The original file is never changed. Temporary output is deleted after saving, or after a one-hour expiry if the browser closes mid-task. No media is sent to an internet service; page styles are also bundled locally. To change the fallback directory, set `CHROMA_OUTPUT_DIR` to an absolute local folder before starting the app.

### Build and package

- `npm run build` creates the production web assets in `dist/`.
- `npm run start` serves the built app locally at `http://127.0.0.1:4173/#chroma` with the same FFmpeg endpoints. Run `npm run build` first.
- `npm run package` builds a portable `release/codex-workbench/` folder containing the app and its Node dependencies. Copy or zip that folder for another computer with the same OS/architecture. Install Node.js and FFmpeg on the destination, then run `npm run start` inside the copied folder. This MVP is a local browser app, not an installer or Electron executable.

Set `FFMPEG_PATH` and `FFPROBE_PATH` if the executables are not on `PATH`. For example in PowerShell: `$env:FFMPEG_PATH='C:\ffmpeg\bin\ffmpeg.exe'` and `$env:FFPROBE_PATH='C:\ffmpeg\bin\ffprobe.exe'` before starting the app.

For a local integration check with FFmpeg installed, run `node scripts/smoke-chroma.mjs`.

On the canvas, drag a node by its header; drag empty space to pan; use Ctrl/Cmd + wheel or the zoom controls to zoom; drag an output port to a compatible input port to connect. Multiple connections may enter or leave a node. Duplicate, incompatible, self, and cyclic connections are rejected.

## View Synthesizer

Choose a content type and either manually calibrate both views or let Codex interpret a relative camera move from the uploaded image. Codex generates the result with its built-in image tool; this local workflow needs no API key.

## Run locally

1. Run `npm install` and `npm run dev` in this folder.
2. Open the local URL printed by Vite (port 3000 by default), upload a PNG, JPEG, or WebP image, and choose a content type. In **Manual calibration**, match the uploaded view with the first cube and choose the final view with the second. In **AI auto-understand**, use the single cube for a change relative to the uploaded image; no initial-angle setup is required. Click **Create Local Job**.
3. In the Codex chat attached to this folder, invoke `$generate-view`.
4. Keep the page open. When Codex finishes, the result appears in the output panel and can be downloaded.

The local development server stores reference images, request details, and outputs in `.view-jobs/`. This folder is excluded from version control. The browser button only creates a job; Codex performs image generation after your chat request. The generated view is an AI approximation, especially where the original image does not reveal the subject's other side.

Both cubes use the same front/reference direction. The prompt uses the shortest relative turn from the input angle to the target angle, while character face and gaze direction come from the **target** angle. Negative target angles show the character's own left face; positive angles show the right face. Object and building modes use structural sides; interior mode describes moving the virtual camera around the scene rather than rotating a room. Cubes are direction guides, not reconstructed geometry.

In auto-understand mode, the page saves a task brief but does not display an image-specific prompt before analysis. When you ask Codex to generate the queued view, it inspects the image, interprets the relative angle, scene structure, pose, and gaze, and creates the edit prompt. The auto-mode distance control is relative to the input (1x unchanged, lower values closer, higher values farther).
