# Codex Workbench

<img width="2517" height="1267" alt="局部截取_20261024_063223" src="https://github.com/user-attachments/assets/5f7347c8-e802-4e2b-b5a8-6db257d83677" />
<img width="2532" height="1263" alt="局部截取_20261024_063336" src="https://github.com/user-attachments/assets/7d59567f-fece-4a50-a64d-14b94c69c008" />

Module requirements and technical design: [View Synthesizer PRD + TDD](docs/view-synthesizer-prd-tdd.md) · [Workflow Canvas PRD + TDD](docs/workflow-canvas-prd-tdd.md) · MP4 BG Removal [PRD](docs/PRD-mp4-background-removal/PRD.md), [TDD](docs/PRD-mp4-background-removal/TDD.md), and [verification](docs/PRD-mp4-background-removal/verification.md).

The local app has three modules, selected from the top navigation:

- **View Synthesizer** keeps the existing camera-view image-editing workflow.
- **Workflow Canvas** is an early local-first node canvas. It supports text, planned GPT-text and planned image nodes, typed ports, multiple incoming and outgoing connections, node dragging, canvas panning/zooming, and automatic browser-local saving. GPT login/inference and image generation are **not connected yet**; the canvas does not return simulated AI results. There is no video node.
- **MP4 BG Removal** exports the selected green-screen MP4 as an animated WebP, individual transparent PNG frames, or a row-configurable PNG atlas. Its bottom frame editor saves a persistent edited sequence alongside the original frame order.

## MP4 BG Removal: MP4 → Animated WebP

### Requirements

- Node.js 20.19+ and npm.
- FFmpeg and FFprobe available on `PATH`. On Windows, download an FFmpeg build from [ffmpeg.org](https://ffmpeg.org/download.html), extract it, add its `bin` folder to `PATH`, then verify `ffmpeg -version` and `ffprobe -version` in a new terminal. On macOS, `brew install ffmpeg`; on Debian/Ubuntu, `sudo apt install ffmpeg`.
- On Windows, **Browse folders** opens a native folder dialog through the local Node process. On other systems, enter an existing absolute folder path manually.

Run `npm install`, then `npm run dev`. Open `http://127.0.0.1:3000/#chroma`. Drag in MP4 files or select several at once. Each upload is saved locally and appears in the left list after refresh. Select one file to restore its key, FPS, crop, output size, frame range, preview background, output folder, and optional edited frame copy. **Keep original size** preserves the source dimensions. **Custom dimensions** accepts integer dimensions from 16 to 4096 pixels; crop and transparent padding keep the source image's proportions.

For square or custom output from a source with a different aspect ratio, select **Crop to output ratio** in the compact bar above the previews to crop a matching region before scaling. Click **Edit crop**, drag the image inside the fixed white frame to position it, and use the zoom slider or reset button as needed. After editing, the source preview fills its pane with the selected crop, without a frame overlay; source playback also uses this crop. The output preview updates after each drag. **Scale to fit + transparent padding** keeps the entire frame with transparent margins instead. Neither mode stretches the picture.

Use **Output Edit → Adjust → Position** to move the transparent foreground independently of the optional background image. Click **Move** before dragging in the output pane, and adjust its zoom from 0.5× to 2×. This placement is applied to exports; the preview background is never exported.

The timeline below the source video has two white draggable handles for the included start and end frames, a green playhead for the currently inspected source frame, and a highlighted export interval. Click the track to inspect a source frame, or use its first and last frame buttons. The output pane has a separate frame-by-frame slider limited to that interval; it previews a keyed output frame without moving the source preview. **Follow source frame** reconnects the output preview to the source playhead. Source FPS and output FPS are edited together in the right settings panel. The default interval is the full video, and intervals are saved separately for each MP4. **Play source interval** under the left source frame loops the selected clip immediately in the browser. **Play preview** builds a temporary transparent WebM preview. The preview stays cached in browser memory until a conversion setting or interval changes. The source list and settings panel can be collapsed, and the settings-panel width is remembered locally. You can save a local image as the preview background to inspect transparent edges; it is restored with that file, but is never included in exports.

For frame editing, select a file in the left list and click **Generate PNG frames** in the full-width bottom panel. Its fixed-length timeline belongs only to that file. Clear a slot to leave a fully transparent frame without shortening playback; click its `+` to assign any generated source frame, including one already used elsewhere. Drag thumbnails or use the move buttons to reorder slots. Close or reopen the bottom editor at any time. The existing right output preview switches between original and edited order and defaults to edited when the selected file has a frame copy. The right settings panel independently chooses export order and one of three formats; all formats also work on the original sequence without first creating an editor copy. PNG sequences are saved in their own folder. Regenerating frames for the same file replaces its edited sequence after confirmation.

Click the path under **Output folder**, then choose **Browse folders** on Windows, or paste an existing absolute folder path and click **Use this folder**. The selected path is shown on that button and validated before conversion. The **Open folder** button directly below opens that directory in Explorer. The local Node process writes the WebP directly to that exact folder, including when the page runs in the Codex in-app browser.

The preview's checkerboard is CSS only. Output files are named after their source files (`flower_frame.mp4` → `flower_frame.webp`); existing names receive a numeric suffix instead of being overwritten. The encoder uses `colorkey`, converts the result to RGBA, and emits lossless `libwebp_anim` with loop count 0 (infinite). Conversion progress and FFmpeg errors appear next to each file. After conversion, the result card shows the actual saved path; its **Open folder** button opens the containing directory in Explorer on Windows, and the card can be dismissed with its close button.

Everything runs on the local machine at `127.0.0.1`. Uploaded MP4 files and their settings live in the user's local application-data directory (`%LOCALAPPDATA%\Codex Workbench\Chroma Projects` on Windows); generated PNGs and frame edits stay beside their own MP4. Only the selected MP4 is loaded into browser memory. Set `CHROMA_PROJECT_DIR` before starting the app to use another local location. The original file is never changed. No media is sent to an internet service; page styles are bundled locally. To change the fallback output directory, set `CHROMA_OUTPUT_DIR` to an absolute local folder before starting the app.

### Build and package

- `npm run build` creates the production web assets in `dist/`.
- `npm run start` serves the built app locally at `http://127.0.0.1:4173/#chroma` with the same FFmpeg endpoints. Run `npm run build` first.
- `npm run package` builds a portable `release/codex-workbench/` folder containing the app and its Node dependencies. Copy or zip that folder for another computer with the same OS/architecture. Install Node.js and FFmpeg on the destination, then run `npm run start` inside the copied folder. This MVP is a local browser app, not an installer or Electron executable.

Set `FFMPEG_PATH` and `FFPROBE_PATH` if the executables are not on `PATH`. For example in PowerShell: `$env:FFMPEG_PATH='C:\ffmpeg\bin\ffmpeg.exe'` and `$env:FFPROBE_PATH='C:\ffmpeg\bin\ffprobe.exe'` before starting the app.

For local integration checks with FFmpeg installed, run `node scripts/smoke-chroma.mjs` and `node scripts/smoke-frame-projects.mjs`.

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
