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
- Open Settings → Models. Pick a V-Scheduler or personal model as the default for new conversations. V-Scheduler uses your VOS identity. Text-only completion models reply without tool calls.

### Use your own models

1. Open Account menu → Settings → Models → Add model provider.
2. Select **Third-party model provider**, choose a provider from the catalog, enter your API key and save. For a self-hosted or compatible endpoint, choose **Custom model API**, enter a provider ID, base URL, protocol, model IDs and any required key, then save. The endpoint must be reachable from v-harness.
3. Under **Default model for new conversations**, select your personal model. To switch in the current conversation, use the model menu at the bottom right of the composer. Existing conversations keep their selected models. If your provider is missing, refresh the catalog and check the endpoint, protocol, model IDs and credentials.

## Built-in plugins

Open Plugins in the sidebar to find the preinstalled bundles. Open Settings → Built-in plugins to check their runtime status.

- **Context** (`dsh-context@0.85.1`). Open Context in the conversation's right sidebar to inspect usage, composition and compaction history. [Usage guide](https://github.com/bowenliang123/dsh-context)
- **Image Gen** (`dsh-image-gen@0.11.3`). Configure a provider and its credentials in the plugin settings, then ask for an image generation or edit in a conversation. [Provider configuration](https://github.com/shanliuling/dsh-image-gen)
- **Mnemon** (`dsh-mnemon@0.5.47`). Open Memory System to inspect memory views and storage settings for your workspace. Follow the provider's instructions to connect an external memory space. [Usage guide](https://github.com/omdsh-dev/dsh-mnemon)
- **Skills Manager** (`@michengai/dsh-skills-manager@1.4.11`). Open Plugins → Skills Manager to browse and manage skills in your tenant. [Usage guide](https://github.com/MichengAI/dsh-skills-manager)
- **Agent teamwork**. Select a workspace and open a top-level conversation in v-harness. Click the model and reasoning-level button at the bottom right of the composer, then turn on **Enable agent teamwork**. The switch starts off in new conversations and applies to the current top-level conversation. Describe the work to divide, then open **Task board** in the conversation header to see subagents and shared tasks. Turning off teamwork after a model request requires confirmation.
- **Agent Teams** (`@nanmicoder/dsh-agent-teams@0.1.30`). In a workspace conversation, enter `/agent-teams` and describe a task, or explicitly ask for Agent Teams. Review and approve the plan, then open the team panel to track member progress. Use a model that supports tool calls. [Usage guide](https://github.com/NanmiCoder/dsh-agent-teams)
- **Media Desk** (`dsh-media-desk@2.7.2`). Sign in to VOS, open v-harness, and select Media Desk in the sidebar. Add a note under Ideas, then open the card to generate a script, title, cover, illustrations, and storyboard. Schedule the draft in Calendar and enter or import metrics in Review. Drafting uses the v-harness default model unless you select another in Media Desk. For images, configure an image provider or select an available subscription image tool in Media Desk settings and generate a test image. You can explore with sample data or clear it before adding your own. [Upstream usage guide](https://github.com/woniuniuniu/dsh-media-desk/blob/main/README.en.md)
- **IM Bot** (`@xmanrui/dsh-im@5.10.0`). Open Settings → IM Bot, choose a channel, and follow its QR code or credential setup. Assign a workspace and model, set conversation access, then send a test message from the chat app once connected. If the connection fails, check platform permissions, credentials, and network access. [Upstream channel guide](https://github.com/xmanrui/dsh-im)
- Plugins run in the signed-in VOS user's isolated environment. Media Desk's `/media-desk/*` routes serve its own browser UI and ship with the plugin. IM platform connections are managed by each channel adapter.
- **MCP Connector** (`dsh-mcp-connector@0.2.109`). Open MCP Connector from Plugins, add a server, then check its connection and tool list.
- **Plugin Market** (`dshmarket@1.73.20`). Plugin Market defaults to the Global download region. Standard npm installs use the official registry. Change the download region in Plugin Market settings.

### Assign roles in Agent Teams

Specify the members to create, their responsibilities, task dependencies, and when to start in the conversation. After the draft appears, click **View team** in the conversation header or in the team card below the reply to open **Team workspace**. You can review the draft there before launch. Once the team starts, check assignments in the member list, select tasks in the dependency graph to see their owners and prerequisites, and track completion in the progress summary. In the draft, you can update existing members' roles and models and add, edit, or remove tasks. To add members or revise the division of work, select **Return to chat & revise** and describe the changes. Save the draft, select **Approve & Run**, then select **Confirm launch**. After the team starts, request changes to assignments in the conversation.

> Create an Agent Teams team. Member A analyzes requirements and writes acceptance criteria without editing code. Member B implements the change after A finishes. Member C independently reviews the implementation and tests after B finishes. List the members, tasks, and dependencies in a draft plan. Wait for my approval before starting.

Open **Settings → API documentation** for VOS OAuth2 authentication, session creation, task submission, reading results and handling errors.

## VOS operations

Open Account menu → Settings → VOS operations. The signed-in VOS system administrator selects **Authorize diagnostics** to start a 15-minute session. Use **End diagnostics** to close it early. Other roles see a permission error.

- For a startup failure, check the app state, latest error and VOS workflow, then open the latest 150 lines from the relevant main-stack container. Logs are capped at 512 KiB. Unsupported log drivers or oversized responses return an error.
- Enter a host port to find the container and protocol associated with a Docker published port. The list excludes host processes, host-network listeners and unpublished ports.
- The container list shows the associated app version. Cleanup is available for identifiable main-stack containers in created or exited state of a different version of an app still installed on this device. Removal deletes the container's writable layer and keeps volumes. As a system administrator, select **Full access (VOS operations)** and ask the Agent to clean up unused Docker images, including tagged images. Review the full image IDs and tags, then confirm or skip. The gateway rechecks container references and reports Docker deletion conflicts. If the conversation lacks VOS operations access, the Agent directs a VOS system administrator to Full access (VOS operations). The shell only lists the current tenant’s Docker resources. See Settings → API documentation for details.
- To restart an app or clean up an object, review the preview and click Confirm this operation or Skip. A preview is valid once for 60 seconds. If the target changes, preview it again. VOS runs the restart and the console shows the accepted task ID.

A VOS system administrator can select **Full access (VOS operations)** in a conversation to diagnose directly. When the Agent proposes a stop, restart or cleanup, the conversation displays the target and asks for confirmation. The workspace sandbox remains active. See Settings → API documentation for supported operations.

If an old VOS app container holds a port or a runner lock, select **Full access (VOS operations)** and ask the Agent to inspect the app. For an eligible container, review **Stop old container**, click Confirm this operation or Skip. Refresh inventory before requesting a restart of the current app or a separate cleanup of the stopped container. The stop preserves the container and its data. The `stoppable` flag applies to recognized running or restarting containers from a different version of an installed or stopped VOS app other than v-harness. The gateway rechecks the installed version and installation ID before stopping. A stale or ineligible target returns 409 `target-changed`.

For VOS operations, use the application ID from inventory for status or restart. A repair proposal awaits confirmation and reports `executed: false`. If a proposal already exists, HTTP 409 `confirmation-pending` includes its `action`, `id` and remaining `expiresIn` in seconds. Confirm or cancel in the conversation. An expired or consumed confirmation returns 409 `confirmation-unavailable`. A Docker ID sent to application status returns 400 `app-id-required`; use inventory for container state or logs for its output.

### Host management

A VOS system administrator opens a conversation, selects **Host management**, and confirms **Enable host management**. The Agent can then list host Docker containers, read their recent logs and propose starting, stopping, restarting or removing a container by full ID. Review each proposed target in the conversation before confirming. Removal requires a stopped container and preserves volumes. Select **Turn off host management** to end access early. The grant expires after 30 minutes and is checked against the administrator role and the VOS browser session on each call. See Settings → API documentation.

### Batch cleanup

Ask the Agent to collect all cleanup targets in one proposal. The confirmation window follows the VOS interface language and lists every target. Select **Confirm this operation** or **Skip** once for the batch. The result shows which objects were removed. VOS operations accepts recognized retired containers in `created` or `exited` state. The API reference describes batch limits and errors.

## Framework and plugin upgrades

The runtime is DSH 0.2.2-rc.3. On the first launch after upgrading, v-harness removes the DS Bot plugin and settings entry and preserves its historical data. Settings → Models contains the V-Scheduler selector and personal provider setup. The plugins use the existing Agent API session and task interface. Each plugin owns its browser UI endpoints.

The tenant runtime uses its installation-owned storage service when a plugin carries an older storage module. This keeps workspace and session services on the same module identity. Session files and workspace membership stay in the persistent user directory. If history is missing after an upgrade, inspect startup errors before changing any session files. The Agent API routes and authentication contract remain unchanged.

## Built-in skills

Type a skill name such as `/archify` in a conversation, or describe the task. The skills and their runtimes are included in the image.

- **Archify** produces interactive, standalone HTML diagrams. Keep the source JSON alongside the HTML in the workspace so you can revise the diagram later.
- **Mnemon** stores and recalls preferences, decisions, and project facts across sessions in your VOS user's home directory. Ask v-harness to remember or forget a specific fact. Mnemon uses its local CLI and needs no cloud credential.
- **PPT Design Skill** creates native, editable PowerPoint files and renders previews through LibreOffice. It accepts local images and can use Image Studio or a configured image provider.
- **Vox Director** assembles narrated paper-collage videos with ffmpeg. Atlas Cloud generation requires a user-configured `ATLASCLOUD_API_KEY` and uses that account's quota. Local assembly can render prepared clips, voice-over, music, and captions.

Find agent API authentication and session operations under **Settings → API documentation**. The new skills use the existing session interface.
