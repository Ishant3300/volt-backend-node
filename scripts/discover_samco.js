const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TMP_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const discoveryOut = path.join(TMP_DIR, 'samco_all_links.txt');
const psFile = path.join(TMP_DIR, 'discover.ps1');

const ps = `$session = $null
$page = Invoke-WebRequest -Uri "https://www.samco.in/bhavcopy-nse-bse-mcx" -SessionVariable session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -TimeoutSec 15
$allLinks = ($page.Links | Select-Object -ExpandProperty href)
$allLinks | Out-File -FilePath "${discoveryOut}" -Encoding UTF8`;

fs.writeFileSync(psFile, ps, 'utf8');

try {
  execSync(`pwsh -ExecutionPolicy Bypass -File "${psFile}"`, { stdio: 'pipe', timeout: 30000 });
} catch(e) {
  console.log('pwsh error:', e.message ? e.message.substring(0, 100) : 'unknown');
}

if (fs.existsSync(discoveryOut)) {
  const links = fs.readFileSync(discoveryOut, 'utf8');
  const datacopy = links.split('\n').filter(l => l.includes('datacopy'));
  console.log(`All datacopy links (${datacopy.length}):`);
  datacopy.forEach(l => {
    const trimmed = l.trim();
    const idx = trimmed.indexOf('/datacopy/');
    if (idx >= 0) {
      const b64Part = trimmed.substring(idx + '/datacopy/'.length);
      try {
        const decoded = Buffer.from(b64Part, 'base64').toString('utf8');
        console.log('  ' + decoded);
      } catch(_) {
        console.log('  [raw] ' + trimmed);
      }
    }
  });
} else {
  console.log('No output file found');
}

try { fs.unlinkSync(psFile); } catch(_) {}
try { fs.unlinkSync(discoveryOut); } catch(_) {}
