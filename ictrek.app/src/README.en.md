# v-harness

VOS versions follow the official DSH version with a `.vos.xx` revision suffix, such as `0.2.2-rc.1.vos.01`. The revision increments for each release using the same upstream version and restarts at `.vos.01` when the upstream version changes.

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

The first visit opens in Classic Agent mode. DS Bot is preinstalled and can be enabled under Plugins. Each user keeps their own activation state.

- **Media Desk**. Sign in to VOS, open v-harness, and select Media Desk in the sidebar. If the DS Bot interface is active, open Settings from the account menu and switch to Classic Agent mode under Mode. Add a note under Ideas, then open the card to generate a script, title, cover, illustrations, and storyboard. Schedule the draft in Calendar and enter or import metrics in Review. Drafting uses the v-harness default model unless you select another in Media Desk. For images, configure an image provider or select an available subscription image tool in Media Desk settings and generate a test image. You can explore with sample data or clear it before adding your own. [Upstream usage guide](https://github.com/woniuniuniu/dsh-media-desk/blob/main/README.en.md)
- **IM Bot**. Open Settings → IM Bot, choose a channel, and follow its QR code or credential setup. Assign a workspace and model, set conversation access, then send a test message from the chat app once connected. If the connection fails, check platform permissions, credentials, and network access. [Upstream channel guide](https://github.com/xmanrui/dsh-im)
- Both plugins use the signed-in VOS user's isolated environment. Media Desk's `/media-desk/*` routes serve its own browser UI and ship with the plugin. IM platform connections are managed by each channel adapter.
- **Plugin downloads**. Plugin Market defaults to the Global download region. Standard npm installs use the official registry. Change the download region in Plugin Market settings.

Open **Settings → API documentation** for VOS OAuth2 authentication, session creation, task submission, reading results and handling errors.

## VOS operations

Open Account menu → Settings → VOS operations. The signed-in VOS system administrator selects **Authorize diagnostics** to start a 15-minute session. Use **End diagnostics** to close it early. Other roles see a permission error.

- For a startup failure, check the app state, latest error and VOS workflow, then open the latest 150 lines from the relevant main-stack container. Logs are capped at 512 KiB. Unsupported log drivers or oversized responses return an error.
- Enter a host port to find the container and protocol associated with a Docker published port. The list excludes host processes, host-network listeners and unpublished ports.
- The container list shows the associated app version. Cleanup is available for identifiable exited main-stack containers of a different version of an app still installed on this device. Removal deletes the container's writable layer and keeps volumes. Unreferenced tagged images are listed for investigation. Image removal is limited to images with no tags, digests or container references.
- To restart an app or clean up an object, review the preview and type the complete app, container or image ID. A preview is valid once for 60 seconds. If the target changes, preview it again. VOS runs the restart and the console shows the accepted task ID.

A VOS system administrator can select **Full access (VOS operations)** in a conversation to diagnose directly. When the Agent proposes a stop, restart or cleanup, the conversation displays the target and asks for confirmation. The workspace sandbox remains active. See Settings → API documentation for supported operations.

In DS Bot, open Settings → Models. The **V-Scheduler** section lets you select a default model from the existing catalog and refresh the list. **Custom model providers** lists only providers added in DS Bot. Use **Add a provider** to configure one. **Advanced settings** remains available. The Agent API model contract is unchanged.

If an old VOS app container holds a port or a runner lock, select **Full access (VOS operations)** and ask the Agent to inspect the app. For an eligible container, review **Stop old container**, enter its complete ID and confirm. Refresh inventory before requesting a restart of the current app or a separate cleanup of the stopped container. The stop preserves the container and its data. The `stoppable` flag applies to recognized running or restarting containers from a different version of an installed or stopped VOS app other than v-harness. The gateway rechecks the installed version and installation ID before stopping. A stale or ineligible target returns 409 `target-changed`.
