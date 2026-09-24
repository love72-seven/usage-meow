const fs = require('node:fs/promises');
const path = require('node:path');

// Record only files shipped in this build. Never recursively delete a user's
// chosen installation folder, which could also contain unrelated documents.
async function createManifest(context) {
  if (context.electronPlatformName !== 'win32') return;
  const files = [];
  const directories = [];
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(context.appOutDir, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in application output');
      if (entry.isDirectory()) { directories.push(child); await walk(child); }
      else files.push(child);
    }
  }
  await walk();
  if (!files.includes('用量喵.exe') || !files.includes(path.join('resources', 'app.asar'))) {
    throw new Error('Incomplete application output; refusing to generate uninstall manifest');
  }
  const escape = (value) => value.replaceAll('$', '$$').replaceAll('"', '$\\"').replaceAll('/', '\\');
  const lines = ['; Generated from packaged application files. Do not hand-edit.', '!macro UsageMeowRemovePayload'];
  // NSIS adds elevate.exe after afterPack, so it must be listed explicitly.
  const ownedFiles = [...new Set([...files, path.join('resources', 'elevate.exe'), 'uninstallerIcon.ico', 'Uninstall 用量喵.exe'])].sort();
  for (const file of ownedFiles) {
    const target = '$INSTDIR\\' + escape(file);
    lines.push(`  Delete "${target}"`, `  IfFileExists "${target}" 0 +3`,
      '    StrCpy $R9 "1"', `    FileWrite $R8 "Cannot remove: ${target}$\\r$\\n"`);
  }
  lines.push('!macroend', '!macro UsageMeowRemoveEmptyDirectories');
  for (const directory of directories.sort((a, b) => b.length - a.length)) {
    lines.push(`  RMDir "$INSTDIR\\${escape(directory)}"`);
  }
  lines.push('!macroend', '');
  await fs.writeFile(path.join(context.packager.projectDir, 'build', 'uninstall-files.nsh'), lines.join('\n'));
}
module.exports = createManifest;
