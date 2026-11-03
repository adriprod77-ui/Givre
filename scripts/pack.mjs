// Builds a standalone Windows app into dist/Givre-win32-x64. Run with: npm run pack
import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const [appPath] = await packager({
  dir: root,
  out: path.join(root, 'dist'),
  name: 'Givre',
  executableName: 'Givre',
  platform: 'win32',
  arch: 'x64',
  icon: path.join(root, 'assets', 'icon.ico'),
  overwrite: true,
  prune: true,
  asar: { unpack: '**/*.node' },
  ignore: [/^\/dist/, /^\/scripts/, /^\/assets\/icon\.(svg|png)$/, /\.md$/],
  appCopyright: '© Givre',
  win32metadata: {
    CompanyName: 'Givre',
    FileDescription: 'Givre — aide-mémoire',
    ProductName: 'Givre',
    InternalName: 'Givre',
  },
});

console.log(`Givre packaged in ${appPath}`);
