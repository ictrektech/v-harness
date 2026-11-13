/** Show the existing VOS model selector beside DS Bot's custom providers. */
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
let source = readFileSync(path, 'utf8');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('ds-bot: verify the Models settings composition');
  source = source.replace(before, () => after);
}

replaceOnce(
  'shown === "models" && !advanced ? (0, import_react48.createElement)(ProvidersPage, { actions, run: run2, Section: SetSection, advanced: hasSection(dsh, "models") ? () => actions.openSettings("models", "advanced") : null }) : null,',
  `shown === "models" && !advanced && hasSection(dsh, "models")
              ? (0, import_react48.createElement)("div", { className: "bt-dsh-section" },
                  (0, import_react48.createElement)("h3", null, "V-Scheduler"),
                  dsh.renderSlot("settings.section", { close }, { only: "models" }))
              : null,
            shown === "models" && !advanced ? (0, import_react48.createElement)(ProvidersPage, { actions, run: run2, Section: SetSection, advanced: hasSection(dsh, "models") ? () => actions.openSettings("models", "advanced") : null }) : null,`,
);
replaceOnce(
  'title: t("Model providers · {count}", { count: view.providers.length })',
  'title: t("Custom model providers · {count}", { count: view.providers.length })',
);
replaceOnce('  "Model providers · {count}": "模型服务商 · {count}",',
  '  "Custom model providers · {count}": "自定义模型供应商 · {count}",');
writeFileSync(path, source);
