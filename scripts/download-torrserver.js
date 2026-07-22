const fs = require('fs');
const path = require('path');
const https = require('https');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const DEST_FILE = path.join(BIN_DIR, 'TorrServer-linux-amd64');
const DOWNLOAD_URL = 'https://github.com/YouROK/TorrServer/releases/latest/download/TorrServer-linux-amd64';

// Ensure bin directory exists
if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

function downloadFile(url, dest) {
  console.log(`Starting download from: ${url}`);
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Handle redirects
      if (res.statusCode === 302 || res.statusCode === 301) {
        console.log(`Redirecting to: ${res.headers.location}`);
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Server returned status code ${res.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(dest);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          console.log(`Successfully downloaded TorrServer to: ${dest}`);
          // Set executable permissions (chmod +x)
          try {
            fs.chmodSync(dest, 0o755);
            console.log('Set executable permissions for TorrServer binary');
          } catch (err) {
            console.error('Failed to set executable permissions:', err.message);
          }
          resolve();
        });
      });

      fileStream.on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
    }).on('error', reject);
  });
}

console.log('Preparing TorrServer binary...');
downloadFile(DOWNLOAD_URL, DEST_FILE)
  .then(() => {
    console.log('TorrServer download complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error downloading TorrServer:', err.message);
    process.exit(1);
  });
