# v-harness

A multi-user agent workspace. Every user has independent sessions, a private
workspace, and private deliverables.

## Usage

1. Open v-harness in VOS. There is no separate sign-up or sign-in: the platform
   identity is adopted automatically.
2. Create a session and describe the task.
3. The agent reads and writes files in your workspace; deliverables land in
   `workspace/日常` or a project directory you create.

## Notes

- Each user runs in a separate process under a separate OS account. No user can
  read another user's sessions, files, or credentials.
- The file drawer only shows your own `workspace/`; hidden files are not
  downloadable.
- Add models in V-Scheduler, then open Settings → Models to refresh the list and select a default. Chat, Responses, Messages and text completion models visible to your VOS account are available in the conversation dropdown. No separate DeepSeek login or API key is required. Text-only completion models cannot call tools.

## Built-in plugins

- **Media Desk**. Sign in to VOS, open v-harness, and select Media Desk in the sidebar. If the DS Bot interface is active, open Settings from the account menu and switch to Classic Agent mode under Mode. Add a note under Ideas, then open the card to generate a script, title, cover, illustrations, and storyboard. Schedule the draft in Calendar and enter or import metrics in Review. Drafting uses the v-harness default model unless you select another in Media Desk. For images, configure an image provider or select an available subscription image tool in Media Desk settings and generate a test image. You can explore with sample data or clear it before adding your own. [Upstream usage guide](https://github.com/woniuniuniu/dsh-media-desk/blob/main/README.en.md)
- **IM Bot**. Open Settings → IM Bot, choose a channel, and follow its QR code or credential setup. Assign a workspace and model, set conversation access, then send a test message from the chat app once connected. If the connection fails, check platform permissions, credentials, and network access. [Upstream channel guide](https://github.com/xmanrui/dsh-im)
- Both plugins use the signed-in VOS user's isolated environment. Media Desk's `/media-desk/*` routes serve its own browser UI and ship with the plugin. IM platform connections are managed by each channel adapter.
- **Plugin downloads**. Plugin Market defaults to the Global download region. Standard npm installs use the official registry. Change the download region in Plugin Market settings.
- DSH 0.2.2 text-selection quoting is currently disabled in the v-harness conversation interface.
