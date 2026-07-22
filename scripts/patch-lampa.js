const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'lampa', 'index.html');

console.log('Patching Lampa index.html to inject Electron settings and bridge...');

if (fs.existsSync(indexPath)) {
  let content = fs.readFileSync(indexPath, 'utf8');
  
  const injectCSS = '<link rel="stylesheet" href="../src/settings-overlay.css">';
  const injectJS = '<script src="../src/settings-overlay.js" defer></script>';
  const injectPlatform = '<script>window.localStorage.setItem("platform", "electron");</script>';
  
  let modified = false;
  
  if (!content.includes('localStorage.setItem("platform"')) {
    content = content.replace('<head>', `<head>\n  ${injectPlatform}`);
    modified = true;
  }
  
  if (!content.includes('settings-overlay.css')) {
    content = content.replace('</head>', `  ${injectCSS}\n</head>`);
    modified = true;
  }
  
  if (!content.includes('settings-overlay.js')) {
    content = content.replace('</body>', `  ${injectJS}\n</body>`);
    modified = true;
  }
  
  if (modified) {
    fs.writeFileSync(indexPath, content, 'utf8');
    console.log('Successfully patched Lampa index.html');
  } else {
    console.log('Lampa index.html is already patched.');
  }
} else {
  console.error('Lampa index.html not found to patch! Please run setup first.');
  process.exit(1);
}

process.exit(0);
