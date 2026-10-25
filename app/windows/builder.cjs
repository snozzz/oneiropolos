const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../package.json');
const backendPackage = path.resolve(__dirname, '../../dist/windows-backend-package.json');
fs.mkdirSync(path.dirname(backendPackage), { recursive: true });
fs.writeFileSync(backendPackage, JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }));
module.exports = {
  electronDist: process.env.WBLOOP_ELECTRON_DIST,
  appId: 'local.oneiropolos.app', productName: 'Oneiropolos',
  directories: { output: 'dist/windows' },
  files: ['app/windows/main.cjs', 'app/windows/preload.cjs', 'package.json'],
  extraResources: [
    { from: 'bin', to: 'program/bin' }, { from: 'src', to: 'program/src' },
    { from: 'public', to: 'program/public' }, { from: backendPackage, to: 'program/package.json' },
    { from: process.execPath, to: 'runtime/node.exe' },
  ],
  win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], icon: 'app/AppIcon.png', artifactName: 'Oneiropolos-${version}-windows-${arch}.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, artifactName: 'Oneiropolos-${version}-windows-${arch}-setup.${ext}' },
};
