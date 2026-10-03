---
name: generate-view
description: Generate the latest queued camera-view image from this project's local web UI with Codex built-in image generation. Use when the user says "生成最新视角", asks to process a queued view job, or invokes $generate-view.
---

# Generate a queued view

Use this skill for the local Codex workflow in this project. The web UI saves jobs under `.view-jobs/`; no API key is needed.

1. Run `node scripts/view-job.mjs latest` from the project root. Read the queued `mode`, prompt/brief, `camera`, `category`, job ID, and `inputPath`; manual jobs also have `sourceCamera`. If there is no queued job, tell the user to create one in the web UI. Older jobs may lack `mode`; treat them as manual and follow their saved prompt.
2. Inspect the input image with `view_image`. In **manual** mode, respect the user's source and target calibration: movement is relative to the input, while final-side descriptions refer to the target. Use the queued English prompt and add observed details only where they improve preservation. In **auto** mode, the queued text is a task brief, **not** a finished prompt. Treat the input image as the zero/reference view; the camera values are relative changes. Follow the project's signed cube direction (negative toward the minus/left side, positive toward the plus/right side), but do not assume the input is frontal or force a final nose direction solely from that sign. Identify the main subject(s), existing pose and head/body/gaze relationship, important objects and spatial anchors, and a plausible observation center. Formulate an image-specific edit prompt before generation. Preserve action and gaze target while moving the virtual viewpoint unless the user asks otherwise. For interiors, move the viewpoint around the scene rather than rotating the room. In either mode, angles are approximate visual targets; synthesize unseen areas plausibly.
3. Use the built-in `image_gen` tool for an image edit with the local image path as `referenced_image_paths`. Do not switch to an API or ask for a key. Keep the background opaque unless the original image is transparent or the user requested transparency.
4. Inspect the output for the requested target direction and preservation constraints; for characters also inspect visible face and gaze, and for interiors check layout continuity. If the result conflicts with the target, make one targeted retry with the same reference. The built-in image tool saves the generated file under Codex's generated-images directory. Resolve the actual returned output path. Run `node scripts/view-job.mjs complete <job-id> <generated-image-path>` to copy the selected output into the job directory and mark it complete. Do not pass the reference image as the output.
5. Tell the user the result is available in the web UI. If generation fails, report the reason and leave the job queued for retry.

Process one latest queued job per invocation unless the user explicitly asks for more. If the user provides a job ID, use that exact job instead of the latest job, inspecting its `request.json` directly before generation.
