import { z } from "zod";

/** Zod schemas mirroring the edit ops Recordly's automation API accepts. */

const ms = (what: string) => z.number().min(0).describe(`${what}, in timeline milliseconds`);
const id = (what: string) => z.string().min(1).describe(`Id of the ${what} (from get_timeline)`);
const span = { startMs: ms("Start"), endMs: ms("End (exclusive)") };

const focus = z
	.object({
		cx: z.number().min(0).max(1).describe("Horizontal center, 0 = left edge, 1 = right edge"),
		cy: z.number().min(0).max(1).describe("Vertical center, 0 = top edge, 1 = bottom edge"),
	})
	.describe("Point to zoom into, as a fraction of the recording frame");

const speed = z
	.number()
	.min(0.25)
	.max(16)
	.describe("Playback speed multiplier in steps of 0.25 (e.g. 0.5, 1.5, 2, 4)");

const zoomDepth = z
	.number()
	.int()
	.min(1)
	.max(6)
	.describe("Zoom strength: 1=1.25x, 2=1.5x, 3=1.8x (default), 4=2.2x, 5=3.5x, 6=5x");

const annotationFields = {
	type: z
		.enum(["text", "figure", "blur"])
		.optional()
		.describe("text = caption box, figure = arrow, blur = blur/redact a rectangle"),
	text: z.string().optional().describe("Text for text annotations"),
	position: z
		.object({ x: z.number(), y: z.number() })
		.optional()
		.describe("Center position in percent of the canvas (0-100); default 50,50"),
	size: z
		.object({ width: z.number(), height: z.number() })
		.optional()
		.describe("Box size in percent of the canvas; default 30x20"),
	style: z
		.object({
			color: z.string().optional(),
			backgroundColor: z.string().optional(),
			fontSize: z.number().optional(),
			fontFamily: z.string().optional(),
			fontWeight: z.string().optional(),
			fontStyle: z.string().optional(),
			textDecoration: z.string().optional(),
			textAlign: z.enum(["left", "center", "right"]).optional(),
			borderRadius: z.number().optional(),
		})
		.optional()
		.describe("Text styling (CSS-like values)"),
	figure: z
		.object({
			arrowDirection: z
				.enum([
					"up",
					"down",
					"left",
					"right",
					"up-right",
					"up-left",
					"down-right",
					"down-left",
				])
				.optional(),
			color: z.string().optional(),
			strokeWidth: z.number().optional(),
		})
		.optional()
		.describe("Arrow settings for figure annotations"),
	blurIntensity: z.number().optional().describe("Blur strength for blur annotations"),
	blurColor: z.string().optional(),
	trackIndex: z.number().int().min(0).optional().describe("Annotation track (row), default 0"),
};

