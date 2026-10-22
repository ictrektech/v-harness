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
