# Edit Recordly videos with Claude (MCP)

Recordly can be driven by Claude through the [Model Context Protocol](https://modelcontextprotocol.io). Claude edits the project that is open in the Recordly editor: cuts, speed changes, zooms, text and arrows, blur, subtitles, background and cursor styling, and export. Every change shows up live in the editor. Timeline changes can be undone with Cmd/Ctrl+Z, and the project autosaves as usual.

```
Claude Code ──stdio──▶ recordly-mcp (mcp/) ──HTTP 127.0.0.1 + token──▶ Recordly app ──IPC──▶ open editor
```

## Setup

1. **Build the MCP server** (once, from the repo root):

   ```bash
   npm run mcp:build
   ```

2. **Turn on the local API in Recordly.** Open the editor, click the gear (**Settings**) in the left rail, switch on **Advanced** at the top of the panel, open the **Advanced** tab and enable **Allow local API control** under *Claude & automation*. The row shows the port once it is running.

   For development builds you can also start the app with `RECORDLY_AUTOMATION_API=1`.

3. **Connect Claude Code.**
   - Inside this repository, nothing else is needed: the committed [`.mcp.json`](../.mcp.json) registers the `recordly` server. Claude Code asks you to approve it the first time.
   - To use it from any folder, register it once for your user:

     ```bash
     claude mcp add --scope user recordly -- node /absolute/path/to/Modded-recordly/mcp/dist/index.js
     ```

   Run `/mcp` in Claude Code to check that `recordly` is connected.

### Claude Desktop (optional)

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config) and restart Claude Desktop:

```json
{
	"mcpServers": {
		"recordly": {
			"command": "node",
			"args": ["/absolute/path/to/Modded-recordly/mcp/dist/index.js"]
		}
	}
}
```

## Using it

Open a recording or project in Recordly, then ask Claude, for example:

- "Look at my Recordly timeline and remove the dead air and filler words, then show me a preview at 0:30."
- "Add a 2× zoom on the top-left when I click the Settings button around 0:12, and a text callout saying 'Click Settings'."
- "Speed up 1:05–1:40 to 3×, blur the API key visible from 0:50 to 1:10, and use a dark gradient background with rounded corners."
- "Make a 9:16 version with subtitles and export it to ~/Desktop/demo-vertical.mp4."

### Tools

| Tool | What it does |
| --- | --- |
| `recordly_status` | Is Recordly running with the API on, and which project is open |
| `list_projects` / `open_project` | Find and open saved `.recordly` projects |
| `get_timeline` | Clips, zooms, annotations, audio, subtitles and look settings, in timeline milliseconds |
| `get_transcript` | Word-level transcript mapped onto the edited timeline (uses Whisper) |
| `apply_edits` | Atomic batch of edit ops: `cut_range`, `set_speed_range`, `split_clip`, `delete_clip`, `set_clip_speed`, `set_clip_muted`, `add_zoom`/`update_zoom`/`delete_zoom`, `add_annotation`/`update_annotation`/`delete_annotation`, `add_caption`/`edit_caption`/`delete_caption`/`clear_captions`, `set_caption_settings`, `set_appearance`, `set_crop`, `set_aspect_ratio`, `add_audio`/`update_audio`/`delete_audio` |
| `undo` / `redo` | Recordly's own undo history |
| `preview_frame` | Screenshot of the rendered preview at a given time, so Claude can check its work |
| `generate_captions` | Transcribe with Whisper and replace the subtitles |
| `export_video` | Render MP4/GIF to a path, with progress (`export_status`, `cancel_export`) |
| `save_project` | Save now (autosave also runs) |

The server also publishes a `recordly://guide` resource (and a `get_guide` tool) with value ranges and editing recipes.

### Good to know

- **Times are timeline milliseconds**, after cuts and speed changes. Cuts ripple: everything after a cut moves earlier, and zooms or annotations that only covered removed footage are deleted. Subtitles follow their words automatically.
- **Batches are all-or-nothing.** If one op is invalid (for example overlapping zooms), nothing is applied and the error names the failing op.
- **Undo** covers clips, zooms, annotations, audio and subtitle cues. Background, padding, cursor, crop, aspect-ratio and subtitle-style changes are not part of Recordly's undo history.
- **Cursor and zoom motion** are set with `motionPreset` (`focused` or `smooth`), because projects only store those two presets.
- **Transcripts and subtitles** need the Whisper model. Download it once from the editor's Captions panel.
- **Export** never overwrites an existing file unless asked to, and editing is paused while an export runs.

## Security

- The API is **off by default**, listens on `127.0.0.1` only, and needs a random bearer token that changes every time Recordly starts.
- The token is written to `automation.json` in Recordly's user-data folder (`~/Library/Application Support/Recordly` on macOS, `%APPDATA%\Recordly` on Windows, `~/.config/Recordly` on Linux; `Recordly-dev` for dev builds) with owner-only permissions. The file is removed when the API is turned off or the app quits.
- Requests from web pages are refused (any `Origin` header, or a `Host` other than the loopback address), so a website cannot drive the editor.
- Anything that can read your user-data folder can control the open project while the API is on. Turn it off when you don't need it.

## HTTP API (for other tools)

The MCP server is a thin client. Anything else on your machine can use the same API:

```bash
FILE="$HOME/Library/Application Support/Recordly/automation.json"   # see paths above
URL=$(jq -r .url "$FILE"); TOKEN=$(jq -r .token "$FILE")
curl -H "Authorization: Bearer $TOKEN" "$URL/v1/editor/state"
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ops":[{"op":"add_zoom","startMs":2000,"endMs":5000,"depth":4}]}' "$URL/v1/editor/ops"
```

Endpoints: `GET /v1/status`, `GET /v1/projects`, `POST /v1/projects/open`, `GET /v1/editor/state`, `POST /v1/editor/ops`, `POST /v1/editor/undo`, `POST /v1/editor/redo`, `POST /v1/editor/save`, `POST /v1/editor/seek`, `POST /v1/editor/frame`, `POST /v1/editor/transcript`, `POST /v1/editor/captions/generate`, `POST /v1/export`, `GET /v1/export`, `POST /v1/export/cancel`. Responses are `{ "ok": true, "result": … }` or `{ "ok": false, "error": { "code", "message" } }`.

## Code map

- `electron/automation/`: HTTP server, auth, routes, discovery file, and the request bridge to the editor window.
- `src/components/video-editor/automation/`: the edit engine (`automationOps.ts`), timeline/transcript views, and the `useAutomationBridge` hook that applies requests to the live editor.
- `mcp/`: the `recordly-mcp` stdio server (tool definitions, discovery, guide text).
