/** Keep bundled Studio resources and API URLs inside its authenticated VOS service path. */
export function editorBytes(data, type, port) {
  if (!Number.isInteger(port) || !/^(?:text\/(?:html|javascript|css)|application\/javascript)/.test(type)) return data;
  const prefix = '/__vh/svc/' + port;
  const roots = 'editor-assets|design-system|guide-assets|web|motion-api|design-api|api|project|preview|tracking|phase1|project-archives|connect';
  const quoted = new RegExp('(["\'`])/(?=(?:' + roots + ')(?:[/\\?\\#"\'`]))', 'g');
  const css = new RegExp('(url\\(["\']?)/(?=(?:' + roots + ')/)', 'g');
  return Buffer.from(data.toString().replace(quoted, '$1' + prefix + '/').replace(css, '$1' + prefix + '/'));
}
