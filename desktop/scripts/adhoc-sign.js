// electron-builder afterPack hook: sign the finished Scribe.app ad-hoc, the way
// Chilaka's release steps do by hand, before the dmg is made from it. Without
// this the app is only "linker-signed": no sealed resources, no bundle
// identifier of its own. No certificate or Apple account is involved.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${app}`);
};
