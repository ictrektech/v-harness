/** CSS Modules: every import resolves to its scoped class-name map. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
