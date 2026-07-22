const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const LAMPA_DIR = path.join(PROJECT_DIR, 'lampa');

console.log('Setting up Lampa client files...');

if (fs.existsSync(LAMPA_DIR)) {
  console.log('Lampa directory already exists. Updating via git pull...');
  try {
    execSync('git pull', { cwd: LAMPA_DIR, stdio: 'inherit' });
    console.log('Lampa files updated successfully.');
  } catch (err) {
    console.error('Failed to update Lampa files via git pull:', err.message);
    console.log('Re-cloning repository...');
    fs.rmSync(LAMPA_DIR, { recursive: true, force: true });
    cloneRepo();
  }
} else {
  cloneRepo();
}

function cloneRepo() {
  try {
    console.log('Cloning yumata/lampa repository...');
    execSync('git clone --depth 1 https://github.com/yumata/lampa.git lampa', {
      cwd: PROJECT_DIR,
      stdio: 'inherit'
    });
    console.log('Lampa repository cloned successfully.');
  } catch (err) {
    console.error('Failed to clone Lampa repository:', err.message);
    process.exit(1);
  }
}

// Ensure the local start.json is configured properly if needed
// Media Station X uses start.json, but for our Electron app we will load index.html directly.
process.exit(0);