export const opSchema = z.discriminatedUnion("op", [
	z
		.object({ op: z.literal("cut_range"), ...span })
		.describe("Remove footage between startMs and endMs; everything after shifts earlier."),
	z
		.object({ op: z.literal("split_clip"), atMs: ms("Split position") })
		.describe("Split the footage clip under atMs into two clips."),
	z.object({ op: z.literal("delete_clip"), id: id("clip") }).describe("Remove a footage clip."),
	z
		.object({ op: z.literal("set_clip_speed"), id: id("clip"), speed })
		.describe("Change the playback speed of one clip."),
	z
		.object({ op: z.literal("set_speed_range"), ...span, speed })
		.describe("Speed up or slow down a time range (splits clips at the edges as needed)."),
	z
		.object({ op: z.literal("set_clip_muted"), id: id("clip"), muted: z.boolean() })
		.describe("Mute or unmute a clip's recorded audio."),
	z
		.object({
			op: z.literal("add_zoom"),
			...span,
			depth: zoomDepth.optional(),
			focus: focus.optional(),
			mode: z
				.enum(["auto", "manual"])
				.optional()
				.describe(
					"auto follows the cursor; manual holds `focus` (default when focus is given)",
				),
		})
		.describe("Add a zoom-in region. Zoom regions cannot overlap each other."),
	z
		.object({
			op: z.literal("update_zoom"),
			id: id("zoom"),
			startMs: ms("New start").optional(),
			endMs: ms("New end").optional(),
			depth: zoomDepth.optional(),
			focus: focus.optional(),
			mode: z.enum(["auto", "manual"]).optional(),
		})
		.describe("Change an existing zoom region."),
	z.object({ op: z.literal("delete_zoom"), id: id("zoom") }).describe("Remove a zoom region."),
	z
		.object({ op: z.literal("add_annotation"), ...span, ...annotationFields })
		.describe("Add a text box, arrow, or blur rectangle on top of the video."),
	z
		.object({
			op: z.literal("update_annotation"),
			id: id("annotation"),
			startMs: ms("New start").optional(),
			endMs: ms("New end").optional(),
			...annotationFields,
		})
		.describe("Change an existing annotation."),
	z
		.object({ op: z.literal("delete_annotation"), id: id("annotation") })
		.describe("Remove an annotation."),
	z
		.object({ op: z.literal("add_caption"), ...span, text: z.string().min(1) })
		.describe("Add a subtitle cue (also turns captions on)."),
	z
		.object({
			op: z.literal("edit_caption"),
			id: id("caption"),
			text: z.string().min(1).optional(),
			startMs: ms("New start").optional(),
			endMs: ms("New end").optional(),
		})
		.describe("Change a subtitle cue's text or timing."),
	z
		.object({ op: z.literal("delete_caption"), id: id("caption") })
		.describe("Remove a subtitle cue."),
	z.object({ op: z.literal("clear_captions") }).describe("Remove all subtitle cues."),
	z
		.object({
			op: z.literal("set_caption_settings"),
			settings: z
				.object({
					enabled: z.boolean().optional(),
					language: z.string().optional(),
					fontFamily: z.string().optional(),
					fontSize: z.number().optional(),
					bottomOffset: z.number().optional(),
					maxWidth: z.number().optional(),
					maxRows: z.number().optional(),
					animationStyle: z.enum(["none", "fade", "rise", "pop"]).optional(),
					boxRadius: z.number().optional(),
					textColor: z.string().optional(),
					inactiveTextColor: z.string().optional(),
					backgroundOpacity: z.number().optional(),
				})
				.describe("Subtitle styling"),
		})
		.describe("Show/hide subtitles and change their style."),
	z
		.object({
			op: z.literal("set_appearance"),
			settings: z
				.record(z.unknown())
				.describe(
					"Look & motion settings to change. Keys: wallpaper, padding {top,bottom,left,right,linked}, " +
						"borderRadius, shadowIntensity, backgroundBlur, motionPreset (focused|smooth), " +
						"showCursor, loopCursor, cursorStyle, cursorClickEffect (none|spotlight|ripple|echo), " +
						"cursorClickEffectColor, cursorClickEffectScale, cursorClickEffectOpacity, cursorSway, " +
						"zoomMotionBlur, connectZooms, zoomInEasing, zoomOutEasing, connectedZoomEasing " +
						"(recordly|glide|smooth|snappy|linear), webcam {...}. " +
						"See the recordly://guide resource for value ranges.",
				),
		})
		.describe("Change background, padding, cursor and zoom-motion settings."),
	z
		.object({
			op: z.literal("set_crop"),
			x: z.number().min(0).max(1),
			y: z.number().min(0).max(1),
			width: z.number().min(0).max(1),
			height: z.number().min(0).max(1),
		})
		.describe(
			"Crop the recording (fractions of the frame; x+width and y+height must be <= 1).",
		),
	z
		.object({
			op: z.literal("set_aspect_ratio"),
			aspectRatio: z
				.string()
				.describe('native, 16:9, 9:16, 1:1, 4:3, 4:5, 16:10, 10:16, or a custom "W:H"'),
		})
		.describe("Change the output canvas aspect ratio."),
	z
		.object({
			op: z.literal("add_audio"),
			path: z
				.string()
				.describe("Absolute path to an audio file (mp3, wav, m4a, aac, ogg, flac)"),
			...span,
			volume: z.number().min(0).max(1).optional(),
			trackIndex: z.number().int().min(0).optional(),
		})
		.describe("Add background music or a voice-over track."),
	z
		.object({
			op: z.literal("update_audio"),
			id: id("audio region"),
			startMs: ms("New start").optional(),
			endMs: ms("New end").optional(),
			volume: z.number().min(0).max(1).optional(),
			normalize: z.boolean().optional(),
		})
		.describe("Change an added audio track."),
	z
		.object({ op: z.literal("delete_audio"), id: id("audio region") })
		.describe("Remove an added audio track."),
]);

export type EditOp = z.infer<typeof opSchema>;
