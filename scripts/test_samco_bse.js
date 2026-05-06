const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TMP_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Try various BSE F&O path patterns on Samco for April 30
const date = '2026-04-30';
const yyyymmdd = '20260430';

const candidates = [
  `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${date}/${yyyymmdd}_BSE.csv`,
  `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${date}/${yyyymmdd}_BSEFO.csv`,
  `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${date}/${yyyymmdd}_BFO.csv`,
  `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${date}/${yyyymmdd}_BSE_FO.csv`,
  `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${date}/${yyyymmdd}_BSEFNO.csv`,
  `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${date}/${yyyymmdd}_BSE_FNO.csv`,
  `/var/www/html/samco/public_html/Downloads/bhavcopy_data/${date}/${yyyymmdd}_SENSEX.csv`,
];

for (const filePath of candidates) {
  const b64 = Buffer.from(filePath).toString('base64').replace(/=+$/, '');
  const dataUrl = `https://www.samco.in/bse_nse_mcx/datacopy/${b64}`;
  const outPath = path.join(TMP_DIR, `test_${path.basename(filePath)}`);

  const psScript = path.join(TMP_DIR, `test_dl_${Date.now()}.ps1`);
  const ps = `$session = $null
$null = Invoke-WebRequest -Uri "https://www.samco.in/bhavcopy-nse-bse-mcx" -SessionVariable session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -TimeoutSec 15
Invoke-WebRequest -Uri "${dataUrl}" -WebSession $session -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -OutFile "${outPath}" -TimeoutSec 30`;

  fs.writeFileSync(psScript, ps, 'utf8');
  try {
    execSync(`pwsh -ExecutionPolicy Bypass -File "${psScript}"`, { stdio: 'pipe', timeout: 60000 });
  } catch(_) {}
  try { fs.unlinkSync(psScript); } catch(_) {}

  if (fs.existsSync(outPath)) {
    const stat = fs.statSync(outPath);
    const preview = fs.readFileSync(outPath, 'utf8').substring(0, 120);
    const isHtml = preview.startsWith('<!') || preview.startsWith('<html');
    console.log(`${path.basename(filePath)}: ${stat.size}B ${isHtml ? '❌ HTML' : '✅ CSV'} → ${preview.substring(0, 80)}`);
    fs.unlinkSync(outPath);
  } else {
    console.log(`${path.basename(filePath)}: ❌ No file downloaded`);
  }
}
