/** Instructions handed to Claude: how Recordly's timeline works and how to edit it well. */

export const SERVER_INSTRUCTIONS = `Recordly is a screen-recording editor. These tools drive the Recordly app running on this computer: edits appear live in its editor, join its undo history, and autosave.

Workflow:
1. Call get_timeline first (open_project / list_projects if nothing is open).
2. Plan edits from the timeline (and get_transcript for speech-based edits), then send them in ONE apply_edits batch where possible. A batch is atomic: if any op is invalid nothing is applied and the error names the failing op.
3. Use preview_frame to look at the result at a specific time before exporting.
4. export_video renders the final MP4/GIF to a path the user chose.

Rules:
- All times are TIMELINE milliseconds (what the user sees after cuts and speed changes). get_timeline and get_transcript report timeline times; words whose footage was cut have startMs null.
- After cut_range, everything later shifts earlier. Within one batch, later ops see the already-edited timeline, so when cutting several ranges go from the END of the video towards the start (or re-read the timeline between batches).
- Zoom regions cannot overlap. Depth 1-6 (3 is the default 1.8x). Give a focus {cx, cy} to hold a fixed point, or omit it to follow the cursor.
- Prefer undo over manual reversal when an edit was a mistake. Undo covers clips, zooms, annotations, audio and caption cues; appearance, crop, aspect-ratio and caption-style changes are not in Recordly's undo history, so set those back explicitly.
- Ask before overwriting an existing export file.

See the recordly://guide resource for value ranges and recipes.`;

export const GUIDE_MARKDOWN = `# Recordly editing guide

## Model
- **Clips** are kept pieces of the recording laid end to end on the timeline. Each has a speed; cutting removes footage and closes the gap.
- **Zooms**, **annotations** and **audio** are placed on the timeline and move with the footage under them when you cut or change speed. A zoom or annotation that only covered removed footage is deleted.
- **Captions** belong to the recording's speech, so they follow their words through cuts automatically.

## Recipes
- *Remove filler words / pauses*: get_transcript → for each unwanted word or silence gap, \`cut_range\` from its startMs to endMs (pad ~30-80 ms; leave ~150 ms around speech). Apply cuts from last to first in one batch.
- *Tighten a slow section*: \`set_speed_range\` with speed 1.5–4.
- *Highlight a click*: \`add_zoom\` ~300 ms before the action until ~1.5 s after, depth 3–4, focus at the clicked point (or omit focus to follow the cursor).
- *Callout*: \`add_annotation\` type text with a short label, position near the subject (percent of canvas), 2–4 s long.
- *Hide secrets*: \`add_annotation\` type blur over the region for the whole range it is visible.
- *Vertical short*: \`set_aspect_ratio\` 9:16, optionally \`set_crop\` to the interesting area.
- *Subtitles*: generate_captions (uses Whisper; needs the model downloaded once in Recordly) then \`set_caption_settings\` for style.

## set_appearance values
| key | values |
| --- | --- |
| wallpaper | built-in image like "/wallpapers/sonoma-dark.jpg", a CSS gradient like "linear-gradient(135deg, #FBC8B4, #2447B1)", or a color like "#111827" |
| padding | {top,bottom,left,right} 0-100 (percent), {linked:true} keeps sides equal |
| borderRadius | 0-50 (percent of the shorter side) |
| shadowIntensity | 0-1 |
| backgroundBlur | 0-8 (blurs image wallpapers) |
| motionPreset | "focused" (snappy zooms, 200 ms) or "smooth" (slow cinematic zooms) — also sets cursor size/smoothing/bounce |
| showCursor / loopCursor | boolean |
| cursorStyle | tahoe, tahoe-inverted, macos, windows11, dot, figma |
| cursorClickEffect | none, spotlight, ripple, echo; cursorClickEffectColor "#hex", cursorClickEffectScale, cursorClickEffectOpacity 0-1 |
| cursorSway | 0-2 |
| zoomMotionBlur | 0-2 |
| connectZooms | boolean (glide between nearby zooms instead of zooming out) |
| zoomInEasing / zoomOutEasing / connectedZoomEasing | recordly, glide, smooth, snappy, linear |
| webcam | {enabled, positionPreset (top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right), size, roundness 0-100, shadow 0-1, mirror, reactToZoom} — only when the recording has a webcam track |

Built-in wallpapers: tahoe-light, tahoe-dark, midnight-8, ipad-17-dark, ipad-17-light, sequoia-blue, sequoia-blue-orange, ventura, ventura-dark, sonoma-clouds, sonoma-light, sonoma-dark, sonoma-evening, sonoma-horizon, glassmorphism-3, glassmorphism-4, energy-17, energy-19, iridescent-9, cityscape, levels, wallpaper3, wallpaper4, wallpaper10 (all ".jpg" under "/wallpapers/"), and the video "/wallpapers/wispysky.mp4".

## Captions settings
fontSize 16-72, bottomOffset 0-30 (% from bottom), maxWidth 40-95 (%), maxRows 1-4, animationStyle none|fade|rise|pop, textColor/inactiveTextColor "#hex", backgroundOpacity 0-1, language "auto" or an ISO code.

## Export
export_video {outputPath: absolute path ending in .mp4 or .gif, quality: medium|good|high|source, fps: 24|30|60}. Export blocks editing until it finishes. It will not overwrite an existing file unless overwrite is true.
`;
