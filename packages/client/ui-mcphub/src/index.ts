/**
 * MCPHub service panel, node half. Pure UI plugin: the empty apply exists so
 * the plugin appears in the host cordis.yml / Loader; the browser half ships
 * via exports["./client"], discovered through the package.json `dsh.client`
 * declaration.
 */

/** Host plugin body — the panel contributes nothing to the host tree. */
export function apply(): void {}
